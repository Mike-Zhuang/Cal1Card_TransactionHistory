import assert from "node:assert/strict";
import test from "node:test";

import { RemoteLoginManager } from "../src/remote-login.js";

const baseConfig = {
  webLoginEnabled: true,
  remoteLoginTtlMs: 1_000,
  remoteDisplay: 99,
  remoteVncPort: 5901,
  xvfbBinary: "Xvfb",
  x11vncBinary: "x11vnc",
  calnetLoginUrl: "https://auth.berkeley.edu/cas/login",
  allowedCal1CardHost: "c1capps.sait-west.berkeley.edu",
  baseUrl: "https://c1capps.sait-west.berkeley.edu",
  balancePath: "/App/CalDining/ViewBalance",
};

function waitFor(check, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("等待条件超时"));
      }
    }, 5);
  });
}

test("网页登录关闭时拒绝创建远程会话", async () => {
  const manager = new RemoteLoginManager({
    config: { ...baseConfig, webLoginEnabled: false },
    storageStateStore: {},
    cal1cardClient: {},
    syncService: {},
  });
  await assert.rejects(() => manager.createSession(), { code: "WEB_LOGIN_DISABLED" });
});

test("模拟 CalNet/Duo 完成后过滤状态、持久化、同步并回收进程", async () => {
  let displayChecks = 0;
  let portChecks = 0;
  const spawned = [];
  const terminated = [];
  const saved = [];
  let contextClosed = false;
  let browserClosed = false;
  let syncCount = 0;
  let currentUrl = baseConfig.calnetLoginUrl;
  const rawStorageState = {
    cookies: [
      { name: ".C1CAuth", domain: baseConfig.allowedCal1CardHost, value: "keep" },
      { name: "TGC", domain: "auth.berkeley.edu", value: "drop" },
    ],
    origins: [{ origin: "https://auth.berkeley.edu", localStorage: [] }],
  };
  const page = {
    async goto(url, options) {
      assert.equal(options.waitUntil, "commit");
      currentUrl = url.includes("auth.berkeley.edu")
        ? `${baseConfig.baseUrl}${baseConfig.balancePath}`
        : url;
    },
    url: () => currentUrl,
    waitForSelector: async () => {},
  };
  const context = {
    newPage: async () => page,
    storageState: async () => rawStorageState,
    close: async () => {
      contextClosed = true;
    },
  };
  const browser = {
    newContext: async () => context,
    close: async () => {
      browserClosed = true;
    },
  };
  const manager = new RemoteLoginManager({
    config: baseConfig,
    storageStateStore: {
      save(storageState, metadata) {
        saved.push({ storageState, metadata });
      },
    },
    cal1cardClient: {
      verifyStorageState: async () => ({ accountName: "Test", accountNumberMasked: "***1234" }),
    },
    syncService: {
      async sync() {
        syncCount += 1;
      },
    },
    chromiumLauncher: { launch: async () => browser },
    processSpawner(binary) {
      const child = { binary, startupError: null };
      spawned.push(child);
      return child;
    },
    fileExists: () => {
      displayChecks += 1;
      return displayChecks > 1;
    },
    portProbe: async () => {
      portChecks += 1;
      return portChecks > 1;
    },
    childTerminator: async (child) => {
      if (child) terminated.push(child.binary);
    },
    monitorIntervalMs: 5,
  });

  const created = await manager.createSession();
  assert.equal(created.session.status, "starting");
  assert.equal(JSON.stringify(created.session).includes(created.streamToken), false);
  await waitFor(() => manager.getSession(created.session.sessionId)?.status === "bound");

  assert.deepEqual(spawned.map((child) => child.binary), ["Xvfb", "x11vnc"]);
  assert.deepEqual(terminated.sort(), ["Xvfb", "x11vnc"].sort());
  assert.equal(contextClosed, true);
  assert.equal(browserClosed, true);
  assert.equal(syncCount, 1);
  assert.deepEqual(saved[0].storageState.cookies.map((cookie) => cookie.name), [".C1CAuth"]);
  assert.equal(saved[0].metadata.source, "remote-browser");
  assert.equal(manager.authorizeStream(created.session.sessionId, created.streamToken), false);
});

test("重复会话被拒绝，取消后资源完成回收才能创建下一轮", async () => {
  let cleanupCount = 0;
  const manager = new RemoteLoginManager({
    config: baseConfig,
    storageStateStore: {},
    cal1cardClient: {},
    syncService: {},
  });
  manager.startSession = async (session) => {
    session.status = "awaiting_input";
    session.message = "等待输入";
  };
  manager.cleanupResources = async () => {
    cleanupCount += 1;
  };

  const first = await manager.createSession();
  await assert.rejects(() => manager.createSession(), { code: "REMOTE_LOGIN_BUSY" });
  const cancelled = await manager.cancelSession(first.session.sessionId);
  assert.equal(cancelled.status, "cancelled");
  const second = await manager.createSession();
  assert.notEqual(second.session.sessionId, first.session.sessionId);
  assert.equal(cleanupCount, 1);
  await manager.cancelSession(second.session.sessionId);
});

test("远程会话到期后自动标记 expired 并回收", async () => {
  const manager = new RemoteLoginManager({
    config: { ...baseConfig, remoteLoginTtlMs: 25 },
    storageStateStore: {},
    cal1cardClient: {},
    syncService: {},
  });
  let cleaned = false;
  manager.startSession = async (session) => {
    session.status = "awaiting_input";
  };
  manager.cleanupResources = async () => {
    cleaned = true;
  };
  const created = await manager.createSession();
  await waitFor(() => manager.getSession(created.session.sessionId)?.status === "expired");
  assert.equal(cleaned, true);
});

test("浏览器仍在启动时取消，不会在清理后重新挂起 Chromium", async () => {
  let resolveBrowser;
  let launchStarted = false;
  let browserClosed = false;
  let displayChecks = 0;
  let portChecks = 0;
  const launchPromise = new Promise((resolve) => {
    resolveBrowser = resolve;
  });
  const manager = new RemoteLoginManager({
    config: baseConfig,
    storageStateStore: {},
    cal1cardClient: {},
    syncService: {},
    processSpawner: () => ({ startupError: null }),
    fileExists: () => {
      displayChecks += 1;
      return displayChecks > 1;
    },
    portProbe: async () => {
      portChecks += 1;
      return portChecks > 1;
    },
    childTerminator: async () => {},
    chromiumLauncher: {
      launch() {
        launchStarted = true;
        return launchPromise;
      },
    },
  });

  const created = await manager.createSession();
  await waitFor(() => launchStarted);
  await manager.cancelSession(created.session.sessionId);
  resolveBrowser({
    close: async () => {
      browserClosed = true;
    },
  });
  await waitFor(() => browserClosed);
  assert.equal(manager.getSession(created.session.sessionId).status, "cancelled");
});
