import { Worker } from "bullmq";
import { query } from "../shared/db.js";

import { config } from "../shared/config.js";
import { closeDb } from "../shared/db.js";
import { claimEventForDelivery, recordAttempt } from "../shared/events-repository.js";
import { createRedisConnection } from "../shared/redis.js";
import { closeQueue } from "../shared/queue.js";
import { migrate } from "../shared/migrate.js";
import { startOutboxPublisher } from "../shared/outbox-publisher.js";
import { deliver } from "./delivery.js";

const connection = createRedisConnection();

await migrate();
const heartbeatId = `worker-${process.pid}`;
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.error("Worker heartbeat:", error.message)), 5000);
heartbeatTimer.unref?.();
const stopOutboxPublisher = startOutboxPublisher({ onError: (error) => console.error("Outbox publisher:", error.message) });

const worker = new Worker(
  config.queueName,
  async (job) => {
    const event = await claimEventForDelivery(job.data.eventId, job.data.runNumber);
    if (!event) return { skipped: true };

    const attempt = await deliver(event);
    await recordAttempt(event, attempt);
    return { eventId: event.id, runNumber: event.replayCount, attemptNumber: attempt.attemptNumber, ok: attempt.ok };
  },
  { connection, concurrency: 4 }
);

worker.on("completed", (job, result) => {
  console.log(JSON.stringify({ level: "info", message: "delivery_attempt_finished", jobId: job.id, result }));
});
worker.on("failed", (job, error) => {
  console.error(JSON.stringify({ level: "error", message: "delivery_job_failed", jobId: job?.id, error: error.message }));
});

console.log("HookGuard delivery worker started.");
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  clearInterval(heartbeatTimer);
  await query("DELETE FROM service_heartbeats WHERE service_id = $1", [heartbeatId]).catch(() => {});
  stopOutboxPublisher();
  await worker.close();
  await connection.quit();
  await closeQueue();
  await closeDb();
  process.exit(0);
}

async function heartbeat() {
  await query(
    `INSERT INTO service_heartbeats (service_id, service_role, last_seen_at)
     VALUES ($1, 'worker', NOW())
     ON CONFLICT (service_id) DO UPDATE SET last_seen_at = NOW()`,
    [heartbeatId]
  );
}
