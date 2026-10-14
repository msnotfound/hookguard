import { nanoid } from "nanoid";

import { pool, query } from "./db.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

export const updateDeliveryAttemptStatusSql = `UPDATE webhook_events SET status = $2, attempt_count = $3,
  delivered_at = CASE WHEN $2 = 'succeeded' THEN $4::timestamptz ELSE NULL END,
  failed_at = CASE WHEN $2 = 'failed' THEN $4::timestamptz ELSE NULL END,
  next_attempt_at = CASE WHEN $2 = 'scheduled' THEN $5::timestamptz ELSE NULL END,
  updated_at = NOW()
 WHERE id = $1`;

export async function listEndpoints() {
  const result = await query(`
    SELECT
      ep.*,
      COUNT(DISTINCT e.id)::int AS event_count,
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'succeeded')::int AS succeeded_count,
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'failed')::int AS failed_count,
      COALESCE(ROUND(AVG(a.latency_ms)), 0)::int AS average_latency_ms,
      MAX(e.created_at) AS last_event_at
    FROM webhook_endpoints ep
    LEFT JOIN webhook_events e ON e.endpoint_id = ep.id
    LEFT JOIN delivery_attempts a ON a.event_id = e.id
    GROUP BY ep.id
    ORDER BY ep.created_at DESC
  `);

  return result.rows.map(mapEndpoint);
}

export async function getEndpoint(id) {
  const result = await query("SELECT * FROM webhook_endpoints WHERE id = $1", [id]);
  return result.rows[0] ? mapEndpoint(result.rows[0], true) : null;
}

