import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBackoffMs,
  createEventRecord,
  isDeliverableStatus,
  normalizeTargetUrl,
  validateEventInput
} from "../src/domain.js";

test("calculateBackoffMs doubles delay and caps growth", () => {
  assert.equal(calculateBackoffMs(1, 1000, 5000), 1000);
  assert.equal(calculateBackoffMs(2, 1000, 5000), 2000);
  assert.equal(calculateBackoffMs(3, 1000, 5000), 4000);
  assert.equal(calculateBackoffMs(4, 1000, 5000), 5000);
});

test("validateEventInput rejects missing target URL", () => {
  const result = validateEventInput({ payload: { orderId: "ORD-101" } });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.match(result.error.message, /targetUrl/);
});

test("normalizeTargetUrl accepts absolute HTTP URLs and local receiver paths", () => {
  assert.equal(
    normalizeTargetUrl("/receiver/flaky", "http://127.0.0.1:4100"),
    "http://127.0.0.1:4100/receiver/flaky"
  );
  assert.equal(
    normalizeTargetUrl("https://example.com/webhook", "http://127.0.0.1:4100"),
    "https://example.com/webhook"
  );
});

test("createEventRecord stores idempotency key and starts queued", () => {
  const event = createEventRecord({
    targetUrl: "http://127.0.0.1:4100/receiver/success",
    payload: { orderId: "ORD-101" },
    idempotencyKey: "payment:ORD-101",
    now: "2026-10-13T15:00:00.000Z"
  });

  assert.equal(event.status, "queued");
  assert.equal(event.attemptCount, 0);
  assert.equal(event.maxAttempts, 3);
  assert.equal(event.idempotencyKey, "payment:ORD-101");
  assert.deepEqual(event.attempts, []);
});

test("isDeliverableStatus only allows queued and scheduled work", () => {
  assert.equal(isDeliverableStatus("queued"), true);
  assert.equal(isDeliverableStatus("scheduled"), true);
  assert.equal(isDeliverableStatus("delivering"), false);
  assert.equal(isDeliverableStatus("succeeded"), false);
  assert.equal(isDeliverableStatus("failed"), false);
});
