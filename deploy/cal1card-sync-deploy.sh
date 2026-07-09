#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cal1card}"
RUNTIME_DIR="${RUNTIME_DIR:-/var/lib/cal1card}"
ENV_DIR="${ENV_DIR:-/etc/cal1card}"
ENV_FILE="${ENV_FILE:-${ENV_DIR}/cal1card.env}"
SERVICE_FILE="${SERVICE_FILE:-/etc/systemd/system/cal1card.service}"
SERVICE_NAME="${SERVICE_NAME:-cal1card.service}"
REPO_URL="${REPO_URL:-https://github.com/Mike-Zhuang/Cal1Card_TransactionHistory.git}"
BRANCH="${BRANCH:-main}"
REPO_MAIN_REF="${REPO_MAIN_REF:-refs/heads/main}"
LOCK_FILE="${LOCK_FILE:-/run/lock/cal1card-sync-deploy.lock}"
GIT_TIMEOUT_SECONDS="${GIT_TIMEOUT_SECONDS:-60}"
PORT="${PORT:-3101}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://cal1card.mikezhuang.cn}"
NEEDS_RESTART=0
CANDIDATES=(
  "https://gh-proxy.com/https://github.com/Mike-Zhuang/Cal1Card_TransactionHistory.git"
  "https://gitproxy.click/https://github.com/Mike-Zhuang/Cal1Card_TransactionHistory.git"
  "$REPO_URL"
)

log() {
  printf '[%s] [cal1card-deploy] %s\n' "$(date '+%F %T')" "$1"
}

fail() {
  printf '[%s] [cal1card-deploy] ERROR: %s\n' "$(date '+%F %T')" "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "上一次部署仍在运行，本次跳过。"
    exit 0
  fi
}

pick_source() {
  local sourceUrl remoteHash
  for sourceUrl in "${CANDIDATES[@]}"; do
    remoteHash="$(
      timeout "${GIT_TIMEOUT_SECONDS}s" git ls-remote "$sourceUrl" "$REPO_MAIN_REF" 2>/dev/null |
        awk 'NR==1{print $1}'
    )"
    if [[ -n "$remoteHash" ]]; then
      printf '%s|%s' "$sourceUrl" "$remoteHash"
      return 0
    fi
  done
  return 1
}

ensure_env_value() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    NEEDS_RESTART=1
  fi
}

ensure_runtime() {
  install -d -m 700 -o www -g www "$RUNTIME_DIR"
  install -d -m 750 -o root -g www "$ENV_DIR"

  if [[ ! -f "$ENV_FILE" ]]; then
    local appPassword encryptionKey
    appPassword="$(openssl rand -base64 30 | tr -d '\n')"
    encryptionKey="$(openssl rand -base64 48 | tr -d '\n')"
    umask 077
    {
      printf 'HOST=127.0.0.1\n'
      printf 'PORT=%s\n' "$PORT"
      printf 'NODE_ENV=production\n'
      printf 'CAL1CARD_APP_PASSWORD=%s\n' "$appPassword"
      printf 'CAL1CARD_ENCRYPTION_KEY=%s\n' "$encryptionKey"
    } > "$ENV_FILE"
    log "已生成控制台密码和加密密钥。"
    NEEDS_RESTART=1
  fi

  ensure_env_value "CAL1CARD_PUBLIC_ORIGIN" "$PUBLIC_ORIGIN"
  ensure_env_value "CAL1CARD_DATA_DIR" "$RUNTIME_DIR"
  ensure_env_value "CAL1CARD_TRUST_PROXY" "1"
  ensure_env_value "CAL1CARD_WEB_LOGIN_ENABLED" "false"
  ensure_env_value "PLAYWRIGHT_BROWSERS_PATH" "$RUNTIME_DIR/ms-playwright"
  chown root:www "$ENV_FILE"
  chmod 640 "$ENV_FILE"
}

