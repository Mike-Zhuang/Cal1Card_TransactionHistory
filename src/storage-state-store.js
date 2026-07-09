import { existsSync, readFileSync, rmSync } from "node:fs";

import { writeFileAtomic } from "./crypto-store.js";

export function validateStorageStateShape(storageState) {
  return Boolean(
    storageState &&
      typeof storageState === "object" &&
      Array.isArray(storageState.cookies) &&
      Array.isArray(storageState.origins),
  );
}

export function filterCal1CardStorageState(storageState, allowedHost) {
  if (!validateStorageStateShape(storageState)) {
    throw new Error("storageState 格式不正确");
  }

  const normalizedHost = allowedHost.toLowerCase();
  const cookies = storageState.cookies.filter((cookie) => {
    const domain = String(cookie.domain ?? "").replace(/^\./, "").toLowerCase();
    return domain === normalizedHost;
  });
  const origins = storageState.origins.filter((origin) => {
    try {
      return new URL(origin.origin).hostname.toLowerCase() === normalizedHost;
    } catch {
      return false;
    }
  });

  return { cookies, origins };
}

export class StorageStateStore {
  constructor({ filePath, codec, allowedHost }) {
    this.filePath = filePath;
    this.codec = codec;
    this.allowedHost = allowedHost;
  }

  has() {
    return existsSync(this.filePath);
  }

  load() {
    if (!this.has()) {
      return null;
    }

    const encryptedPayload = JSON.parse(readFileSync(this.filePath, "utf8"));
    const decrypted = this.codec.decryptCompatible(encryptedPayload);
    if (!decrypted.usedLegacyKey) {
      return decrypted.payload;
    }

    // V1 使用不同的密钥派生方式，并保存了 CalNet/Duo Cookie。读取后立刻缩减并迁移。
    return this.save(decrypted.payload.storageState, {
      ...decrypted.payload.metadata,
      migratedFrom: "v1",
    });
  }

  save(storageState, metadata = {}) {
    const filteredStorageState = filterCal1CardStorageState(storageState, this.allowedHost);
    if (!filteredStorageState.cookies.length) {
      throw new Error("登录态中没有可用的 Cal1Card Cookie");
    }

    const payload = {
      storageState: filteredStorageState,
      metadata: {
        ...metadata,
        savedAt: new Date().toISOString(),
      },
    };
    writeFileAtomic(this.filePath, `${JSON.stringify(this.codec.encrypt(payload), null, 2)}\n`);
    return payload;
  }

  delete() {
    if (this.has()) {
      rmSync(this.filePath);
    }
  }
}
