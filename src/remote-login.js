import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

import { chromium } from "playwright";
import { WebSocket, WebSocketServer } from "ws";

import { safeEqualText } from "./crypto-store.js";
import { parseCookies } from "./auth.js";
import { filterCal1CardStorageState } from "./storage-state-store.js";

const TERMINAL_STATUSES = new Set(["bound", "failed", "expired", "cancelled"]);

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
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/https?:\/\/\S+/g, "远程页面").slice(0, 240);
  }

  assertActive(session) {
    if (session !== this.activeSession || TERMINAL_STATUSES.has(session.status)) {
      throw sessionEndedError();
    }
  }

  async startSession(session) {
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
    session.resources.page = await context.newPage();
    await session.resources.page.goto(this.config.calnetLoginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
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
