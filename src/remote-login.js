import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

import { load } from "cheerio";
import { chromium, request as playwrightRequest } from "playwright";
import { WebSocket, WebSocketServer } from "ws";

import { safeEqualText } from "./crypto-store.js";
import { parseCookies } from "./auth.js";
import { filterCal1CardStorageState } from "./storage-state-store.js";

const TERMINAL_STATUSES = new Set(["bound", "failed", "expired", "cancelled"]);
const MAX_LOGIN_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_LOGIN_RESOURCES = 32;
const LOGIN_RESOURCE_TIMEOUT_MS = 45_000;
const LOGIN_RESOURCE_ATTEMPTS = 2;
const FORWARDED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-security-policy",
  "content-type",
  "referrer-policy",
  "x-content-type-options",
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sessionEndedError() {
  const error = new Error("远程登录会话已经结束");
  error.code = "REMOTE_SESSION_ENDED";
  return error;
}

async function waitForCondition(check, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await sleep(75);
  }
  throw new Error(errorMessage);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function spawnManaged(binary, args) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  child.startupError = null;
  child.once("error", (error) => {
    child.startupError = error;
  });
  return child;
}

function filteredResponseHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())),
  );
}

function assertOfficialCalNetUrl(url, expectedOrigin) {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.origin !== expectedOrigin ||
    !parsedUrl.pathname.startsWith("/cas/")
  ) {
    throw new Error("CalNet 登录页跳转到了非预期地址");
  }
  return parsedUrl;
}

async function fetchLoginResource(apiContext, url, expectedOrigin) {
  const response = await apiContext.get(url, {
    failOnStatusCode: false,
    timeout: LOGIN_RESOURCE_TIMEOUT_MS,
  });
  const responseUrl = assertOfficialCalNetUrl(response.url(), expectedOrigin).toString();
  if (!response.ok()) {
    throw new Error(`CalNet 登录资源返回异常状态 ${response.status()}`);
  }
  const body = await response.body();
  if (body.length > MAX_LOGIN_RESOURCE_BYTES) {
    throw new Error("CalNet 登录资源超过安全大小限制");
  }
  return {
    requestUrl: url,
    responseUrl,
    status: response.status(),
    headers: filteredResponseHeaders(response.headers()),
    body,
  };
}

function isRetryableLoginResourceError(error) {
  return (
    error?.name === "TimeoutError" ||
    /ECONNRESET|ETIMEDOUT|socket hang up|connection reset/i.test(error?.message ?? "")
  );
}

async function fetchLoginResourceInFreshContext(apiRequestFactory, url, expectedOrigin) {
  let lastError;
  for (let attempt = 1; attempt <= LOGIN_RESOURCE_ATTEMPTS; attempt += 1) {
    const apiContext = await apiRequestFactory.newContext({ locale: "en-US" });
    try {
      return {
        apiContext,
        resource: await fetchLoginResource(apiContext, url, expectedOrigin),
      };
    } catch (error) {
      lastError = error;
      await apiContext.dispose();
      if (attempt === LOGIN_RESOURCE_ATTEMPTS || !isRetryableLoginResourceError(error)) {
        throw error;
      }
      await sleep(250);
    }
  }
  throw lastError;
}

