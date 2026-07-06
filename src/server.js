import express from "express";
import { request as playwrightRequest } from "playwright";
import { load } from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const publicDir = path.join(appRoot, "public");
const dataDir = path.join(appRoot, "data");
const encryptedStorageStatePath = path.join(dataDir, "cal1card-storage-state.enc.json");
const generatedSecretPath = path.join(dataDir, "server-secret.key");

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const APP_PASSWORD = process.env.CAL1CARD_APP_PASSWORD ?? "cal1card-dev";
const BASE_URL = "https://c1capps.sait-west.berkeley.edu";
const BALANCE_PATH = "/App/CalDining/ViewBalance";
const TRANSACTION_PATH = "/App/CalDining/ViewTransactions";
const LOGIN_HINT_URL = `${BASE_URL}${BALANCE_PATH}`;
const SESSION_COOKIE_NAME = "cal1card_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const BIND_TOKEN_TTL_MS = 10 * 60 * 1000;
const PLAN_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

let lastSnapshot = null;
const sessions = new Map();
const bindTokens = new Map();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

if (!process.env.CAL1CARD_APP_PASSWORD) {
  console.warn("WARNING: CAL1CARD_APP_PASSWORD 未设置，当前使用开发密码 cal1card-dev。部署服务器前必须修改。");
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function maskAccountNumber(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return "";
  }

  const visibleTail = text.slice(-4);
  return `${"*".repeat(Math.max(text.length - 4, 0))}${visibleTail}`;
}

function buildCal1CardUrl(pathname, searchParams = undefined) {
  const url = new URL(pathname, BASE_URL);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

function isAuthUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === "auth.berkeley.edu" || parsedUrl.pathname.includes("/cas/");
  } catch {
    return false;
  }
}

function createNeedsBindingResponse(reason, currentUrl = "") {
  return {
    ok: false,
    needsBinding: true,
    reason,
    currentUrl,
    loginUrl: LOGIN_HINT_URL,
  };
}

function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of String(cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName) {
      continue;
    }

    cookies.set(rawName, decodeURIComponent(rawValueParts.join("=")));
  }

  return cookies;
}

function shouldUseSecureCookie(request) {
  return request.secure || request.headers["x-forwarded-proto"] === "https";
}

function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (options.maxAgeSeconds) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function getSessionToken(request) {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME) ?? "";
}

