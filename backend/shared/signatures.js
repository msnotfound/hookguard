import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  return { timestamp: String(timestamp), signature: `t=${timestamp},v1=${digest}` };
}

export function verifyWebhook(rawBody, secret, signatureHeader, toleranceSeconds = 300) {
  if (typeof signatureHeader !== "string") return { ok: false, reason: "Missing signature header." };
  const fields = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=", 2)));
  const timestamp = Number(fields.t);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "Signature timestamp is outside the allowed window." };
  }
  if (!/^[a-f0-9]{64}$/i.test(fields.v1 || "")) return { ok: false, reason: "Signature format is invalid." };

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const provided = Buffer.from(fields.v1, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "Signature verification failed." };
  }
  return { ok: true, timestamp };
}