prepare_repo() {
  local picked sourceUrl remoteHash localHash fetchHash
  picked="$(pick_source)" || fail "没有可用的 gh-proxy/GitHub 源，拒绝同步。"
  sourceUrl="${picked%%|*}"
  remoteHash="${picked##*|}"
  log "Git 源：${sourceUrl}"
  log "远端版本：${remoteHash}"

  if [[ -d "${APP_DIR}/.git" ]]; then
    git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true
    git -C "$APP_DIR" remote set-url origin "$sourceUrl"
    localHash="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    git -C "$APP_DIR" reset --hard HEAD >/dev/null
    git -C "$APP_DIR" clean -fd >/dev/null
    timeout "${GIT_TIMEOUT_SECONDS}s" git -C "$APP_DIR" fetch --depth 1 --prune origin "$BRANCH"
    fetchHash="$(git -C "$APP_DIR" rev-parse "origin/${BRANCH}")"
    git -C "$APP_DIR" checkout -B "$BRANCH" "origin/${BRANCH}" --force >/dev/null
    git -C "$APP_DIR" reset --hard "origin/${BRANCH}" >/dev/null
    git -C "$APP_DIR" clean -fd >/dev/null
    if [[ "$localHash" == "$fetchHash" ]]; then
      log "代码已是最新版本：${fetchHash}"
    else
      log "代码已更新：${localHash:-none} -> ${fetchHash}"
      NEEDS_RESTART=1
    fi
  else
    log "首次克隆仓库到：${APP_DIR}"
    rm -rf "$APP_DIR"
    install -d -m 755 "$(dirname "$APP_DIR")"
    timeout "${GIT_TIMEOUT_SECONDS}s" git clone --depth 1 --branch "$BRANCH" "$sourceUrl" "$APP_DIR"
    NEEDS_RESTART=1
  fi

  if [[ ! -L "${APP_DIR}/data" || "$(readlink "${APP_DIR}/data" 2>/dev/null || true)" != "$RUNTIME_DIR" ]]; then
    rm -rf "${APP_DIR}/data"
    ln -s "$RUNTIME_DIR" "${APP_DIR}/data"
  fi
  chown -h www:www "${APP_DIR}/data"
}

install_dependencies() {
  local stateFile currentHash previousHash
  [[ -f "${APP_DIR}/package-lock.json" ]] || fail "缺少 package-lock.json，拒绝部署。"
  [[ -f "${APP_DIR}/src/server.js" ]] || fail "缺少 src/server.js，拒绝部署。"

  stateFile="${RUNTIME_DIR}/package-lock.sha256"
  currentHash="$(sha256sum "${APP_DIR}/package-lock.json" | awk '{print $1}')"
  previousHash="$(cat "$stateFile" 2>/dev/null || true)"
  if [[ ! -d "${APP_DIR}/node_modules" || "$currentHash" != "$previousHash" ]]; then
    log "安装生产依赖。"
    (
      cd "$APP_DIR"
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund
    )
    printf '%s\n' "$currentHash" > "$stateFile"
    chown www:www "$stateFile"
    chmod 600 "$stateFile"
    NEEDS_RESTART=1
  else
    log "依赖无变化，跳过 npm ci。"
  fi

  chown -R root:root "$APP_DIR"
  chown -R www:www "$RUNTIME_DIR"
  chown -h www:www "${APP_DIR}/data"
  chmod -R go+rX "$APP_DIR"
  chmod 700 "$RUNTIME_DIR"
}

ensure_service() {
  if [[ ! -f "${APP_DIR}/deploy/cal1card.service" ]]; then
    fail "缺少 systemd 单元模板。"
  fi
  if [[ ! -f "$SERVICE_FILE" ]] || ! cmp -s "${APP_DIR}/deploy/cal1card.service" "$SERVICE_FILE"; then
    install -m 644 "${APP_DIR}/deploy/cal1card.service" "$SERVICE_FILE"
    systemctl daemon-reload
    NEEDS_RESTART=1
  fi
  systemctl enable "$SERVICE_NAME" >/dev/null
}

restart_and_verify() {
  if ! systemctl is-active --quiet "$SERVICE_NAME" || [[ "$NEEDS_RESTART" == "1" ]]; then
    log "启动或重启 Cal1Card 服务。"
    systemctl restart "$SERVICE_NAME"
  else
    log "服务运行中且无部署变更，跳过重启。"
  fi

  for attempt in {1..20}; do
    if curl --silent --show-error --fail "http://127.0.0.1:${PORT}/api/auth/me" >/dev/null; then
      log "本机健康检查通过。"
      return
    fi
    sleep 1
  done
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  fail "Cal1Card 健康检查失败。"
}

main() {
  local startedAt duration
  startedAt="$(date +%s)"
  for command in git npm node flock openssl curl; do
    require_command "$command"
  done
  acquire_lock
  ensure_runtime
  prepare_repo
  install_dependencies
  ensure_service
  restart_and_verify
  duration=$(( $(date +%s) - startedAt ))
  log "部署任务结束，耗时 ${duration}s。"
}

main "$@"
