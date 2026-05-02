import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/** Only when `FUNCTIONS_EMULATOR` is set; never use in production. */
function devEmulatorFallbackKey(): Buffer {
  console.warn(
    "[crypto] ENCRYPTION_KEY is unset — using a fixed emulator-only key. Add ENCRYPTION_KEY to functions/.env (openssl rand -base64 32) for production-like behavior.",
  );
  return Buffer.alloc(32, 0);
}

function getKey(): Buffer {
  const b64 = process.env.ENCRYPTION_KEY?.trim();
  if (!b64) {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      return devEmulatorFallbackKey();
    }
    throw new Error("ENCRYPTION_KEY is not set (base64-encoded 32 bytes)");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to 32 bytes");
  }
  return key;
}

export type EncPayload = { iv: string; tag: string; data: string };

export function encryptUtf8(plain: string): EncPayload {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

export function decryptUtf8(payload: EncPayload): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
