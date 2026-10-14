import cors from "cors";
import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  createDemoOrder,
  createEndpoint,
  createEvent,
  endpointAnalytics,
  getEndpoint,
  getEvent,
  listDemoOrders,
  listEndpoints,
  listEvents,
  listReceiverInbox,
  recordReceiverDelivery,
  replayEvent,
  summary,
  updateEndpoint
} from "../shared/events-repository.js";
import { config } from "../shared/config.js";
import { query } from "../shared/db.js";
import { queueConnection } from "../shared/queue.js";
import { createIpRateLimiter } from "../shared/rate-limit.js";
import { verifyWebhook } from "../shared/signatures.js";
import { validateTargetUrl } from "../shared/target-safety.js";

const app = express();
const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  ...(process.env.HOOKGUARD_ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)
]);
if (process.env.VERCEL_URL) allowedOrigins.add(`https://${process.env.VERCEL_URL}`);
app.set("trust proxy", 1);

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (!origin) return next();
  let sameOrigin = false;
  try { sameOrigin = new URL(origin).host === req.get("host"); } catch {}
  if (!sameOrigin && !allowedOrigins.has(origin)) {
    const error = new Error("This origin is not allowed.");
    error.status = 403;
    return next(error);
  }
  return cors({ origin, credentials: false })(req, res, next);
});
app.use(express.json({
  limit: "1mb",
  verify(req, res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

if (config.publicDemo) {
  const limitPublicWrites = createIpRateLimiter({
    redis: queueConnection,
    namespace: "hookguard:public-demo:write",
    limit: 20,
    windowSeconds: 60
  });
  app.use("/api", (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (req.path.startsWith("/receiver/delivery/")) return next();
    return limitPublicWrites(req, res, next);
  });
}

app.get("/api/health", async (req, res, next) => {
  try {
    await query("SELECT 1");
    const redis = await queueConnection.ping();
    const worker = await query(`SELECT EXISTS (
      SELECT 1 FROM service_heartbeats
      WHERE service_role = 'worker' AND last_seen_at > NOW() - INTERVAL '15 seconds'
    ) AS online`);
    const services = {
      api: "ok",
      postgres: "ok",
      redis: redis === "PONG" ? "ok" : "degraded",
      worker: worker.rows[0].online ? "ok" : "degraded"
    };
    res.json({ status: Object.values(services).every((service) => service === "ok") ? "ok" : "degraded", services });
  } catch (error) {
    next(error);
  }
});

app.get("/api/summary", async (req, res, next) => {
  try { res.json(await summary()); } catch (error) { next(error); }
});

app.get("/api/analytics/endpoints", async (req, res, next) => {
  try { res.json({ endpoints: await endpointAnalytics() }); } catch (error) { next(error); }
});

app.get("/api/endpoints", async (req, res, next) => {
  try { res.json({ endpoints: await listEndpoints() }); } catch (error) { next(error); }
});

app.post("/api/endpoints", async (req, res, next) => {
  try {
    const name = stringField(req.body?.name, 2, 80, "Endpoint name");
    const id = `ep_${randomBytes(6).toString("hex")}`;
    const signingSecret = `whsec_${randomBytes(24).toString("hex")}`;
    let targetUrl;
    if (config.publicDemo && req.body?.destinationType !== "simulator") {
      throw httpError(403, "The public portfolio demo only supports its built-in simulated receiver.");
    }
    if (req.body?.destinationType === "simulator") {
      targetUrl = config.receiverUrl(id);
    } else {
      targetUrl = await validateTargetUrl(req.body?.targetUrl);
    }

    const endpoint = await createEndpoint({
      id,
      name,
      targetUrl,
      signingSecret,
      maxAttempts: boundedInteger(req.body?.maxAttempts, 3, 1, 8, "Max attempts"),
      backoffBaseMs: boundedInteger(req.body?.backoffBaseMs, 700, 100, 60000, "Backoff base"),
      backoffCapMs: boundedInteger(req.body?.backoffCapMs, 6000, 100, 300000, "Backoff cap"),
      jitterPercent: boundedInteger(req.body?.jitterPercent, 20, 0, 50, "Jitter")
    });
    res.status(201).json({ endpoint: withoutSecret(endpoint), signingSecret });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/endpoints/:id", async (req, res, next) => {
  try {
    const fields = {};
    const body = req.body || {};
    if (body.name !== undefined) fields.name = stringField(body.name, 2, 80, "Endpoint name");
    if (body.active !== undefined) fields.active = Boolean(body.active);
    if (body.maxAttempts !== undefined) fields.maxAttempts = boundedInteger(body.maxAttempts, 3, 1, 8, "Max attempts");
    if (body.backoffBaseMs !== undefined) fields.backoffBaseMs = boundedInteger(body.backoffBaseMs, 700, 100, 60000, "Backoff base");
    if (body.backoffCapMs !== undefined) fields.backoffCapMs = boundedInteger(body.backoffCapMs, 6000, 100, 300000, "Backoff cap");
    if (body.jitterPercent !== undefined) fields.jitterPercent = boundedInteger(body.jitterPercent, 20, 0, 50, "Jitter");
    if (body.failureMode !== undefined) {
      if (!["success", "retry_then_success", "always_fail", "rate_limit", "timeout"].includes(body.failureMode)) {
        throw httpError(400, "Choose a supported Failure Lab mode.");
      }
      fields.failureMode = body.failureMode;
    }
    if (body.failuresBeforeSuccess !== undefined) fields.failuresBeforeSuccess = boundedInteger(body.failuresBeforeSuccess, 2, 0, 8, "Failures before success");
    if (body.failureStatusCode !== undefined) fields.failureStatusCode = boundedInteger(body.failureStatusCode, 500, 400, 599, "Failure status");
    if (body.simulatedDelayMs !== undefined) fields.simulatedDelayMs = boundedInteger(body.simulatedDelayMs, 4500, 0, 10000, "Simulated delay");
    if (body.targetUrl !== undefined) {
      if (config.publicDemo) throw httpError(403, "External destinations are disabled in the public portfolio demo.");
      fields.targetUrl = await validateTargetUrl(body.targetUrl);
    }

    const currentEndpoint = await getEndpoint(req.params.id);
    if (!currentEndpoint) return res.status(404).json(notFound("endpoint_not_found"));
    const nextMode = fields.failureMode ?? currentEndpoint.failureMode;
    const nextDelay = fields.simulatedDelayMs ?? currentEndpoint.simulatedDelayMs;
    if (nextMode === "timeout" && nextDelay <= config.requestTimeoutMs) {
      throw httpError(400, `Timeout delay must be greater than the ${config.requestTimeoutMs}ms delivery timeout.`);
    }

    const endpoint = await updateEndpoint(req.params.id, fields);
    if (!endpoint) return res.status(404).json(notFound("endpoint_not_found"));
    const { signingSecret, ...safeEndpoint } = endpoint;
    res.json({ endpoint: safeEndpoint });
  } catch (error) {
    next(error);
  }
});

app.post("/api/endpoints/:id/rotate-secret", async (req, res, next) => {
  try {
    const signingSecret = `whsec_${randomBytes(24).toString("hex")}`;
    const endpoint = await updateEndpoint(req.params.id, { signingSecret });
    if (!endpoint) return res.status(404).json(notFound("endpoint_not_found"));
    res.json({ endpoint: withoutSecret(endpoint), signingSecret });
  } catch (error) { next(error); }
});

app.post("/api/endpoints/:id/test", async (req, res, next) => {
  try {
    const endpoint = await getEndpoint(req.params.id);
    if (!endpoint) return res.status(404).json(notFound("endpoint_not_found"));
    if (!endpoint.active) return res.status(409).json({ error: { code: "endpoint_paused", message: "Resume this endpoint before sending a test event." } });
    const event = await createEvent({
      endpointId: endpoint.id,
      targetUrl: endpoint.targetUrl,
      payload: { event: "hookguard.test", sentAt: new Date().toISOString() },
      idempotencyKey: `test:${Date.now()}`,
      maxAttempts: endpoint.maxAttempts,
      backoffBaseMs: endpoint.backoffBaseMs,
      backoffCapMs: endpoint.backoffCapMs,
      jitterPercent: endpoint.jitterPercent
    });
    res.status(202).json({ event });
  } catch (error) { next(error); }
});

app.get("/api/events", async (req, res, next) => {
  try {
    const events = await listEvents({
      search: String(req.query.q || ""),
      status: String(req.query.status || ""),
      endpointId: String(req.query.endpointId || "")
    });
    res.json({ events });
  } catch (error) { next(error); }
});

app.post("/api/events", async (req, res, next) => {
  try {
    const event = await createDashboardEvent(req.body || {});
    res.status(202).json({ event });
  } catch (error) { next(error); }
});

app.get("/api/events/:id", async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json(notFound("event_not_found"));
    res.json({ event });
  } catch (error) { next(error); }
});

app.post("/api/events/:id/replay", async (req, res, next) => {
  try {
    const event = await replayEvent(req.params.id);
    if (!event) return res.status(409).json({ error: { code: "event_not_replayable", message: "Only completed or dead-lettered events can be replayed." } });
    res.status(202).json({ event });
  } catch (error) { next(error); }
});

app.get("/api/quickstart", (req, res) => {
  const localDemo = process.env.NODE_ENV !== "production";
  res.json({
    apiKey: localDemo ? config.apiKey : null,
    apiBaseUrl: config.publicApiBaseUrl,
    demoEndpointId: "demo-receiver",
    authentication: "Authorization: Bearer <API_KEY>",
    exposedForLocalDemo: localDemo
  });
});

app.get("/api/receiver/inbox", async (req, res, next) => {
  try { res.json({ receipts: await listReceiverInbox() }); } catch (error) { next(error); }
});

app.get("/api/store/orders", async (req, res, next) => {
  try { res.json({ orders: await listDemoOrders() }); } catch (error) { next(error); }
});

app.post("/api/store/orders", async (req, res, next) => {
  try {
    const customerName = stringField(req.body?.customerName || "Alex Morgan", 2, 80, "Customer name");
    const itemName = stringField(req.body?.itemName || "Studio Headphones", 2, 100, "Item name");
    const amountCents = boundedInteger(req.body?.amountCents, 12900, 1, 10000000, "Amount");
    const endpoint = await getEndpoint(String(req.body?.endpointId || "demo-receiver"));
    if (!endpoint || !endpoint.active) return res.status(409).json({ error: { code: "receiver_unavailable", message: "The notification receiver is missing or paused." } });
    const result = await createDemoOrder({ customerName, itemName, amountCents, endpoint });
    res.status(202).json(result);
  } catch (error) { next(error); }
});

async function receiveWebhook(req, res, next) {
  try {
    const endpoint = await getEndpoint(req.params.endpointId);
    if (!endpoint) return res.status(404).json({ accepted: false, error: "Receiver not found." });
    const verification = verifyWebhook(
      req.rawBody || Buffer.from(JSON.stringify(req.body ?? {})),
      endpoint.signingSecret,
      req.get("x-hookguard-signature")
    );
    if (!verification.ok) return res.status(401).json({ accepted: false, error: verification.reason });
    if (req.get("x-hookguard-timestamp") !== String(verification.timestamp)) {
      return res.status(401).json({ accepted: false, error: "Signature timestamp header does not match the signed timestamp." });
    }

    const eventId = req.get("x-hookguard-event-id");
    const idempotencyKey = req.get("x-idempotency-key");
    if (!eventId || !idempotencyKey) return res.status(400).json({ accepted: false, error: "Event and idempotency headers are required." });
    const attemptNumber = Number(req.get("x-hookguard-attempt") || 1);
    const mode = endpoint.failureMode;

    if (mode === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, endpoint.simulatedDelayMs));
      if (req.destroyed || res.destroyed) return;
    }
    if (mode === "always_fail") {
      return res.status(endpoint.failureStatusCode).json({ accepted: false, receiver: endpoint.name, message: "Failure Lab is holding this destination offline." });
    }
    if (mode === "rate_limit") {
      return res.status(429).json({ accepted: false, receiver: endpoint.name, message: "Failure Lab is applying a rate limit." });
    }
    if (mode === "retry_then_success" && attemptNumber <= endpoint.failuresBeforeSuccess) {
      return res.status(endpoint.failureStatusCode).json({ accepted: false, receiver: endpoint.name, message: `Simulated HTTP ${endpoint.failureStatusCode} before recovery.` });
    }

    const inserted = await recordReceiverDelivery({ endpointId: endpoint.id, eventId, idempotencyKey, payload: req.body });
    res.json({ accepted: true, receiver: endpoint.name, eventId, deduplicated: !inserted, signatureVerified: true });
  } catch (error) { next(error); }
}

app.post(["/receiver/:endpointId", "/api/receiver/delivery/:endpointId"], receiveWebhook);

app.post(["/v1/events", "/api/v1/events"], requireApiKey, async (req, res, next) => {
  try {
    const event = await createDashboardEvent(req.body || {});
    res.status(202).json({ id: event.id, status: event.status, createdAt: event.createdAt });
  } catch (error) { next(error); }
});

app.use("/api", (req, res) => res.status(404).json(notFound("route_not_found")));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.statusCode || error.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: {
      code: error.code || (status === 400 ? "validation_error" : "internal_error"),
      message: error.message || "Unexpected server error."
    }
  });
});