function getActiveSession(request) {
  const token = getSessionToken(request);
  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  const ageMs = Date.now() - session.createdAt;
  if (ageMs > SESSION_MAX_AGE_SECONDS * 1000) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function requireAppAuth(request, response, next) {
  const session = getActiveSession(request);
  if (!session) {
    response.status(401).json({
      ok: false,
      needsAppLogin: true,
      error: "需要先登录你的 Cal1Card 控制台账号",
    });
    return;
  }

  request.appSession = session;
  next();
}

function getEncryptionKey() {
  const envKey = process.env.CAL1CARD_ENCRYPTION_KEY;
  if (envKey) {
    return crypto.createHash("sha256").update(envKey).digest();
  }

  if (existsSync(generatedSecretPath)) {
    return crypto.createHash("sha256").update(readFileSync(generatedSecretPath)).digest();
  }

  const generatedSecret = crypto.randomBytes(32).toString("base64");
  writeFileSync(generatedSecretPath, generatedSecret, { mode: 0o600 });
  return crypto.createHash("sha256").update(generatedSecret).digest();
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    createdAt: new Date().toISOString(),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptJson(encryptedPayload) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(encryptedPayload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encryptedPayload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}

function loadStorageState() {
  if (!existsSync(encryptedStorageStatePath)) {
    return null;
  }

  return decryptJson(JSON.parse(readFileSync(encryptedStorageStatePath, "utf8")));
}

function saveStorageState(storageState, metadata = {}) {
  const payload = {
    storageState,
    metadata: {
      ...metadata,
      savedAt: new Date().toISOString(),
    },
  };

  writeFileSync(encryptedStorageStatePath, JSON.stringify(encryptJson(payload), null, 2), {
    mode: 0o600,
  });
}

function hasBoundStorageState() {
  return existsSync(encryptedStorageStatePath);
}

function cleanupExpiredBindTokens() {
  const now = Date.now();
  for (const [token, value] of bindTokens.entries()) {
    if (value.expiresAt <= now || value.used) {
      bindTokens.delete(token);
    }
  }
}

function validateAndConsumeBindToken(token) {
  cleanupExpiredBindTokens();
  const record = bindTokens.get(token);
  if (!record || record.used || record.expiresAt <= Date.now()) {
    return false;
  }

  record.used = true;
  bindTokens.delete(token);
  return true;
}

function validateStorageStateShape(storageState) {
  return (
    storageState &&
    typeof storageState === "object" &&
    Array.isArray(storageState.cookies) &&
    Array.isArray(storageState.origins)
  );
}

async function fetchHtmlWithBoundSession(pathname, searchParams, requiredSelector) {
  const saved = loadStorageState();
  if (!saved?.storageState || !validateStorageStateShape(saved.storageState)) {
    return createNeedsBindingResponse("还没有绑定 Cal1Card 登录态");
  }

  const url = buildCal1CardUrl(pathname, searchParams);
  const requestContext = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: saved.storageState,
    extraHTTPHeaders: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${BASE_URL}${BALANCE_PATH}`,
      "User-Agent": "Mozilla/5.0",
    },
  });

  try {
    const response = await requestContext.get(`${url.pathname}${url.search}`, {
      timeout: 45000,
    });
    const finalUrl = response.url();
    const html = await response.text();

    if (isAuthUrl(finalUrl)) {
      return createNeedsBindingResponse("已绑定登录态失效，需要重新绑定 Cal1Card", finalUrl);
    }

    if (!response.ok()) {
      return {
        ok: false,
        needsBinding: false,
        error: `Cal1Card 返回 HTTP ${response.status()}`,
        currentUrl: finalUrl,
      };
    }

    const $ = load(html);
    if (!$(requiredSelector).length) {
      return createNeedsBindingResponse(`绑定登录态无法读取目标页面，缺少 ${requiredSelector}`, finalUrl);
    }

    return {
      ok: true,
      needsBinding: false,
      source: "bound-storage-state",
      currentUrl: finalUrl,
      html,
    };
  } finally {
    await requestContext.dispose();
  }
}

function parseBalanceHtml(html, currentUrl) {
  const $ = load(html);
  const getText = (selector) => normalizeWhitespace($(selector).text());
  const accountName = getText("#MainContent_lbAccountName");
  const accountNumber = getText("#MainContent_lbAccountNumber");
  const asOf = getText("#MainContent_lbBalanceAsOf");
  const plans = [];
  const seenPlanCodes = new Set();

  $('a[href*="ViewTransactions"]').each((index, element) => {
    const link = $(element);
    const href = link.attr("href") ?? "";
    const absoluteUrl = new URL(href, currentUrl);
    const planCode = absoluteUrl.searchParams.get("pln") ?? "";

    if (!planCode || seenPlanCodes.has(planCode)) {
      return;
    }

    seenPlanCodes.add(planCode);

    const rowText = normalizeWhitespace(link.closest("tr").text());
    const cleanedText = normalizeWhitespace(rowText.replace(/View Transaction Details/gi, ""));
    const balanceMatch = cleanedText.match(/^(.*?)\s*Balance:\s*([-$\d,]+(?:\.\d{2})?)/i);

    plans.push({
      planCode,
      name: normalizeWhitespace(balanceMatch?.[1]) || planCode,
      balance: normalizeWhitespace(balanceMatch?.[2]),
      detailsPath: `${absoluteUrl.pathname}${absoluteUrl.search}`,
    });
  });

  return {
    accountName,
    accountNumber,
    asOf,
    plans,
  };
}

function parseTransactionsHtml(html, planCode) {
  const $ = load(html);
  const asOf = normalizeWhitespace($("#MainContent_lbBalanceAsOf").text());
  let table = $("table")
    .filter((index, element) => $(element).attr("id") === `MainContent_gv${planCode}`)
    .first();

  if (!table.length) {
    table = $('table[id^="MainContent_gv"]').first();
  }

  if (!table.length) {
    return {
      asOf,
      headers: [],
      transactions: [],
    };
  }

  const rows = table.find("tr").toArray();
  const headers = $(rows[0])
    .find("th,td")
    .toArray()
    .map((cell) => normalizeWhitespace($(cell).text()));

  const transactions = rows.slice(1)
    .map((row) =>
      $(row)
        .find("td")
        .toArray()
        .map((cell) => normalizeWhitespace($(cell).text())),
    )
    .filter((cells) => cells.length > 0)
    .map((cells) => ({
      posted: cells[0] ?? "",
      amount: cells[1] ?? "",
      balance: cells[2] ?? "",
      location: cells[3] ?? "",
    }));

  return {
    asOf,
    headers,
    transactions,
  };
}

async function fetchBalanceSnapshot() {
  const pageResult = await fetchHtmlWithBoundSession(BALANCE_PATH, undefined, "#MainContent_pnlBalance");

  if (pageResult.needsBinding || !pageResult.ok) {
    return pageResult;
  }

  const balancePage = parseBalanceHtml(pageResult.html, pageResult.currentUrl);

  if (!balancePage.accountName && !balancePage.accountNumber) {
    return createNeedsBindingResponse(
      "Cal1Card 没有返回账户信息，绑定登录态可能已失效",
      pageResult.currentUrl,
    );
  }

  const snapshot = {
    ok: true,
    needsBinding: false,
    source: pageResult.source,
    currentUrl: pageResult.currentUrl,
    fetchedAt: new Date().toISOString(),
    accountName: balancePage.accountName,
    accountNumberMasked: maskAccountNumber(balancePage.accountNumber),
    asOf: balancePage.asOf,
    plans: balancePage.plans,
  };

  lastSnapshot = snapshot;
  return snapshot;
}

async function fetchTransactions(planCode) {
  if (!PLAN_CODE_PATTERN.test(planCode)) {
    return {
      ok: false,
      needsBinding: false,
      error: "非法 planCode",
    };
  }

  const pageResult = await fetchHtmlWithBoundSession(
    TRANSACTION_PATH,
    { pln: planCode },
    'table[id^="MainContent_gv"]',
  );

  if (pageResult.needsBinding || !pageResult.ok) {
    return pageResult;
  }

  const parsed = parseTransactionsHtml(pageResult.html, planCode);
  return {
    ok: true,
    needsBinding: false,
    source: pageResult.source,
    currentUrl: pageResult.currentUrl,
    fetchedAt: new Date().toISOString(),
    planCode,
    asOf: parsed.asOf,
    headers: parsed.headers,
    transactions: parsed.transactions,
  };
}

app.get("/api/auth/me", (request, response) => {
  response.json({
    ok: true,
    authenticated: Boolean(getActiveSession(request)),
    hasBoundStorageState: hasBoundStorageState(),
    lastFetchedAt: lastSnapshot?.fetchedAt ?? null,
  });
});

app.post("/api/auth/login", (request, response) => {
  const password = String(request.body?.password ?? "");
  if (password !== APP_PASSWORD) {
    response.status(401).json({
      ok: false,
      needsAppLogin: true,
      error: "控制台密码不正确",
    });
    return;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, {
    createdAt: Date.now(),
  });

  response.setHeader(
    "Set-Cookie",
    buildCookie(SESSION_COOKIE_NAME, token, {
      maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      secure: shouldUseSecureCookie(request),
    }),
  );
  response.json({
    ok: true,
    authenticated: true,
    hasBoundStorageState: hasBoundStorageState(),
  });
});

app.post("/api/auth/logout", (request, response) => {
  const token = getSessionToken(request);
  if (token) {
    sessions.delete(token);
  }

  response.setHeader(
    "Set-Cookie",
    buildCookie(SESSION_COOKIE_NAME, "", {
      maxAgeSeconds: 0,
      secure: shouldUseSecureCookie(request),
    }),
  );
  response.json({ ok: true });
});

app.get("/api/health", requireAppAuth, (request, response) => {
  response.json({
    ok: true,
    hasBoundStorageState: hasBoundStorageState(),
    hasLastSnapshot: Boolean(lastSnapshot),
    lastFetchedAt: lastSnapshot?.fetchedAt ?? null,
  });
});

app.post("/api/bind-token", requireAppAuth, (request, response) => {
  cleanupExpiredBindTokens();
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + BIND_TOKEN_TTL_MS;
  bindTokens.set(token, {
    expiresAt,
    used: false,
  });

  response.json({
    ok: true,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    bindCommand: `npm run bind -- --server ${request.protocol}://${request.get("host")} --token ${token}`,
  });
});

