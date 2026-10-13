import { randomUUID } from "node:crypto";

export const EVENT_STATUSES = Object.freeze([
  "queued",
  "scheduled",
  "delivering",
  "succeeded",
  "failed"
]);

export function calculateBackoffMs(attemptNumber, baseMs = 1000, capMs = 30000) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

export function isDeliverableStatus(status) {
  return status === "queued" || status === "scheduled";
}

export function normalizeTargetUrl(targetUrl, origin) {
  if (typeof targetUrl !== "string" || targetUrl.trim().length === 0) {
    throw new Error("targetUrl is required.");
  }

  const raw = targetUrl.trim();
  const parsed = raw.startsWith("/")
    ? new URL(raw, origin)
    : new URL(raw);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("targetUrl must use http or https.");
  }

  return parsed.toString();
}

export function validateEventInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("Request body must be a JSON object.");
  }

  if (typeof body.targetUrl !== "string" || body.targetUrl.trim().length === 0) {
    return badRequest("targetUrl is required.");
  }

  if (!Object.hasOwn(body, "payload")) {
    return badRequest("payload is required.");
  }

  const maxAttempts = body.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    return badRequest("maxAttempts must be an integer from 1 to 8.");
  }

  if (
    body.idempotencyKey !== undefined &&
    (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length > 120)
  ) {
    return badRequest("idempotencyKey must be a string up to 120 characters.");
  }

  return { ok: true };
}

export function createEventRecord({
  id,
  targetUrl,
  payload,
  idempotencyKey,
  maxAttempts = 3,
  now = new Date().toISOString()
}) {
  const eventId = id || randomUUID();

  return {
    id: eventId,
    targetUrl,
    payload,
    idempotencyKey: idempotencyKey || eventId,
    status: "queued",
    attemptCount: 0,
    maxAttempts,
    attempts: [],
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    deliveredAt: null,
    failedAt: null,
    replayCount: 0
  };
}

export function publicEvent(event) {
  return {
    ...event,
    nextAttemptInMs: event.nextAttemptAt
      ? Math.max(0, new Date(event.nextAttemptAt).getTime() - Date.now())
      : null
  };
}

function badRequest(message) {
  return {
    ok: false,
    statusCode: 400,
    error: { code: "validation_error", message }
  };
}
