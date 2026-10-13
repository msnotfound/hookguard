import { pool } from "./db.js";
import { enqueueDelivery } from "./queue.js";

let publishing = false;

export async function publishPendingOutbox(limit = 40) {
  if (publishing) return 0;
  publishing = true;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT id, event_id, run_number, attempt_number, available_at
       FROM delivery_outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    for (const row of pending.rows) {
      const delay = Math.max(0, new Date(row.available_at).getTime() - Date.now());
      await enqueueDelivery(row.event_id, row.run_number, row.attempt_number, delay, row.id);
      await client.query("UPDATE delivery_outbox SET published_at = NOW() WHERE id = $1", [row.id]);
    }
    await client.query("COMMIT");
    return pending.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client?.release();
    publishing = false;
  }
}

export async function recoverStaleDeliveries() {
  return pool.query(`
    WITH stale AS (
      UPDATE webhook_events
      SET status = CASE WHEN attempt_count = 0 THEN 'queued' ELSE 'scheduled' END,
        next_attempt_at = NOW(), updated_at = NOW()
      WHERE status = 'delivering' AND updated_at < NOW() - INTERVAL '60 seconds'
      RETURNING id, replay_count, attempt_count
    )
    INSERT INTO delivery_outbox (event_id, run_number, attempt_number, generation, available_at)
    SELECT stale.id, stale.replay_count, stale.attempt_count,
      COALESCE((
        SELECT MAX(existing.generation) + 1 FROM delivery_outbox existing
        WHERE existing.event_id = stale.id
          AND existing.run_number = stale.replay_count
          AND existing.attempt_number = stale.attempt_count
      ), 0), NOW()
    FROM stale
    RETURNING id
  `);
}

export function startOutboxPublisher({ intervalMs = 500, onError = console.error } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await recoverStaleDeliveries();
      await publishPendingOutbox();
    } catch (error) {
      onError(error);
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