export async function createEndpoint(endpoint) {
  const result = await query(
    `INSERT INTO webhook_endpoints (
      id, name, target_url, signing_secret, active, max_attempts,
      backoff_base_ms, backoff_cap_ms, jitter_percent, failure_mode,
      failures_before_success, failure_status_code, simulated_delay_ms
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      endpoint.id || nanoid(12),
      endpoint.name,
      endpoint.targetUrl,
      encryptSecret(endpoint.signingSecret),
      endpoint.active ?? true,
      endpoint.maxAttempts ?? 3,
      endpoint.backoffBaseMs ?? 700,
      endpoint.backoffCapMs ?? 6000,
      endpoint.jitterPercent ?? 20,
      endpoint.failureMode ?? "success",
      endpoint.failuresBeforeSuccess ?? 2,
      endpoint.failureStatusCode ?? 500,
      endpoint.simulatedDelayMs ?? 4500
    ]
  );
  return mapEndpoint(result.rows[0], true);
}

export async function updateEndpoint(id, fields) {
  const columns = {
    name: "name",
    targetUrl: "target_url",
    active: "active",
    maxAttempts: "max_attempts",
    backoffBaseMs: "backoff_base_ms",
    backoffCapMs: "backoff_cap_ms",
    jitterPercent: "jitter_percent",
    signingSecret: "signing_secret",
    failureMode: "failure_mode",
    failuresBeforeSuccess: "failures_before_success",
    failureStatusCode: "failure_status_code",
    simulatedDelayMs: "simulated_delay_ms"
  };
  const entries = Object.entries(fields).filter(([key]) => columns[key]);
  if (!entries.length) return getEndpoint(id);

  const assignments = entries.map(([key], index) => `${columns[key]} = $${index + 2}`);
  const values = entries.map(([key, value]) => key === "signingSecret" ? encryptSecret(value) : value);
  const result = await query(
    `UPDATE webhook_endpoints SET ${assignments.join(", ")}, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return result.rows[0] ? mapEndpoint(result.rows[0], true) : null;
}

export async function createEvent(event) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await insertEventAndOutbox(client, event);
    await client.query("COMMIT");
    return getEvent(result.id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDemoOrder({ customerName, itemName, amountCents, endpoint }) {
  const client = await pool.connect();
  const orderId = `ORD-${nanoid(8).toUpperCase()}`;
  const eventId = nanoid(14);
  const payload = {
    event: "order.created",
    orderId,
    customer: { name: customerName },
    item: { name: itemName, amountCents },
    createdAt: new Date().toISOString()
  };

  try {
    await client.query("BEGIN");
    const event = await insertEventAndOutbox(client, {
      id: eventId,
      endpointId: endpoint.id,
      targetUrl: endpoint.targetUrl,
      payload,
      idempotencyKey: `order:${orderId}`,
      maxAttempts: endpoint.maxAttempts,
      backoffBaseMs: endpoint.backoffBaseMs,
      backoffCapMs: endpoint.backoffCapMs,
      jitterPercent: endpoint.jitterPercent
    });
    await client.query(
      `INSERT INTO demo_orders (id, customer_name, item_name, amount_cents, event_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, customerName, itemName, amountCents, event.id]
    );
    await client.query("COMMIT");
    return {
      order: { id: orderId, customerName, itemName, amountCents },
      event: mapEvent({ ...event, endpoint_name: endpoint.name }, [])
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertEventAndOutbox(client, event) {
  const eventId = event.id || nanoid(14);
  const idempotencyKey = event.idempotencyKey || eventId;
  const result = await client.query(
    `INSERT INTO webhook_events (
      id, endpoint_id, target_url, payload, idempotency_key, status,
      attempt_count, max_attempts, backoff_base_ms, backoff_cap_ms,
      jitter_percent, next_attempt_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', 0, $6, $7, $8, $9, NOW(), NOW(), NOW())
    ON CONFLICT (endpoint_id, idempotency_key) WHERE endpoint_id IS NOT NULL DO NOTHING
    RETURNING *`,
    [
      eventId,
      event.endpointId || null,
      event.targetUrl,
      JSON.stringify(event.payload),
      idempotencyKey,
      event.maxAttempts ?? 3,
      event.backoffBaseMs ?? 1000,
      event.backoffCapMs ?? 8000,
      event.jitterPercent ?? 20
    ]
  );

  if (result.rows[0]) {
    await client.query(
      `INSERT INTO delivery_outbox (event_id, run_number, attempt_number, available_at)
       VALUES ($1, 0, 0, NOW()) ON CONFLICT DO NOTHING`,
      [result.rows[0].id]
    );
    return result.rows[0];
  }

  const existing = await client.query(
    `SELECT * FROM webhook_events WHERE endpoint_id = $1 AND idempotency_key = $2`,
      [event.endpointId, idempotencyKey]
  );
  if (!existing.rows[0]) throw new Error("Could not persist event.");
  return existing.rows[0];
}

export async function listEvents({ search = "", status = "", endpointId = "" } = {}) {
  const values = [];
  const conditions = [];
  if (search.trim()) {
    values.push(`%${search.trim()}%`);
    conditions.push(`(e.id ILIKE $${values.length} OR e.idempotency_key ILIKE $${values.length} OR ep.name ILIKE $${values.length})`);
  }
  if (status) {
    values.push(status);
    conditions.push(`e.status = $${values.length}`);
  }
  if (endpointId) {
    values.push(endpointId);
    conditions.push(`e.endpoint_id = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await query(`
    SELECT e.*, ep.name AS endpoint_name
    FROM webhook_events e
    LEFT JOIN webhook_endpoints ep ON ep.id = e.endpoint_id
    ${where}
    ORDER BY e.created_at DESC
    LIMIT 150
  `, values);

  const attemptsByEvent = await attemptsForEventIds(result.rows.map((event) => event.id));
  return result.rows.map((event) => mapEvent(event, attemptsByEvent.get(event.id) || []));
}

export async function getEvent(id) {
  const result = await query(`
    SELECT e.*, ep.name AS endpoint_name
    FROM webhook_events e
    LEFT JOIN webhook_endpoints ep ON ep.id = e.endpoint_id
    WHERE e.id = $1
  `, [id]);
  if (!result.rows[0]) return null;

  const attempts = await attemptsForEventIds([id]);
  return mapEvent(result.rows[0], attempts.get(id) || []);
}

export async function claimEventForDelivery(id, runNumber) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `UPDATE webhook_events
       SET status = 'delivering', updated_at = NOW()
       WHERE id = $1 AND replay_count = $2 AND status IN ('queued', 'scheduled')
       RETURNING id`,
      [id, runNumber]
    );
    if (!claimed.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const result = await client.query(`
      SELECT e.*, ep.name AS endpoint_name, ep.signing_secret AS endpoint_signing_secret,
        ep.active AS endpoint_active
      FROM webhook_events e
      LEFT JOIN webhook_endpoints ep ON ep.id = e.endpoint_id
      WHERE e.id = $1
    `, [id]);
    await client.query("COMMIT");
    return mapEvent(result.rows[0], []);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAttempt(event, attempt) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO delivery_attempts (
        event_id, run_number, attempt_number, status_code, ok, error,
        latency_ms, scheduled_delay_ms, response_body, signature_algorithm,
        signature_timestamp, started_at, finished_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        event.id,
        event.replayCount,
        attempt.attemptNumber,
        attempt.statusCode,
        attempt.ok,
        attempt.error,
        attempt.latencyMs,
        attempt.delayMs,
        attempt.responseBody,
        attempt.signatureAlgorithm,
        attempt.signatureTimestamp,
        attempt.startedAt,
        attempt.finishedAt
      ]
    );

    let status;
    if (attempt.ok) status = "succeeded";
    else if (attempt.attemptNumber >= event.maxAttempts) status = "failed";
    else status = "scheduled";

    await client.query(
      updateDeliveryAttemptStatusSql,
      [event.id, status, attempt.attemptNumber, attempt.finishedAt, attempt.nextAttemptAt]
    );

    if (status === "scheduled") {
      await client.query(
        `INSERT INTO delivery_outbox (event_id, run_number, attempt_number, available_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [event.id, event.replayCount, attempt.attemptNumber, attempt.nextAttemptAt]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replayEvent(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE webhook_events
       SET status = 'queued', attempt_count = 0, next_attempt_at = NOW(),
         delivered_at = NULL, failed_at = NULL, replay_count = replay_count + 1,
         updated_at = NOW()
       WHERE id = $1 AND status IN ('failed', 'succeeded')
       RETURNING id, replay_count`,
      [id]
    );
    if (!result.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `INSERT INTO delivery_outbox (event_id, run_number, attempt_number, available_at)
       VALUES ($1, $2, 0, NOW()) ON CONFLICT DO NOTHING`,
      [result.rows[0].id, result.rows[0].replay_count]
    );
    await client.query("COMMIT");
    return getEvent(id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordReceiverDelivery({ endpointId, eventId, idempotencyKey, payload }) {
  const result = await query(
    `INSERT INTO receiver_inbox (endpoint_id, event_id, idempotency_key, payload, signature_valid)
     VALUES ($1, $2, $3, $4::jsonb, TRUE)
     ON CONFLICT (endpoint_id, event_id) DO NOTHING
     RETURNING id`,
    [endpointId, eventId, idempotencyKey, JSON.stringify(payload)]
  );
  return result.rowCount === 1;
}

export async function listReceiverInbox() {
  const result = await query(`
    SELECT i.*, ep.name AS endpoint_name
    FROM receiver_inbox i
    JOIN webhook_endpoints ep ON ep.id = i.endpoint_id
    ORDER BY i.received_at DESC
    LIMIT 50
  `);
  return result.rows.map((row) => ({
    id: row.id,
    endpointId: row.endpoint_id,
    endpointName: row.endpoint_name,
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    signatureValid: row.signature_valid,
    receivedAt: iso(row.received_at)
  }));
}

export async function listDemoOrders() {
  const result = await query(`
    SELECT o.*, e.status AS delivery_status
    FROM demo_orders o JOIN webhook_events e ON e.id = o.event_id
    ORDER BY o.created_at DESC LIMIT 20
  `);
  return result.rows.map((row) => ({
    id: row.id,
    customerName: row.customer_name,
    itemName: row.item_name,
    amountCents: row.amount_cents,
    eventId: row.event_id,
    deliveryStatus: row.delivery_status,
    createdAt: iso(row.created_at)
  }));
}

export async function resetDemo() {
  await query("TRUNCATE demo_orders, receiver_inbox, delivery_attempts, delivery_outbox, webhook_events RESTART IDENTITY CASCADE");
}

export async function summary() {
  const result = await query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
      COUNT(*) FILTER (WHERE status = 'delivering')::int AS delivering,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h
    FROM webhook_events
  `);
  const latency = await query(`SELECT COALESCE(ROUND(AVG(latency_ms)), 0)::int AS average_latency_ms FROM delivery_attempts WHERE finished_at > NOW() - INTERVAL '24 hours'`);
  const endpoints = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active FROM webhook_endpoints`);
  const inbox = await query(`SELECT COUNT(*)::int AS total FROM receiver_inbox WHERE received_at > NOW() - INTERVAL '24 hours'`);
  const outbox = await query(`SELECT COUNT(*)::int AS pending FROM delivery_outbox WHERE published_at IS NULL`);

  const row = result.rows[0];
  return {
    total: row.total,
    last24h: row.last_24h,
    counts: { queued: row.queued, scheduled: row.scheduled, delivering: row.delivering, succeeded: row.succeeded, failed: row.failed },
    successRate: row.total ? Math.round((row.succeeded / row.total) * 100) : 0,
    averageLatencyMs: latency.rows[0].average_latency_ms,
    endpoints: endpoints.rows[0],
    receiverDeliveries: inbox.rows[0].total,
    outboxPending: outbox.rows[0].pending
  };
}

export async function endpointAnalytics() {
  const result = await query(`
    SELECT ep.id, ep.name, COUNT(DISTINCT e.id)::int AS events,
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'succeeded')::int AS succeeded,
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'failed')::int AS failed,
      COALESCE(ROUND(AVG(a.latency_ms)), 0)::int AS average_latency_ms,
      COALESCE(MAX(a.latency_ms), 0)::int AS max_latency_ms,
      MAX(e.created_at) AS last_event_at
    FROM webhook_endpoints ep
    LEFT JOIN webhook_events e ON e.endpoint_id = ep.id AND e.created_at > NOW() - INTERVAL '24 hours'
    LEFT JOIN delivery_attempts a ON a.event_id = e.id AND a.finished_at > NOW() - INTERVAL '24 hours'
    GROUP BY ep.id ORDER BY ep.created_at DESC
  `);
  return result.rows.map((row) => ({
    endpointId: row.id,
    name: row.name,
    events: row.events,
    succeeded: row.succeeded,
    failed: row.failed,
    successRate: row.events ? Math.round((row.succeeded / row.events) * 100) : 0,
    averageLatencyMs: row.average_latency_ms,
    maxLatencyMs: row.max_latency_ms,
    lastEventAt: row.last_event_at ? iso(row.last_event_at) : null
  }));
}

async function attemptsForEventIds(eventIds) {
  const attempts = new Map();
  if (!eventIds.length) return attempts;

  const result = await query(`
    SELECT * FROM delivery_attempts WHERE event_id = ANY($1)
    ORDER BY run_number ASC, attempt_number ASC
  `, [eventIds]);
  for (const attempt of result.rows) {
    if (!attempts.has(attempt.event_id)) attempts.set(attempt.event_id, []);
    attempts.get(attempt.event_id).push(mapAttempt(attempt));
  }
  return attempts;
}

function mapEndpoint(row, includeSecret = false) {
  return {
    id: row.id,
    name: row.name,
    targetUrl: row.target_url,
    active: row.active,
    maxAttempts: row.max_attempts,
    backoffBaseMs: row.backoff_base_ms,
    backoffCapMs: row.backoff_cap_ms,
    jitterPercent: row.jitter_percent,
    failureMode: row.failure_mode,
    failuresBeforeSuccess: row.failures_before_success,
    failureStatusCode: row.failure_status_code,
    simulatedDelayMs: row.simulated_delay_ms,
    eventCount: row.event_count ?? 0,
    succeededCount: row.succeeded_count ?? 0,
    failedCount: row.failed_count ?? 0,
    averageLatencyMs: row.average_latency_ms ?? 0,
    lastEventAt: row.last_event_at ? iso(row.last_event_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(includeSecret ? { signingSecret: decryptSecret(row.signing_secret) } : {})
  };
}

function mapEvent(row, attempts) {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    endpointName: row.endpoint_name || "Unassigned destination",
    targetUrl: row.target_url,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    backoffBaseMs: row.backoff_base_ms,
    backoffCapMs: row.backoff_cap_ms,
    jitterPercent: row.jitter_percent,
    nextAttemptAt: row.next_attempt_at ? iso(row.next_attempt_at) : null,
    deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
    failedAt: row.failed_at ? iso(row.failed_at) : null,
    replayCount: row.replay_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    attempts,
    ...(row.endpoint_signing_secret ? { endpointSigningSecret: decryptSecret(row.endpoint_signing_secret) } : {}),
    ...(row.endpoint_active !== undefined ? { endpointActive: row.endpoint_active } : {})
  };
}

function mapAttempt(row) {
  return {
    runNumber: row.run_number,
    attemptNumber: row.attempt_number,
    statusCode: row.status_code,
    ok: row.ok,
    error: row.error,
    latencyMs: row.latency_ms,
    scheduledDelayMs: row.scheduled_delay_ms,
    responseBody: row.response_body,
    signatureAlgorithm: row.signature_algorithm,
    signatureTimestamp: row.signature_timestamp ? Number(row.signature_timestamp) : null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at)
  };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}
