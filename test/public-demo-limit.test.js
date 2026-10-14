import test from "node:test";
import assert from "node:assert/strict";

import { createIpRateLimiter } from "../backend/shared/rate-limit.js";

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("public demo write limit blocks excess requests without storing a raw IP", async () => {
  const redisKeys = [];
  let count = 0;
  const redis = {
    async eval(script, keyCount, key, ttl) {
      redisKeys.push({ script, keyCount, key, ttl });
      count += 1;
      return count;
    }
  };
  const limiter = createIpRateLimiter({ redis, namespace: "public-demo", limit: 1, windowSeconds: 60 });
  const req = { ip: "203.0.113.42" };
  const first = responseRecorder();
  let continued = false;

  await limiter(req, first, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(first.headers["RateLimit-Remaining"], "0");

  const second = responseRecorder();
  await limiter(req, second, () => { throw new Error("limited requests must not continue"); });
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error.code, "rate_limit_exceeded");
  assert.equal(second.headers["Retry-After"] > 0, true);
  assert.equal(redisKeys[0].key.includes(req.ip), false);
  assert.match(redisKeys[0].key, /^public-demo:[a-f0-9]{24}:\d+$/);
  assert.equal(redisKeys[0].keyCount, 1);
  assert.equal(redisKeys[0].ttl, 120);
});