export async function loadOfficialLoginPage({
  loginUrl,
  apiRequestFactory = playwrightRequest,
}) {
  const parsedLoginUrl = new URL(loginUrl);
  assertOfficialCalNetUrl(parsedLoginUrl, parsedLoginUrl.origin);
  const documentLoad = await fetchLoginResourceInFreshContext(
    apiRequestFactory,
    parsedLoginUrl.toString(),
    parsedLoginUrl.origin,
  );
  const apiContext = documentLoad.apiContext;
  try {
    const documentResource = documentLoad.resource;
    const html = documentResource.body.toString("utf8");
    const document = load(html);
    if (document("#username").length === 0) {
      throw new Error("CalNet 登录页缺少账户输入框");
    }

    const assetUrls = new Set();
    document("link[href], script[src], img[src]").each((_, element) => {
      const rawUrl = document(element).attr("href") ?? document(element).attr("src");
      if (!rawUrl) {
        return;
      }
      const assetUrl = new URL(rawUrl, documentResource.responseUrl);
      if (
        assetUrl.protocol === "https:" &&
        assetUrl.origin === parsedLoginUrl.origin &&
        assetUrl.pathname.startsWith("/cas/")
      ) {
        assetUrls.add(assetUrl.toString());
      }
    });
    if (assetUrls.size > MAX_LOGIN_RESOURCES) {
      throw new Error("CalNet 登录页资源数量超过安全限制");
    }

    const assetResources = await Promise.all(
      [...assetUrls].map(async (url) => {
        const loaded = await fetchLoginResourceInFreshContext(
          apiRequestFactory,
          url,
          parsedLoginUrl.origin,
        );
        try {
          return loaded.resource;
        } finally {
          await loaded.apiContext.dispose();
        }
      }),
    );
    const resources = new Map();
    for (const resource of [documentResource, ...assetResources]) {
      resources.set(resource.requestUrl, resource);
      resources.set(resource.responseUrl, resource);
    }

    return {
      resources,
      routePattern: `${parsedLoginUrl.origin}/cas/**`,
      storageState: await apiContext.storageState(),
    };
  } finally {
    await apiContext.dispose();
  }
}

export function createOfficialGetCacheHandler(resources) {
  return async (route) => {
    const request = route.request();
    const resource = request.method() === "GET" ? resources.get(request.url()) : null;
    if (!resource) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: resource.status,
      headers: resource.headers,
      body: resource.body,
    });
  };
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(1_500),
  ]);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
  }
}

function publicSession(session) {
  if (!session) {
    return null;
  }
  return {
    sessionId: session.sessionId,
    status: session.status,
    message: session.message,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    boundAt: session.boundAt ?? null,
    streamReady: Boolean(session.vncReady && !TERMINAL_STATUSES.has(session.status)),
  };
}

export class RemoteLoginManager {
  constructor({
    config,
    storageStateStore,
    cal1cardClient,
    syncService,
    chromiumLauncher = chromium,
    processSpawner = spawnManaged,
    fileExists = existsSync,
    portProbe = isPortOpen,
    childTerminator = terminateChild,
    loginPageLoader = loadOfficialLoginPage,
    monitorIntervalMs = 1_000,
    now = () => Date.now(),
  }) {
    this.config = config;
    this.storageStateStore = storageStateStore;
    this.cal1cardClient = cal1cardClient;
    this.syncService = syncService;
    this.chromiumLauncher = chromiumLauncher;
    this.processSpawner = processSpawner;
    this.fileExists = fileExists;
    this.portProbe = portProbe;
    this.childTerminator = childTerminator;
    this.loginPageLoader = loginPageLoader;
    this.monitorIntervalMs = monitorIntervalMs;
    this.now = now;
    this.activeSession = null;
  }

