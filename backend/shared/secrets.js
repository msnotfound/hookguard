import "dotenv/config";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const secretKey = process.env.HOOKGUARD_SECRET_KEY || (process.env.NODE_ENV === "production" ? "" : "hookguard-local-encryption-key-change-before-deploy");
if (!secretKey) throw new Error("HOOKGUARD_SECRET_KEY must be set in production.");

const key = createHash("sha256")
  .update(secretKey)
  .digest();

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(value) {
  if (!value?.startsWith("enc:v1:")) return value;
  const [, , ivHex, tagHex, ciphertextHex] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}