app.post("/api/bind-storage-state", async (request, response) => {
  const authorization = String(request.headers.authorization ?? "");
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";

  if (!validateAndConsumeBindToken(token)) {
    response.status(401).json({
      ok: false,
      error: "绑定码无效或已过期",
    });
    return;
  }

  const storageState = request.body?.storageState;
  if (!validateStorageStateShape(storageState)) {
    response.status(400).json({
      ok: false,
      error: "storageState 格式不正确",
    });
    return;
  }

  saveStorageState(storageState, {
    accountName: normalizeWhitespace(request.body?.accountName),
    accountNumberMasked: maskAccountNumber(request.body?.accountNumber),
  });

  response.json({
    ok: true,
    hasBoundStorageState: true,
  });
});

app.delete("/api/bind-storage-state", requireAppAuth, (request, response) => {
  if (existsSync(encryptedStorageStatePath)) {
    rmSync(encryptedStorageStatePath);
  }

  lastSnapshot = null;
  response.json({
    ok: true,
    hasBoundStorageState: false,
  });
});

app.post("/api/balance", requireAppAuth, async (request, response) => {
  try {
    const result = await fetchBalanceSnapshot();
    response.status(result.ok ? 200 : result.needsBinding ? 401 : 500).json(result);
  } catch (error) {
    response.status(500).json({
      ok: false,
      needsBinding: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/transactions/:planCode", requireAppAuth, async (request, response) => {
  try {
    const result = await fetchTransactions(request.params.planCode);
    const status = result.ok ? 200 : result.needsBinding ? 401 : 400;
    response.status(status).json(result);
  } catch (error) {
    response.status(500).json({
      ok: false,
      needsBinding: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Cal1Card server listening on http://${HOST}:${PORT}`);
  console.log(`Encrypted storage state: ${encryptedStorageStatePath}`);
});