async function createDashboardEvent(body) {
  const endpointId = String(body.endpointId || "");
  if (!endpointId) throw httpError(400, "Select a configured endpoint.");
  if (!Object.hasOwn(body, "payload")) throw httpError(400, "Event payload is required.");
  const endpoint = await getEndpoint(endpointId);
  if (!endpoint) throw httpError(404, "The selected endpoint does not exist.");
  if (!endpoint.active) throw httpError(409, "This endpoint is paused. Resume it before sending events.");
  const idempotencyKey = body.idempotencyKey === undefined ? undefined : stringField(body.idempotencyKey, 1, 120, "Idempotency key");
  const maxAttempts = boundedInteger(body.maxAttempts, endpoint.maxAttempts, 1, 8, "Max attempts");
  return createEvent({
    endpointId,
    targetUrl: endpoint.targetUrl,
    payload: body.payload,
    idempotencyKey,
    maxAttempts,
    backoffBaseMs: endpoint.backoffBaseMs,
    backoffCapMs: endpoint.backoffCapMs,
    jitterPercent: endpoint.jitterPercent
  });
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    return res.status(503).json({ error: { code: "api_key_not_configured", message: "Set HOOKGUARD_API_KEY before enabling the producer API." } });
  }
  const provided = req.get("authorization")?.replace(/^Bearer\s+/i, "") || req.get("x-api-key") || "";
  const expectedDigest = createHash("sha256").update(config.apiKey).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  if (!timingSafeEqual(providedDigest, expectedDigest)) {
    return res.status(401).json({ error: { code: "invalid_api_key", message: "Provide a valid HookGuard API key." } });
  }
  next();
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(400, `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function stringField(value, minimum, maximum, label) {
  if (typeof value !== "string" || value.trim().length < minimum || value.trim().length > maximum) {
    throw httpError(400, `${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return value.trim();
}

function withoutSecret(endpoint) {
  const { signingSecret, ...safeEndpoint } = endpoint;
  return safeEndpoint;
}

function notFound(code) {
  return { error: { code, message: "The requested resource was not found." } };
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export { app };
