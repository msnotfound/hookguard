import test from "node:test";
import assert from "node:assert/strict";

import { createDemoOrder } from "../backend/shared/events-repository.js";
import { pool } from "../backend/shared/db.js";

test("returns the committed order when a follow-up event read would time out", async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const now = new Date("2026-10-14T08:00:00.000Z");
  let committed = false;
  let followUpReadAttempted = false;
  let insertedEvent;

  pool.connect = async () => ({
    async query(sql, values = []) {
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") {
        committed = true;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("INSERT INTO webhook_events")) {
        insertedEvent = {
          id: values[0],
          endpoint_id: values[1],
          target_url: values[2],
          payload: JSON.parse(values[3]),
          idempotency_key: values[4],
          status: "queued",
          attempt_count: 0,
          max_attempts: values[5],
          backoff_base_ms: values[6],
          backoff_cap_ms: values[7],
          jitter_percent: values[8],
          next_attempt_at: now,
          delivered_at: null,
          failed_at: null,
          replay_count: 0,
          created_at: now,
          updated_at: now
        };
        return { rows: [insertedEvent] };
      }
      return { rows: [] };
    },
    release() {}
  });
  pool.query = async () => {
    followUpReadAttempted = true;
    throw new Error("timeout exceeded when trying to connect");
  };

  try {
    const result = await createDemoOrder({
      customerName: "Alex Morgan",
      itemName: "Studio Headphones",
      amountCents: 12900,
      endpoint: {
        id: "demo-receiver",
        name: "MiniStore notification receiver",
        targetUrl: "https://example.test/receiver",
        maxAttempts: 3,
        backoffBaseMs: 700,
        backoffCapMs: 6000,
        jitterPercent: 20
      }
    });

    assert.equal(committed, true);
    assert.equal(followUpReadAttempted, false);
    assert.equal(result.order.itemName, "Studio Headphones");
    assert.equal(result.event.id, insertedEvent.id);
    assert.equal(result.event.status, "queued");
    assert.equal(result.event.endpointName, "MiniStore notification receiver");
    assert.deepEqual(result.event.attempts, []);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});