  async createSession() {
    if (!this.config.webLoginEnabled) {
      const error = new Error("网页 CalNet 登录尚未启用");
      error.code = "WEB_LOGIN_DISABLED";
      throw error;
    }
    if (this.activeSession) {
      if (!TERMINAL_STATUSES.has(this.activeSession.status)) {
        const error = new Error("已有一个 CalNet 登录会话正在进行");
        error.code = "REMOTE_LOGIN_BUSY";
        error.session = publicSession(this.activeSession);
        throw error;
      }
      await this.activeSession.cleanupPromise;
    }

    const createdAtMs = this.now();
    const session = {
      sessionId: crypto.randomBytes(24).toString("base64url"),
      streamToken: crypto.randomBytes(32).toString("base64url"),
      status: "starting",
      message: "正在启动安全登录环境",
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.config.remoteLoginTtlMs).toISOString(),
      vncReady: false,
      checking: false,
      resources: {},
      cleanupPromise: null,
    };
    this.activeSession = session;
    session.expiryTimer = setTimeout(() => {
      this.finishSession(session, "expired", "登录会话已超时").catch(() => {});
    }, this.config.remoteLoginTtlMs);
    this.startSession(session).catch((error) => {
      this.finishSession(session, "failed", this.safeErrorMessage(error)).catch(() => {});
    });
    return { session: publicSession(session), streamToken: session.streamToken };
  }

  safeErrorMessage(error) {
    if (error?.code === "ENOENT") {
      return "服务器缺少远程浏览器运行组件";
    }
    if (error?.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(error?.message ?? "")) {
      return "CalNet 页面加载超时，请重试";
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/https?:\/\/\S+/g, "远程页面").slice(0, 240);
  }

  assertActive(session) {
    if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
      throw sessionEndedError();
    }
  }

  async startSession(session) {
    session.message = "正在安全加载 CalNet 登录页";
    const loginPage = await this.loginPageLoader({ loginUrl: this.config.calnetLoginUrl });
    this.assertActive(session);

    const displaySocket = `/tmp/.X11-unix/X${this.config.remoteDisplay}`;
    if (this.fileExists(displaySocket)) {
      throw new Error("远程显示编号被占用");
    }
    if (await this.portProbe(this.config.remoteVncPort)) {
      throw new Error("远程显示端口被占用");
    }

    const display = `:${this.config.remoteDisplay}`;
    session.resources.xvfb = this.processSpawner(this.config.xvfbBinary, [
      display,
      "-screen",
      "0",
      "1280x820x24",
      "-nolisten",
      "tcp",
      "-ac",
    ]);
    await waitForCondition(
      () => {
        if (session.resources.xvfb.startupError) {
          throw session.resources.xvfb.startupError;
        }
        return this.fileExists(displaySocket);
      },
      5_000,
      "远程显示服务启动超时",
    );
    this.assertActive(session);

    session.resources.vnc = this.processSpawner(this.config.x11vncBinary, [
      "-display",
      display,
      "-rfbport",
      String(this.config.remoteVncPort),
      "-localhost",
      "-forever",
      "-shared",
      "-nopw",
      "-nosel",
      "-quiet",
    ]);
    await waitForCondition(
      async () => {
        if (session.resources.vnc.startupError) {
          throw session.resources.vnc.startupError;
        }
        return this.portProbe(this.config.remoteVncPort);
      },
      5_000,
      "远程画面服务启动超时",
    );
    this.assertActive(session);
    session.vncReady = true;

    const browser = await this.chromiumLauncher.launch({
      headless: false,
      env: { ...process.env, DISPLAY: display },
      args: [
        "--window-position=0,0",
        "--window-size=1280,820",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-dev-shm-usage",
        "--disable-sync",
        "--no-default-browser-check",
        "--no-first-run",
      ],
    });
    if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
      await browser.close().catch(() => {});
      throw sessionEndedError();
    }
    session.resources.browser = browser;
    const context = await browser.newContext({
      storageState: loginPage.storageState,
      viewport: { width: 1280, height: 760 },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      serviceWorkers: "block",
    });
    if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
      await context.close().catch(() => {});
      throw sessionEndedError();
    }
    session.resources.context = context;
    const routeHandler = createOfficialGetCacheHandler(loginPage.resources);
    await context.route(loginPage.routePattern, routeHandler);
    session.resources.page = await context.newPage();
    try {
      await session.resources.page.goto(this.config.calnetLoginUrl, {
        waitUntil: "commit",
        timeout: 45_000,
      });
      await session.resources.page.waitForSelector("#username", {
        state: "visible",
        timeout: 20_000,
      });
    } finally {
      await context.unroute(loginPage.routePattern, routeHandler).catch(() => {});
      loginPage.resources.clear();
    }
    this.assertActive(session);
    session.status = "awaiting_input";
    session.message = "请完成 CalNet 和 Duo Push";
    session.checkTimer = setInterval(() => {
      this.checkForSuccess(session).catch((error) => {
        this.finishSession(session, "failed", this.safeErrorMessage(error)).catch(() => {});
      });
    }, this.monitorIntervalMs);
  }

  async checkForSuccess(session) {
    if (
      session !== this.activeSession ||
      session.checking ||
      session.status !== "awaiting_input" ||
      !session.resources.page
    ) {
      return;
    }
    let currentUrl;
    try {
      currentUrl = new URL(session.resources.page.url());
    } catch {
      return;
    }
    if (currentUrl.hostname !== this.config.allowedCal1CardHost) {
      return;
    }

    session.checking = true;
    session.status = "verifying";
    session.message = "正在验证 Cal1Card 登录态";
    try {
      if (currentUrl.pathname !== this.config.balancePath) {
        await session.resources.page.goto(`${this.config.baseUrl}${this.config.balancePath}`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
      }
      await session.resources.page.waitForSelector("#MainContent_pnlBalance", { timeout: 20_000 });
      const rawStorageState = await session.resources.context.storageState();
      const storageState = filterCal1CardStorageState(
        rawStorageState,
        this.config.allowedCal1CardHost,
      );
      const snapshot = await this.cal1cardClient.verifyStorageState(storageState);
      if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
        return;
      }
      await this.syncService.sync(storageState);
      if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
        return;
      }
      this.storageStateStore.save(storageState, {
        accountName: snapshot.accountName,
        accountNumberMasked: snapshot.accountNumberMasked,
        source: "remote-browser",
      });
      session.boundAt = new Date().toISOString();
      await this.finishSession(session, "bound", "CalNet 已连接，数据同步完成");
    } catch (error) {
      if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
        return;
      }
      if (error?.needsBinding) {
        session.status = "awaiting_input";
        session.message = "请继续完成 CalNet 和 Duo Push";
      } else {
        throw error;
      }
    } finally {
      session.checking = false;
    }
  }

  getSession(sessionId) {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return null;
    }
    return publicSession(this.activeSession);
  }

  authorizeStream(sessionId, token) {
    const session = this.activeSession;
    return Boolean(
      session &&
        session.sessionId === sessionId &&
        !TERMINAL_STATUSES.has(session.status) &&
        safeEqualText(token, session.streamToken),
    );
  }

  bridgeWebSocket(sessionId, webSocket) {
    const session = this.activeSession;
    if (!session || session.sessionId !== sessionId || !session.vncReady) {
      webSocket.close(1011, "Remote display unavailable");
      return;
    }

    const vncSocket = net.createConnection({
      host: "127.0.0.1",
      port: this.config.remoteVncPort,
    });
    const closeBoth = () => {
      vncSocket.destroy();
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close();
      }
    };
    webSocket.on("message", (data) => vncSocket.write(data));
    webSocket.on("close", () => vncSocket.destroy());
    webSocket.on("error", () => vncSocket.destroy());
    vncSocket.on("data", (data) => {
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(data, { binary: true });
      }
    });
    vncSocket.on("error", closeBoth);
    vncSocket.on("close", () => {
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close();
      }
    });
  }

  async cancelSession(sessionId) {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return null;
    }
    await this.finishSession(this.activeSession, "cancelled", "登录已取消");
    return publicSession(this.activeSession);
  }

  async finishSession(session, status, message) {
    if (TERMINAL_STATUSES.has(session.status) && session.cleanupPromise) {
      return session.cleanupPromise;
    }
    session.status = status;
    session.message = message;
    clearTimeout(session.expiryTimer);
    clearInterval(session.checkTimer);
    session.vncReady = false;
    session.cleanupPromise = this.cleanupResources(session);
    return session.cleanupPromise;
  }

  async cleanupResources(session) {
    try {
      await session.resources.context?.close().catch(() => {});
      await session.resources.browser?.close().catch(() => {});
      await this.childTerminator(session.resources.vnc);
      await this.childTerminator(session.resources.xvfb);
    } finally {
      session.resources = {};
    }
  }

  async shutdown() {
    if (!this.activeSession) {
      return;
    }
    if (!TERMINAL_STATUSES.has(this.activeSession.status)) {
      await this.finishSession(this.activeSession, "cancelled", "服务正在重启");
      return;
    }
    await this.activeSession.cleanupPromise;
  }
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export function attachRemoteLoginWebSocket({ server, manager, appAuth, config }) {
  const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const match = url.pathname.match(/^\/api\/calnet-login-sessions\/([^/]+)\/stream$/);
    if (!match) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    let sessionId;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const appSession = appAuth.getSession(request);
    if (!appSession) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const origin = String(request.headers.origin ?? "");
    const protocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]
      || (request.socket.encrypted ? "https" : "http");
    const expectedOrigin = config.publicOrigin || `${protocol}://${request.headers.host}`;
    if (origin !== expectedOrigin) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const streamToken = parseCookies(request.headers.cookie).get(config.remoteCookieName) ?? "";
    if (!manager.authorizeStream(sessionId, streamToken)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      manager.bridgeWebSocket(sessionId, webSocket);
    });
  });
  return webSocketServer;
}
