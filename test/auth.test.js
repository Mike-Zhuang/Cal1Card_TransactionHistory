import assert from "node:assert/strict";
import test from "node:test";

import { AppAuth, buildCookie, parseCookies } from "../src/auth.js";

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

test("签名会话校验密码版本、签名和过期时间", () => {
  let now = Date.parse("2026-07-09T00:00:00.000Z");
  const auth = new AppAuth({
    appPassword: "correct-password",
    sessionKey: Buffer.alloc(32, 9),
    cookieName: "session",
    maxAgeSeconds: 60,
    now: () => now,
  });
  assert.equal(auth.authenticatePassword("correct-password"), true);
  assert.equal(auth.authenticatePassword("wrong-password"), false);

  const token = auth.createSessionToken();
  assert.ok(auth.verifySessionToken(token)?.csrfToken);
  assert.equal(auth.verifySessionToken(`${token}tampered`), null);
  now += 61_000;
  assert.equal(auth.verifySessionToken(token), null);
});

test("Cookie 默认使用 HttpOnly 和 SameSite=Strict", () => {
  const cookie = buildCookie("session", "token", { secure: true, path: "/private" });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\/private/);
  assert.equal(parseCookies("first=one; second=two%20words").get("second"), "two words");
});

test("写接口同时要求有效会话、同源 Origin 和 CSRF", () => {
  const auth = new AppAuth({
    appPassword: "password",
    sessionKey: Buffer.alloc(32, 5),
    cookieName: "session",
    maxAgeSeconds: 60,
  });
  const token = auth.createSessionToken();
  const session = auth.verifySessionToken(token);
  const middleware = auth.requireMutation("https://wallet.example");
  const baseRequest = {
    protocol: "https",
    get: () => "wallet.example",
    headers: {
      cookie: `session=${token}`,
      origin: "https://wallet.example",
      "x-csrf-token": session.csrfToken,
    },
  };

  let nextCalled = false;
  middleware(baseRequest, responseRecorder(), () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  const wrongOrigin = responseRecorder();
  middleware(
    { ...baseRequest, headers: { ...baseRequest.headers, origin: "https://evil.example" } },
    wrongOrigin,
    () => {},
  );
  assert.equal(wrongOrigin.statusCode, 403);

  const wrongCsrf = responseRecorder();
  middleware(
    { ...baseRequest, headers: { ...baseRequest.headers, "x-csrf-token": "wrong" } },
    wrongCsrf,
    () => {},
  );
  assert.equal(wrongCsrf.statusCode, 403);
});
