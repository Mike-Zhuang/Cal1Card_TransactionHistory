import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EncryptedCodec } from "../src/crypto-store.js";
import {
  StorageStateStore,
  filterCal1CardStorageState,
} from "../src/storage-state-store.js";

const ALLOWED_HOST = "c1capps.sait-west.berkeley.edu";

function legacyEncrypt(secret, payload) {
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

test("AES-256-GCM 加密可往返并拒绝篡改", () => {
  const codec = new EncryptedCodec("unit-test-secret");
  const encrypted = codec.encrypt({ location: "Golden Bear Cafe", amount: -4.25 });
  assert.deepEqual(codec.decrypt(encrypted), { location: "Golden Bear Cafe", amount: -4.25 });

  const tampered = { ...encrypted, tag: Buffer.alloc(16, 7).toString("base64") };
  assert.throws(() => codec.decrypt(tampered));
  assert.equal(codec.fingerprint("same"), codec.fingerprint("same"));
  assert.notEqual(codec.fingerprint("same"), codec.fingerprint("different"));
});

test("storageState 只保留 Cal1Card 主机所需状态", () => {
  const filtered = filterCal1CardStorageState(
    {
      cookies: [
        { name: ".C1CAuth", domain: ALLOWED_HOST, value: "keep" },
        { name: "TGC", domain: "auth.berkeley.edu", value: "drop" },
        { name: "browsertrust", domain: "api.duosecurity.com", value: "drop" },
      ],
      origins: [
        { origin: `https://${ALLOWED_HOST}`, localStorage: [] },
        { origin: "https://auth.berkeley.edu", localStorage: [{ name: "secret", value: "drop" }] },
      ],
    },
    ALLOWED_HOST,
  );
  assert.deepEqual(filtered.cookies.map((cookie) => cookie.name), [".C1CAuth"]);
  assert.deepEqual(filtered.origins.map((origin) => origin.origin), [`https://${ALLOWED_HOST}`]);
});

test("V1 登录态首次读取后自动缩减并迁移到新密钥", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cal1card-storage-"));
  const filePath = path.join(directory, "state.enc.json");
  const secret = "legacy-compatible-secret";
  const legacyPayload = {
    storageState: {
      cookies: [
        { name: ".C1CAuth", domain: ALLOWED_HOST, value: "cal1card-cookie" },
        { name: "TGC", domain: "auth.berkeley.edu", value: "calnet-cookie" },
      ],
      origins: [{ origin: "https://auth.berkeley.edu", localStorage: [] }],
    },
    metadata: { source: "v1" },
  };
  writeFileSync(filePath, JSON.stringify(legacyEncrypt(secret, legacyPayload)));

  try {
    const codec = new EncryptedCodec(secret);
    const store = new StorageStateStore({ filePath, codec, allowedHost: ALLOWED_HOST });
    const loaded = store.load();
    assert.equal(loaded.metadata.migratedFrom, "v1");
    assert.deepEqual(loaded.storageState.cookies.map((cookie) => cookie.name), [".C1CAuth"]);

    const migratedEnvelope = JSON.parse(readFileSync(filePath, "utf8"));
    const migrated = codec.decrypt(migratedEnvelope);
    assert.deepEqual(migrated.storageState.cookies.map((cookie) => cookie.name), [".C1CAuth"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
