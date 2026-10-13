import test from "node:test";
import assert from "node:assert/strict";

import { deliver } from "../backend/worker/delivery.js";
import { verifyWebhook } from "../backend/shared/signatures.js";

function makeEvent(endpointSigningSecret) {
  return {
    id: "evt_test_123",
    attemptCount: 0,
    maxAttempts: 3,
    backoffBaseMs: 1000,
    backoffCapMs: 8000,
    jitterPercent: 20,
    targetUrl: "http://127.0.0.1:3000/receiver/test",
    payload: { event: "test.created", value: 42 },
    idempotencyKey: "test:42",
    endpointSigningSecret
  };
}

function dependencies(onRequest = () => {}) {
  return {
    requestTimeoutMs: 1000,
    validateTargetUrlImpl: async (url) => url,
    createSafeDispatcherImpl: () => ({ close: async () => {} }),
    fetchImpl: async (url, options) => {
      onRequest(url, options);
      return { status: 204, ok: true, body: null };
    }
  };
}

test("deliver returns signature metadata after posting a signed webhook", async () => {
  const secret = "test-signing-secret";
  let request;

  const attempt = await deliver(makeEvent(secret), dependencies((url, options) => {
    request = { url, ...options };
  }));

  assert.equal(attempt.ok, true);
  assert.equal(attempt.signatureAlgorithm, "HMAC-SHA256");
  assert.equal(attempt.signatureTimestamp, Number(request.headers["x-hookguard-timestamp"]));
  assert.equal(
    verifyWebhook(request.body, secret, request.headers["x-hookguard-signature"]).ok,
    true
  );
});

test("deliver reports null signature metadata for an unsigned webhook", async () => {
  const attempt = await deliver(makeEvent(null), dependencies((_url, options) => {
    assert.equal(options.headers["x-hookguard-signature"], undefined);
  }));

  assert.equal(attempt.ok, true);
  assert.equal(attempt.signatureAlgorithm, null);
  assert.equal(attempt.signatureTimestamp, null);
});
