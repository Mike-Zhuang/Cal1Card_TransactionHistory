import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { createApplication } from "../src/app.js";
import { createConfig } from "../src/config.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startTestApplication(overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cal1card-app-"));
  const config = createConfig(
    {},
    {
      appRoot,
      dataDir: directory,
      databasePath: path.join(directory, "cal1card.sqlite"),
      storageStatePath: path.join(directory, "storage.enc.json"),
      generatedSecretPath: path.join(directory, "secret.key"),
      host: "127.0.0.1",
      port: 0,
      appPassword: "test-console-password",
      publicOrigin: "",
      webLoginEnabled: false,
      loginRateLimitMax: 3,
      ...overrides,
    },
  );
  const application = createApplication({ config, secret: "test-application-secret" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    application,
    baseUrl,
    directory,
    async close() {
      await new Promise((resolve) => application.server.close(resolve));
      await application.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function jsonRequest(baseUrl, pathname, { method = "GET", cookie, csrfToken, body, origin = baseUrl } = {}) {
  const headers = { Accept: "application/json" };
  if (origin !== null) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(baseUrl, password = "test-console-password") {
  const response = await jsonRequest(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { password },
  });
  const payload = await response.json();
  return {
    response,
    payload,
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

test("API 隐私、会话、CSRF、数据接口和安全响应头形成闭环", async () => {
  const fixture = await startTestApplication();
  try {
    const anonymous = await jsonRequest(fixture.baseUrl, "/api/auth/me", { origin: null });
    const anonymousPayload = await anonymous.json();
    assert.deepEqual(anonymousPayload, { ok: true, authenticated: false });
    assert.equal(anonymous.headers.get("x-powered-by"), null);
    assert.match(anonymous.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");

    const privateResponse = await jsonRequest(fixture.baseUrl, "/api/dashboard", { origin: null });
    assert.equal(privateResponse.status, 401);
    assert.equal(JSON.stringify(await privateResponse.json()).includes("hasBoundStorageState"), false);

    const missingOrigin = await jsonRequest(fixture.baseUrl, "/api/auth/login", {
      method: "POST",
      origin: null,
      body: { password: "test-console-password" },
    });
    assert.equal(missingOrigin.status, 403);

    const wrongLogin = await login(fixture.baseUrl, "wrong-password");
    assert.equal(wrongLogin.response.status, 401);
    const signedIn = await login(fixture.baseUrl);
    assert.equal(signedIn.response.status, 200);
    assert.ok(signedIn.payload.csrfToken);
    const setCookie = signedIn.response.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=604800/);

    const missingCsrf = await jsonRequest(fixture.baseUrl, "/api/sync", {
      method: "POST",
      cookie: signedIn.cookie,
      body: {},
    });
    assert.equal(missingCsrf.status, 403);

    const repository = fixture.application.services.repository;
    const snapshot = {
      fetchedAt: "2026-07-09T20:00:00.000Z",
      accountName: "API TEST USER",
      accountNumberMasked: "*****1234",
      asOf: "07/09/2026 01:00 PM",
      plans: [{
        planCode: "Debit",
        name: "Cal 1 Card Debit",
        balance: "$40.00",
        balanceValue: 40,
        isCurrency: true,
      }],
    };
    repository.recordSync(snapshot, [{
      plan: snapshot.plans[0],
      transactions: [{
        posted: "07/09/2026 12:00 PM",
        postedAt: "2026-07-09T19:00:00.000Z",
        amount: "-$5.00",
        amountValue: -5,
        balance: "$40.00",
        balanceValue: 40,
        location: "Golden Bear Cafe",
      }],
    }]);

    const dashboardResponse = await jsonRequest(
      fixture.baseUrl,
      "/api/dashboard?range=30d&planCode=Debit",
      { cookie: signedIn.cookie, origin: null },
    );
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.ready, true);
    assert.equal(dashboard.accountName, "API TEST USER");
    assert.equal(dashboard.accountNumber, undefined);

    const categoryResponse = await jsonRequest(fixture.baseUrl, "/api/category-rules", {
      method: "PUT",
      cookie: signedIn.cookie,
      csrfToken: signedIn.payload.csrfToken,
      body: { location: "Golden Bear Cafe", category: "dining" },
    });
    assert.equal(categoryResponse.status, 200);
    const transactionsResponse = await jsonRequest(
      fixture.baseUrl,
      "/api/transactions?range=all&planCode=Debit",
      { cookie: signedIn.cookie, origin: null },
    );
    const transactions = await transactionsResponse.json();
    assert.equal(transactions.transactions[0].category, "dining");

    const budgetResponse = await jsonRequest(fixture.baseUrl, "/api/budgets/Debit", {
      method: "PUT",
      cookie: signedIn.cookie,
      csrfToken: signedIn.payload.csrfToken,
      body: { monthlyAmount: 120 },
    });
    assert.equal(budgetResponse.status, 200);

    const csvResponse = await jsonRequest(
      fixture.baseUrl,
      "/api/export.csv?range=all&planCode=Debit",
      { cookie: signedIn.cookie, origin: null },
    );
    assert.match(csvResponse.headers.get("content-disposition"), /attachment/);
    assert.match(await csvResponse.text(), /Golden Bear Cafe/);

    const wrongClear = await jsonRequest(fixture.baseUrl, "/api/data", {
      method: "DELETE",
      cookie: signedIn.cookie,
      csrfToken: signedIn.payload.csrfToken,
      body: { password: "wrong" },
    });
    assert.equal(wrongClear.status, 401);
    assert.equal(repository.getTransactions().length, 1);

    const logoutResponse = await jsonRequest(fixture.baseUrl, "/api/auth/logout", {
      method: "POST",
      cookie: signedIn.cookie,
      csrfToken: signedIn.payload.csrfToken,
      body: {},
    });
    assert.equal(logoutResponse.status, 200);
    assert.match(logoutResponse.headers.get("set-cookie"), /Max-Age=0/);
  } finally {
    await fixture.close();
  }
});

test("登录限流在连续失败后返回 429", async () => {
  const fixture = await startTestApplication({ loginRateLimitMax: 2, loginRateLimitWindowMs: 60_000 });
  try {
    assert.equal((await login(fixture.baseUrl, "wrong-1")).response.status, 401);
    assert.equal((await login(fixture.baseUrl, "wrong-2")).response.status, 401);
    assert.equal((await login(fixture.baseUrl, "wrong-3")).response.status, 429);
  } finally {
    await fixture.close();
  }
});

test("未带控制台会话的 WebSocket 升级被拒绝", async () => {
  const fixture = await startTestApplication();
  try {
    const statusCode = await new Promise((resolve, reject) => {
      const socket = new WebSocket(
        fixture.baseUrl.replace("http:", "ws:") + "/api/calnet-login-sessions/missing/stream",
        { origin: fixture.baseUrl },
      );
      socket.once("unexpected-response", (request, response) => {
        resolve(response.statusCode);
        response.destroy();
      });
      socket.once("error", reject);
    });
    assert.equal(statusCode, 401);
  } finally {
    await fixture.close();
  }
});
