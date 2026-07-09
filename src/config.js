import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createConfig(env = process.env, overrides = {}) {
  const appRoot = overrides.appRoot ?? path.resolve(__dirname, "..");
  const dataDir = overrides.dataDir ?? env.CAL1CARD_DATA_DIR ?? path.join(appRoot, "data");

  return {
    appRoot,
    publicDir: path.join(appRoot, "public"),
    dataDir,
    databasePath: overrides.databasePath ?? path.join(dataDir, "cal1card.sqlite"),
    storageStatePath:
      overrides.storageStatePath ?? path.join(dataDir, "cal1card-storage-state.enc.json"),
    generatedSecretPath:
      overrides.generatedSecretPath ?? path.join(dataDir, "server-secret.key"),
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    port: overrides.port ?? parseInteger(env.PORT, 3000),
    appPassword: overrides.appPassword ?? env.CAL1CARD_APP_PASSWORD ?? "cal1card-dev",
    encryptionSecret: overrides.encryptionSecret ?? env.CAL1CARD_ENCRYPTION_KEY ?? "",
    publicOrigin: overrides.publicOrigin ?? env.CAL1CARD_PUBLIC_ORIGIN ?? "",
    trustProxy: overrides.trustProxy ?? parseInteger(env.CAL1CARD_TRUST_PROXY, 1),
    webLoginEnabled:
      overrides.webLoginEnabled ?? parseBoolean(env.CAL1CARD_WEB_LOGIN_ENABLED, false),
    sessionMaxAgeSeconds: overrides.sessionMaxAgeSeconds ?? 7 * 24 * 60 * 60,
    bindTokenTtlMs: overrides.bindTokenTtlMs ?? 10 * 60 * 1000,
    remoteLoginTtlMs: overrides.remoteLoginTtlMs ?? 15 * 60 * 1000,
    baseUrl: "https://c1capps.sait-west.berkeley.edu",
    balancePath: "/App/CalDining/ViewBalance",
    transactionPath: "/App/CalDining/ViewTransactions",
    calnetLoginUrl:
      "https://auth.berkeley.edu/cas/login?service=https://c1capps.sait-west.berkeley.edu/LoginModule/CASC1CHomeLogin",
    allowedCal1CardHost: "c1capps.sait-west.berkeley.edu",
    sessionCookieName: "cal1card_session",
    remoteCookieName: "cal1card_remote_login",
    remoteDisplay: overrides.remoteDisplay ?? parseInteger(env.CAL1CARD_REMOTE_DISPLAY, 99),
    remoteVncPort: overrides.remoteVncPort ?? parseInteger(env.CAL1CARD_REMOTE_VNC_PORT, 5901),
    xvfbBinary: overrides.xvfbBinary ?? env.CAL1CARD_XVFB_BIN ?? "Xvfb",
    x11vncBinary: overrides.x11vncBinary ?? env.CAL1CARD_X11VNC_BIN ?? "x11vnc",
    loginRateLimitMax: overrides.loginRateLimitMax ?? 5,
    loginRateLimitWindowMs: overrides.loginRateLimitWindowMs ?? 15 * 60 * 1000,
  };
}

export { parseBoolean };
