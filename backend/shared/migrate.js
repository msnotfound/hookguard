import { closeDb, query } from "./db.js";
import { config } from "./config.js";
import { encryptSecret } from "./secrets.js";
import { fileURLToPath } from "node:url";

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_url TEXT NOT NULL,
      signing_secret TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
      backoff_base_ms INTEGER NOT NULL DEFAULT 1000 CHECK (backoff_base_ms BETWEEN 100 AND 60000),
      backoff_cap_ms INTEGER NOT NULL DEFAULT 8000 CHECK (backoff_cap_ms BETWEEN 100 AND 300000),
      jitter_percent INTEGER NOT NULL DEFAULT 20 CHECK (jitter_percent BETWEEN 0 AND 50),
      failure_mode TEXT NOT NULL DEFAULT 'success' CHECK (failure_mode IN ('success', 'retry_then_success', 'always_fail', 'rate_limit', 'timeout')),
      failures_before_success INTEGER NOT NULL DEFAULT 2 CHECK (failures_before_success BETWEEN 0 AND 8),
      failure_status_code INTEGER NOT NULL DEFAULT 500 CHECK (failure_status_code BETWEEN 400 AND 599),
      simulated_delay_ms INTEGER NOT NULL DEFAULT 4500 CHECK (simulated_delay_ms BETWEEN 0 AND 10000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT REFERENCES webhook_endpoints(id) ON DELETE SET NULL,
      target_url TEXT NOT NULL,
      payload JSONB NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'scheduled', 'delivering', 'succeeded', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 8),
      backoff_base_ms INTEGER NOT NULL DEFAULT 1000,
      backoff_cap_ms INTEGER NOT NULL DEFAULT 8000,
      jitter_percent INTEGER NOT NULL DEFAULT 20,
      next_attempt_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      replay_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query("ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS endpoint_id TEXT REFERENCES webhook_endpoints(id) ON DELETE SET NULL");
  await query("ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS backoff_base_ms INTEGER NOT NULL DEFAULT 1000");
  await query("ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS backoff_cap_ms INTEGER NOT NULL DEFAULT 8000");
  await query("ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS jitter_percent INTEGER NOT NULL DEFAULT 20");

  await query(`
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL DEFAULT 0,
      attempt_number INTEGER NOT NULL,
      status_code INTEGER,
      ok BOOLEAN NOT NULL,
      error TEXT,
      latency_ms INTEGER NOT NULL,
      scheduled_delay_ms INTEGER NOT NULL DEFAULT 0,
      response_body TEXT,
      signature_algorithm TEXT,
      signature_timestamp BIGINT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL
    );
  `);

  await query("ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS run_number INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS scheduled_delay_ms INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS response_body TEXT");
  await query("ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS signature_algorithm TEXT");
  await query("ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS signature_timestamp BIGINT");

  await query(`
    CREATE TABLE IF NOT EXISTS delivery_outbox (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL DEFAULT 0,
      attempt_number INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query("ALTER TABLE delivery_outbox ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE delivery_outbox DROP CONSTRAINT IF EXISTS delivery_outbox_event_id_run_number_attempt_number_key");
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_outbox_generation ON delivery_outbox(event_id, run_number, attempt_number, generation)`);

  await query(`
    CREATE TABLE IF NOT EXISTS receiver_inbox (
      id BIGSERIAL PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload JSONB NOT NULL,
      signature_valid BOOLEAN NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (endpoint_id, event_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS demo_orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      item_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service_id TEXT PRIMARY KEY,
      service_role TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_service_heartbeats_role_seen ON service_heartbeats(service_role, last_seen_at DESC)`);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status_next_attempt
    ON webhook_events(status, next_attempt_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_delivery_attempts_event_id
    ON delivery_attempts(event_id, run_number, attempt_number);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_delivery_outbox_pending
    ON delivery_outbox(published_at, available_at)
    WHERE published_at IS NULL;
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint_created
    ON webhook_events(endpoint_id, created_at DESC);
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_endpoint_idempotency
    ON webhook_events(endpoint_id, idempotency_key)
    WHERE endpoint_id IS NOT NULL;
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_receiver_inbox_received
    ON receiver_inbox(received_at DESC);
  `);

  await query(
    `INSERT INTO webhook_endpoints (
      id, name, target_url, signing_secret, active, max_attempts,
      backoff_base_ms, backoff_cap_ms, jitter_percent, failure_mode,
      failures_before_success, failure_status_code, simulated_delay_ms
    ) VALUES ($1, $2, $3, $4, TRUE, 3, 700, 6000, 0, 'success', 2, 500, 4500)
    ON CONFLICT (id) DO NOTHING`,
    [
      "demo-receiver",
      "MiniStore notification receiver",
      config.receiverUrl("demo-receiver"),
      encryptSecret(process.env.DEMO_WEBHOOK_SECRET || "whsec_hookguard_demo_only")
    ]
  );

  await query(`
    UPDATE webhook_endpoints
    SET failure_mode = 'success', updated_at = NOW()
    WHERE id = 'demo-receiver'
      AND failure_mode = 'retry_then_success'
      AND updated_at = created_at
  `);

  const plaintextSecrets = await query("SELECT id, signing_secret FROM webhook_endpoints WHERE signing_secret NOT LIKE 'enc:v1:%'");
  for (const endpoint of plaintextSecrets.rows) {
    await query(
      "UPDATE webhook_endpoints SET signing_secret = $2 WHERE id = $1 AND signing_secret = $3",
      [endpoint.id, encryptSecret(endpoint.signing_secret), endpoint.signing_secret]
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate()
    .then(async () => {
      console.log("Database migration complete.");
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exit(1);
    });
}
