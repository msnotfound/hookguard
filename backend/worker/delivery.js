import { fetch } from "undici";

import { config } from "../shared/config.js";
import { signWebhook } from "../shared/signatures.js";
import { createSafeDispatcher, validateTargetUrl } from "../shared/target-safety.js";

export async function deliver(event, dependencies = {}) {
  const {
    fetchImpl = fetch,
    validateTargetUrlImpl = validateTargetUrl,
    createSafeDispatcherImpl = createSafeDispatcher,
    requestTimeoutMs = config.requestTimeoutMs
  } = dependencies;
  const attemptNumber = event.attemptCount + 1;
  const startedAt = new Date();
  let statusCode = null;
  let responseBody = "";
  let errorText = null;
  let ok = false;
  let dispatcher;
  let signatureAlgorithm = null;
  let signatureTimestamp = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const targetUrl = await validateTargetUrlImpl(event.targetUrl, { allowLocalReceiver: true });
    const body = Buffer.from(JSON.stringify(event.payload));
    const headers = {
      "content-type": "application/json",
      "x-hookguard-event-id": event.id,
      "x-hookguard-attempt": String(attemptNumber),
      "x-idempotency-key": event.idempotencyKey,
      "user-agent": "HookGuard/1.0"
    };
    if (event.endpointSigningSecret) {
      const signed = signWebhook(body, event.endpointSigningSecret);
      headers["x-hookguard-timestamp"] = signed.timestamp;
      headers["x-hookguard-signature"] = signed.signature;
      signatureAlgorithm = "HMAC-SHA256";
      signatureTimestamp = Number(signed.timestamp);
    }

    dispatcher = createSafeDispatcherImpl(targetUrl);
    const response = await fetchImpl(targetUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
      dispatcher
    });
    statusCode = response.status;
    responseBody = await readResponseSnippet(response, 2048);
    ok = response.ok;
    if (!ok) errorText = `Receiver returned HTTP ${response.status}`;
  } catch (error) {
    errorText = error.name === "AbortError"
      ? `Receiver timed out after ${requestTimeoutMs}ms`
      : error.message;
  } finally {
    clearTimeout(timeout);
    if (dispatcher) await dispatcher.close().catch(() => {});
  }

  const finishedAt = new Date();
  const delayMs = ok || attemptNumber >= event.maxAttempts
    ? 0
    : retryDelay(event, attemptNumber);
  return {
    attemptNumber,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    statusCode,
    ok,
    error: errorText,
    responseBody,
    signatureAlgorithm,
    signatureTimestamp,
    delayMs,
    nextAttemptAt: delayMs ? new Date(finishedAt.getTime() + delayMs).toISOString() : null
  };
}

function retryDelay(event, attemptNumber) {
  const base = Math.min(event.backoffCapMs, event.backoffBaseMs * 2 ** Math.max(0, attemptNumber - 1));
  const spread = base * (event.jitterPercent / 100);
  return Math.max(100, Math.round(base - spread + Math.random() * spread * 2));
}

async function readResponseSnippet(response, maximum) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maximum) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maximum - size);
      chunks.push(chunk);
      size += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
