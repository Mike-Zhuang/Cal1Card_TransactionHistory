import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

import { AppAuth, buildCookie, shouldUseSecureCookie } from "./auth.js";
import {
  CATEGORY_OPTIONS,
  buildDashboard,
  buildTransactionsCsv,
  filterTransactions,
  validateCategory,
} from "./analytics.js";
import { Cal1CardClient, Cal1CardError } from "./cal1card-client.js";
import { PLAN_CODE_PATTERN } from "./cal1card-parser.js";
import { createConfig } from "./config.js";
import { EncryptedCodec, getOrCreateSecret } from "./crypto-store.js";
import { DataRepository } from "./data-repository.js";
import { RemoteLoginManager, attachRemoteLoginWebSocket } from "./remote-login.js";
import { StorageStateStore, filterCal1CardStorageState } from "./storage-state-store.js";
import { SyncService } from "./sync-service.js";

function getExpectedOrigin(request, publicOrigin) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0];
  const protocol = forwardedProtocol || request.protocol;
  return publicOrigin || `${protocol}://${request.get("host")}`;
}

function getWebSocketOrigin(publicOrigin) {
  try {
    const url = new URL(publicOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.origin;
  } catch {
    return null;
  }
}

function requireSameOrigin(publicOrigin) {
  return (request, response, next) => {
    if (String(request.headers.origin ?? "") !== getExpectedOrigin(request, publicOrigin)) {
      response.status(403).json({ ok: false, error: "请求来源验证失败" });
      return;
    }
    next();
  };
}

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

function createBindTokenStore(ttlMs) {
  const tokens = new Map();
  const cleanup = () => {
    const now = Date.now();
    for (const [token, record] of tokens.entries()) {
      if (record.expiresAt <= now) {
        tokens.delete(token);
      }
    }
  };
  return {
    create() {
      cleanup();
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = Date.now() + ttlMs;
      tokens.set(token, { expiresAt, inUse: false });
      return { token, expiresAt };
    },
    reserve(token) {
      cleanup();
      const record = tokens.get(token);
      if (!record || record.inUse || record.expiresAt <= Date.now()) {
        return false;
      }
      record.inUse = true;
      return true;
    },
    release(token) {
      const record = tokens.get(token);
      if (record) {
        record.inUse = false;
      }
    },
    consume(token) {
      tokens.delete(token);
    },
  };
}

function sendApiError(response, error) {
  if (error instanceof Cal1CardError) {
    response.status(error.status).json({
      ok: false,
      needsBinding: error.needsBinding,
      code: error.code,
      error: error.message,
    });
    return;
  }
  if (error?.code === "REMOTE_LOGIN_BUSY") {
    response.status(409).json({ ok: false, code: error.code, error: error.message, session: error.session });
    return;
  }
  if (error?.code === "WEB_LOGIN_DISABLED") {
    response.status(503).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  console.error(`[API_ERROR] ${error?.name ?? "Error"}: ${String(error?.message ?? error).slice(0, 240)}`);
  response.status(500).json({ ok: false, error: "服务器处理请求失败" });
}

export function createApplication(options = {}) {
  const config = options.config ?? createConfig();
  const secret = options.secret ?? getOrCreateSecret(config);
  const codec = options.codec ?? new EncryptedCodec(secret);
  const storageStateStore =
    options.storageStateStore ??
    new StorageStateStore({
      filePath: config.storageStatePath,
      codec,
      allowedHost: config.allowedCal1CardHost,
    });
  const repository =
    options.repository ?? new DataRepository({ databasePath: config.databasePath, codec });
  const cal1cardClient =
    options.cal1cardClient ?? new Cal1CardClient({ config, storageStateStore });
  const syncService = options.syncService ?? new SyncService({ client: cal1cardClient, repository });
  const appAuth =
    options.appAuth ??
    new AppAuth({
      appPassword: config.appPassword,
      sessionKey: codec.sessionKey,
      cookieName: config.sessionCookieName,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
    });
  const remoteLoginManager =
    options.remoteLoginManager ??
    new RemoteLoginManager({
      config,
      storageStateStore,
      cal1cardClient,
      syncService,
    });

  const app = express();
  const webSocketOrigin = getWebSocketOrigin(config.publicOrigin);
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:"],
          fontSrc: ["'self'"],
          styleSrc: ["'self'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'", ...(webSocketOrigin ? [webSocketOrigin] : [])],
          workerSrc: ["'self'", "blob:"],
          upgradeInsecureRequests: config.publicOrigin.startsWith("https://") ? [] : null,
        },
      },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  const nodeModulesDir = path.join(config.appRoot, "node_modules");
  app.use(
    "/vendor/novnc",
    express.static(path.join(nodeModulesDir, "@novnc", "novnc"), { fallthrough: false }),
  );
  app.get("/vendor/chart/chart.umd.min.js", (request, response) => {
    response.sendFile(path.join(nodeModulesDir, "chart.js", "dist", "chart.umd.min.js"));
  });
  app.get("/vendor/lucide/lucide.min.js", (request, response) => {
    response.sendFile(path.join(nodeModulesDir, "lucide", "dist", "umd", "lucide.min.js"));
  });
  app.use(
    "/vendor/fonts/geist",
    express.static(path.join(nodeModulesDir, "@fontsource-variable", "geist"), { fallthrough: false }),
  );
  app.use(
    "/vendor/fonts/geist-mono",
    express.static(path.join(nodeModulesDir, "@fontsource-variable", "geist-mono"), {
      fallthrough: false,
    }),
  );

  const requireAuth = appAuth.requireAuth();
  const requireMutation = appAuth.requireMutation(config.publicOrigin);
  const bindTokens = createBindTokenStore(config.bindTokenTtlMs);
  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimitWindowMs,
    limit: config.loginRateLimitMax,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { ok: false, error: "登录尝试过多，请稍后再试" },
  });

  app.get("/api/auth/me", (request, response) => {
    const session = appAuth.getSession(request);
    if (!session) {
      response.json({ ok: true, authenticated: false });
      return;
    }
    response.json({
      ok: true,
      authenticated: true,
      csrfToken: session.csrfToken,
      hasBoundStorageState: storageStateStore.has(),
      syncState: repository.getSyncState(),
      webLoginEnabled: config.webLoginEnabled,
    });
  });

  app.post(
    "/api/auth/login",
    requireSameOrigin(config.publicOrigin),
    loginLimiter,
    (request, response) => {
      if (!appAuth.authenticatePassword(String(request.body?.password ?? "").slice(0, 1024))) {
        response.status(401).json({ ok: false, needsAppLogin: true, error: "控制台密码不正确" });
        return;
      }
      const token = appAuth.createSessionToken();
      const session = appAuth.verifySessionToken(token);
      appAuth.setSessionCookie(request, response, token);
      response.json({
        ok: true,
        authenticated: true,
        csrfToken: session.csrfToken,
        hasBoundStorageState: storageStateStore.has(),
        webLoginEnabled: config.webLoginEnabled,
      });
    },
  );

  app.post("/api/auth/logout", requireMutation, (request, response) => {
    appAuth.clearSessionCookie(request, response);
    response.json({ ok: true });
  });

  app.get("/api/health", requireAuth, (request, response) => {
    response.json({
      ok: true,
      hasBoundStorageState: storageStateStore.has(),
      hasSnapshot: Boolean(repository.getLatestSnapshot()),
      syncState: repository.getSyncState(),
      webLoginEnabled: config.webLoginEnabled,
    });
  });

  app.post("/api/calnet-login-sessions", requireMutation, async (request, response) => {
    try {
      const { session, streamToken } = await remoteLoginManager.createSession();
      const streamPath = `/api/calnet-login-sessions/${encodeURIComponent(session.sessionId)}/stream`;
      response.setHeader(
        "Set-Cookie",
        buildCookie(config.remoteCookieName, streamToken, {
          path: streamPath,
          maxAgeSeconds: Math.ceil(config.remoteLoginTtlMs / 1000),
          secure: shouldUseSecureCookie(request),
        }),
      );
      response.status(202).json({ ok: true, session: { ...session, streamPath } });
    } catch (error) {
      sendApiError(response, error);
    }
  });

  app.get("/api/calnet-login-sessions/:sessionId", requireAuth, (request, response) => {
    const session = remoteLoginManager.getSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ ok: false, error: "登录会话不存在" });
      return;
    }
    response.json({ ok: true, session });
  });

  app.delete("/api/calnet-login-sessions/:sessionId", requireMutation, async (request, response) => {
    const session = await remoteLoginManager.cancelSession(request.params.sessionId);
    if (!session) {
      response.status(404).json({ ok: false, error: "登录会话不存在" });
      return;
    }
    response.setHeader(
      "Set-Cookie",
      buildCookie(config.remoteCookieName, "", {
        path: `/api/calnet-login-sessions/${encodeURIComponent(session.sessionId)}/stream`,
        maxAgeSeconds: 0,
        secure: shouldUseSecureCookie(request),
      }),
    );
    response.json({ ok: true, session });
  });

  app.post("/api/sync", requireMutation, async (request, response) => {
    try {
      const result = await syncService.sync();
      response.json({
        ok: true,
        insertedCount: result.insertedCount,
        totalCount: result.totalCount,
        capturedAt: result.capturedAt,
      });
    } catch (error) {
      sendApiError(response, error);
    }
  });

  app.get("/api/dashboard", requireAuth, (request, response) => {
    const snapshot = repository.getLatestSnapshot();
    const transactions = repository.getTransactions();
    const budgets = repository.getBudgets();
    const dashboard = buildDashboard({
      snapshot,
      transactions,
      budgets,
      range: request.query.range,
      planCode: request.query.planCode,
    });
    response.json({
      ok: true,
      ready: Boolean(snapshot),
      hasBoundStorageState: storageStateStore.has(),
      syncState: repository.getSyncState(),
      categories: CATEGORY_OPTIONS,
      ...dashboard,
    });
  });

  app.get("/api/transactions", requireAuth, (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1, 100_000);
    const limit = parsePositiveInteger(request.query.limit, 25, 100);
    const filtered = filterTransactions(repository.getTransactions(), {
      range: request.query.range,
      planCode: request.query.planCode,
      category: request.query.category,
      query: request.query.query,
    });
    const offset = (page - 1) * limit;
    response.json({
      ok: true,
      page,
      limit,
      total: filtered.length,
      totalPages: Math.max(Math.ceil(filtered.length / limit), 1),
      transactions: filtered.slice(offset, offset + limit),
    });
  });

  app.get("/api/export.csv", requireAuth, (request, response) => {
    const filtered = filterTransactions(repository.getTransactions(), {
      range: request.query.range,
      planCode: request.query.planCode,
      category: request.query.category,
      query: request.query.query,
    });
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", 'attachment; filename="cal1card-transactions.csv"');
    response.send(buildTransactionsCsv(filtered));
  });

  app.put("/api/category-rules", requireMutation, (request, response) => {
    const location = String(request.body?.location ?? "");
    const category = String(request.body?.category ?? "");
    if (!validateCategory(category)) {
      response.status(400).json({ ok: false, error: "无效的消费分类" });
      return;
    }
    if (location.length > 500) {
      response.status(400).json({ ok: false, error: "地点名称过长" });
      return;
    }
    try {
      response.json({ ok: true, rule: repository.setCategoryRule(location, category) });
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/category-rules", requireMutation, (request, response) => {
    repository.deleteCategoryRule(String(request.body?.location ?? ""));
    response.json({ ok: true });
  });

  app.put("/api/budgets/:planCode", requireMutation, (request, response) => {
    const { planCode } = request.params;
    if (!PLAN_CODE_PATTERN.test(planCode)) {
      response.status(400).json({ ok: false, error: "非法 planCode" });
      return;
    }
    const plan = repository
      .getLatestSnapshot()
      ?.plans?.find((candidate) => candidate.planCode === planCode);
    if (!plan?.isCurrency) {
      response.status(400).json({ ok: false, error: "该余额类型不支持金额预算" });
      return;
    }
    const rawAmount = request.body?.monthlyAmount;
    const monthlyAmount = rawAmount === null || rawAmount === "" ? null : Number(rawAmount);
    if (monthlyAmount !== null && (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0 || monthlyAmount > 100_000)) {
      response.status(400).json({ ok: false, error: "预算金额必须大于 0 且不超过 100000" });
      return;
    }
    response.json({ ok: true, budget: repository.setBudget(planCode, monthlyAmount) });
  });

  app.delete("/api/data", requireMutation, (request, response) => {
    if (!appAuth.authenticatePassword(String(request.body?.password ?? ""))) {
      response.status(401).json({ ok: false, error: "控制台密码不正确" });
      return;
    }
    repository.clearHistory();
    response.json({ ok: true });
  });

  app.post("/api/bind-token", requireMutation, (request, response) => {
    const created = bindTokens.create();
    const origin = getExpectedOrigin(request, config.publicOrigin);
    response.json({
      ok: true,
      token: created.token,
      expiresAt: new Date(created.expiresAt).toISOString(),
      bindCommand: `npm run bind -- --server ${origin} --token ${created.token}`,
    });
  });

  app.post("/api/bind-storage-state", async (request, response) => {
    const authorization = String(request.headers.authorization ?? "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!bindTokens.reserve(token)) {
      response.status(401).json({ ok: false, error: "绑定码无效或已过期" });
      return;
    }
    try {
      const storageState = filterCal1CardStorageState(
        request.body?.storageState,
        config.allowedCal1CardHost,
      );
      const snapshot = await cal1cardClient.verifyStorageState(storageState);
      storageStateStore.save(storageState, {
        accountName: snapshot.accountName,
        accountNumberMasked: snapshot.accountNumberMasked,
        source: "local-bind-tool",
      });
      const syncResult = await syncService.sync(storageState);
      bindTokens.consume(token);
      response.json({
        ok: true,
        hasBoundStorageState: true,
        capturedAt: syncResult.capturedAt,
      });
    } catch (error) {
      bindTokens.release(token);
      sendApiError(response, error);
    }
  });

  app.delete("/api/bind-storage-state", requireMutation, (request, response) => {
    storageStateStore.delete();
    response.json({ ok: true, hasBoundStorageState: false });
  });

  app.post("/api/balance", requireMutation, async (request, response) => {
    try {
      const result = await syncService.sync();
      response.json(result.snapshot);
    } catch (error) {
      sendApiError(response, error);
    }
  });

  app.get("/api/transactions/:planCode", requireAuth, async (request, response) => {
    try {
      response.json(await cal1cardClient.fetchPlan(request.params.planCode));
    } catch (error) {
      sendApiError(response, error);
    }
  });

  app.use(express.static(config.publicDir, { index: "index.html", maxAge: 0 }));
  app.use("/api", (request, response) => {
    response.status(404).json({ ok: false, error: "接口不存在" });
  });
  app.use((request, response) => {
    response.status(404).sendFile(path.join(config.publicDir, "404.html"));
  });

  const server = http.createServer(app);
  const webSocketServer = attachRemoteLoginWebSocket({
    server,
    manager: remoteLoginManager,
    appAuth,
    config,
  });

  return {
    app,
    server,
    config,
    services: {
      codec,
      storageStateStore,
      repository,
      cal1cardClient,
      syncService,
      appAuth,
      remoteLoginManager,
    },
    async close() {
      await remoteLoginManager.shutdown();
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise((resolve) => webSocketServer.close(() => resolve()));
      repository.close();
    },
  };
}
