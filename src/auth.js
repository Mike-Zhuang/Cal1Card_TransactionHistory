import crypto from "node:crypto";

import { safeEqualText } from "./crypto-store.js";

export function parseCookies(cookieHeader) {
  const cookies = new Map();
  for (const part of String(cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    try {
      cookies.set(rawName, decodeURIComponent(rawValueParts.join("=")));
    } catch {
      cookies.set(rawName, rawValueParts.join("="));
    }
  }
  return cookies;
}

export function shouldUseSecureCookie(request) {
  return request.secure || request.headers["x-forwarded-proto"] === "https";
}

export function buildCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    `SameSite=${options.sameSite ?? "Strict"}`,
  ];
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function sign(value, key) {
  return crypto.createHmac("sha256", key).update(value).digest("base64url");
}

function safeEqualBuffer(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export class AppAuth {
  constructor({ appPassword, sessionKey, cookieName, maxAgeSeconds, now = () => Date.now() }) {
    this.appPassword = appPassword;
    this.sessionKey = sessionKey;
    this.cookieName = cookieName;
    this.maxAgeSeconds = maxAgeSeconds;
    this.now = now;
    this.passwordVersion = crypto
      .createHash("sha256")
      .update(appPassword)
      .digest("base64url")
      .slice(0, 16);
  }

  authenticatePassword(password) {
    return safeEqualText(String(password), this.appPassword);
  }

  createSessionToken() {
    const issuedAt = Math.floor(this.now() / 1000);
    const payload = {
      issuedAt,
      expiresAt: issuedAt + this.maxAgeSeconds,
      csrfToken: crypto.randomBytes(24).toString("base64url"),
      passwordVersion: this.passwordVersion,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encodedPayload}.${sign(encodedPayload, this.sessionKey)}`;
  }

  verifySessionToken(token) {
    const [encodedPayload, signature, extra] = String(token ?? "").split(".");
    if (!encodedPayload || !signature || extra || !safeEqualBuffer(signature, sign(encodedPayload, this.sessionKey))) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      if (
        payload.passwordVersion !== this.passwordVersion ||
        !payload.csrfToken ||
        payload.expiresAt <= Math.floor(this.now() / 1000)
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  getSession(request) {
    const token = parseCookies(request.headers.cookie).get(this.cookieName);
    return this.verifySessionToken(token);
  }

  setSessionCookie(request, response, token) {
    response.setHeader(
      "Set-Cookie",
      buildCookie(this.cookieName, token, {
        maxAgeSeconds: this.maxAgeSeconds,
        secure: shouldUseSecureCookie(request),
      }),
    );
  }

  clearSessionCookie(request, response) {
    response.setHeader(
      "Set-Cookie",
      buildCookie(this.cookieName, "", {
        maxAgeSeconds: 0,
        secure: shouldUseSecureCookie(request),
      }),
    );
  }

  requireAuth() {
    return (request, response, next) => {
      const session = this.getSession(request);
      if (!session) {
        response.status(401).json({
          ok: false,
          needsAppLogin: true,
          error: "控制台登录已过期",
        });
        return;
      }
      request.appSession = session;
      next();
    };
  }

  requireMutation(publicOrigin = "") {
    return (request, response, next) => {
      const session = this.getSession(request);
      if (!session) {
        response.status(401).json({ ok: false, needsAppLogin: true, error: "控制台登录已过期" });
        return;
      }

      const origin = String(request.headers.origin ?? "");
      const forwardedProtocol = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0];
      const protocol = forwardedProtocol || request.protocol;
      const expectedOrigin = publicOrigin || `${protocol}://${request.get("host")}`;
      if (!origin || origin !== expectedOrigin) {
        response.status(403).json({ ok: false, error: "请求来源验证失败" });
        return;
      }
      if (!safeEqualText(request.headers["x-csrf-token"] ?? "", session.csrfToken)) {
        response.status(403).json({ ok: false, error: "CSRF 验证失败" });
        return;
      }

      request.appSession = session;
      next();
    };
  }
}
