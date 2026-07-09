#!/usr/bin/env bash
set -euo pipefail

LOCK_FILE=/run/lock/cal1card-sync.lock
APP_ROOT=/opt/cal1card
ENV_FILE=/etc/cal1card/cal1card.env

exec /usr/bin/flock -n "$LOCK_FILE" \
  /usr/sbin/runuser -u www -- /bin/bash -lc \
  "set -a; source '$ENV_FILE'; set +a; cd '$APP_ROOT'; exec /usr/bin/node scripts/sync-cal1card.js"
