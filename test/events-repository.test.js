import test from "node:test";
import assert from "node:assert/strict";

import { updateDeliveryAttemptStatusSql } from "../backend/shared/events-repository.js";

test("attempt status updates cast lifecycle timestamps to PostgreSQL timestamps", () => {
  assert.match(updateDeliveryAttemptStatusSql, /delivered_at = CASE WHEN \$2 = 'succeeded' THEN \$4::timestamptz ELSE NULL END/);
  assert.match(updateDeliveryAttemptStatusSql, /failed_at = CASE WHEN \$2 = 'failed' THEN \$4::timestamptz ELSE NULL END/);
  assert.match(updateDeliveryAttemptStatusSql, /next_attempt_at = CASE WHEN \$2 = 'scheduled' THEN \$5::timestamptz ELSE NULL END/);
});
