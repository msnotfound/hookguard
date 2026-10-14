import test from "node:test";
import assert from "node:assert/strict";

import { isLocalReceiverUrl } from "../backend/shared/target-safety.js";

test("local simulator URLs accept the API function path used by Vercel", () => {
  assert.equal(isLocalReceiverUrl("http://127.0.0.1:3000/api/receiver/delivery/ep_demo"), true);
});

test("local simulator URLs retain support for the existing local receiver path", () => {
  assert.equal(isLocalReceiverUrl("http://127.0.0.1:3000/receiver/ep_demo"), true);
});

test("local simulator URL validation rejects unrelated local paths", () => {
  assert.equal(isLocalReceiverUrl("http://127.0.0.1:3000/api/summary"), false);
});
