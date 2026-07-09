import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function ensurePrivateDirectory(directoryPath) {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  chmodSync(directoryPath, 0o700);
}

export function writeFileAtomic(filePath, contents, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, contents, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, mode);
}

export function getOrCreateSecret(config) {
  if (config.encryptionSecret) {
    return config.encryptionSecret;
  }

  ensurePrivateDirectory(config.dataDir);
  if (existsSync(config.generatedSecretPath)) {
    return readFileSync(config.generatedSecretPath, "utf8").trim();
  }

  const secret = crypto.randomBytes(48).toString("base64url");
  writeFileAtomic(config.generatedSecretPath, `${secret}\n`, 0o600);
  return secret;
}

export class EncryptedCodec {
  constructor(secret) {
    const normalizedSecret = String(secret);
    const rootKey = crypto.createHash("sha512").update(normalizedSecret).digest();
    this.encryptionKey = rootKey.subarray(0, 32);
    this.fingerprintKey = rootKey.subarray(32, 64);
    this.legacyEncryptionKey = crypto.createHash("sha256").update(normalizedSecret).digest();
    this.sessionKey = crypto
      .createHmac("sha256", rootKey)
      .update("cal1card-session-v2")
      .digest();
  }

  encrypt(payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      version: 1,
      algorithm: "aes-256-gcm",
      createdAt: new Date().toISOString(),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  decrypt(encryptedPayload) {
    if (
      !encryptedPayload ||
      encryptedPayload.version !== 1 ||
      encryptedPayload.algorithm !== "aes-256-gcm"
    ) {
      throw new Error("不支持的加密数据格式");
    }

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(encryptedPayload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(encryptedPayload.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  decryptCompatible(encryptedPayload) {
    try {
      return { payload: this.decrypt(encryptedPayload), usedLegacyKey: false };
    } catch (currentError) {
      try {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this.legacyEncryptionKey,
          Buffer.from(encryptedPayload.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(encryptedPayload.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(encryptedPayload.ciphertext, "base64")),
          decipher.final(),
        ]);
        return { payload: JSON.parse(plaintext.toString("utf8")), usedLegacyKey: true };
      } catch {
        throw currentError;
      }
    }
  }

  fingerprint(value) {
    return crypto
      .createHmac("sha256", this.fingerprintKey)
      .update(typeof value === "string" ? value : JSON.stringify(value))
      .digest("base64url");
  }
}

export function safeEqualText(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}
