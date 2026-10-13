# HookGuard

HookGuard is a self-hosted webhook delivery console. It accepts events, persists the event and its queue handoff together, delivers from a separate worker, signs each request, retries temporary failures, and keeps an inspectable history for recovery.

The project includes a connected MiniStore producer and a signed Notification Receiver so the utility is visible end to end: place an order, watch the event move through the queue, and see the verified order notification arrive.

## Product screenshot

![HookGuard overview dashboard showing delivery metrics, endpoint health, service status, and the producer-to-receiver flow](./Screenshot%20from%202026-10-13%2022-34-40.png)

*HookGuard Overview with live delivery metrics, endpoint health, pipeline status, and the delivery path.*

## Product workflow

- **Overview** shows event totals, success rate, active work, endpoint health, and recent deliveries.
- **Endpoints** configures destinations, per-endpoint retry limits and backoff, HMAC secrets, event intake pause/resume, test sends, and secret rotation. Paused endpoints reject new submissions while accepted deliveries drain.
- **Event Explorer** searches and filters delivery records, shows every response and retry delay, and replays completed or dead-lettered events as a new run.
- **Failure Lab** injects success, transient 500s, persistent errors, HTTP 429, and timeouts into the local receiver.
- **MiniStore** creates a real demo order and emits `order.created`.
- **Receiver Inbox** verifies the timestamped signature and stores one receipt per event ID, even if HookGuard retries it.
- **API Quickstart** shows a sandbox API key, copyable cURL, request headers, and receiver verification code.

## Run on a new machine

Install Git, Node.js 22.19 or newer with npm, and Docker with the Compose plugin. Start Docker Desktop or the Docker Engine before continuing. Ports 3000, 5173, 5432, and 6379 must be available.

Open a terminal and clone the repository:

```bash
git clone https://github.com/msnotfound/hookguard.git
cd hookguard
node --version
npm --version
docker --version
docker compose version
```

Create the local environment file before starting the application. In PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

```bash
cp .env.example .env
```

Generate a unique encryption key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated value into `.env` as `HOOKGUARD_SECRET_KEY=<generated-value>`. Do this before the first application start, and keep the key unchanged while the database contains endpoint signing secrets. Changing or losing it prevents HookGuard from decrypting those saved secrets. `.env` is local and ignored by Git.

Install dependencies, start PostgreSQL and Redis, wait for their health checks, apply the schema, and launch the API, worker, and frontend:

```bash
npm ci
docker compose up -d --wait
npm run db:migrate
npm run dev
```

Docker Compose `--wait` waits until the containers are running or healthy. [Docker Compose `up` reference](https://docs.docker.com/reference/cli/docker/compose/up/).

Open `http://127.0.0.1:5173` for the dashboard. The API runs at `http://127.0.0.1:3000`, and Vite proxies dashboard requests to it. On startup, the web process can make its first requests before the API has finished listening; if Vite logs `ECONNREFUSED` during that brief window, wait for the `HookGuard API running` message and refresh the page.

To stop the development processes, press **Ctrl+C** in the terminal running `npm run dev`. Stop the database containers with:

```bash
docker compose down
```

This preserves the local database volume. `docker compose down -v` deletes it and should only be used when intentionally resetting all local data.

For a production-style local build, run these from the repository root:

```bash
npm run build
npm start
```

Then open `http://127.0.0.1:3000`.

## End-to-end demonstration

1. Open **MiniStore** and place an order. HookGuard persists the order, webhook event, and outbox job in PostgreSQL.
2. Open **Event Explorer**. Follow the signed request and inspect the HTTP response, latency, and attempt history.
3. Open **Receiver Inbox**. Confirm that the receiver verified the signature and recorded the order notification.
4. In **Failure Lab**, choose `Fail, then recover`, set two failures, and run a scenario. The receiver returns HTTP 500 twice, then accepts the event; HookGuard schedules retries with exponential backoff and jitter.
5. Choose `Always fail` and run another event. It enters the dead-letter state after the configured attempt limit. Change the profile to `Always return 200`, then replay the failed event from Event Explorer. The replay is a new run; its original attempts remain visible.
6. Use **API Quickstart** to submit an event from an external application with the sandbox API key.

The seed endpoint uses a local receiver URL and a demo-only signing secret. It is safe for the bundled local flow. External destinations must use HTTPS, cannot contain credentials, are rejected if they resolve to private or reserved IP ranges, and are not followed through redirects.

## API

### Submit an event

`POST /v1/events` requires the sandbox key as a bearer token and an existing endpoint ID:

```http
POST /v1/events
Authorization: Bearer hg_test_local_hookguard_key
Content-Type: application/json

{
  "endpointId": "demo-receiver",
  "idempotencyKey": "invoice:inv_01HT9K",
  "payload": {
    "event": "invoice.paid",
    "invoiceId": "inv_01HT9K"
  }
}
```

HookGuard responds with `202 Accepted` after the event and outbox record commit. Reusing the same endpoint and idempotency key returns the existing event instead of creating another one. The worker sends `x-hookguard-event-id`, `x-idempotency-key`, `x-hookguard-attempt`, `x-hookguard-timestamp`, and `x-hookguard-signature` headers. The signature is HMAC-SHA256 over `timestamp + "." + raw request body`.

### Dashboard endpoints

- `GET /api/health` — API, Postgres, and Redis status
- `GET /api/summary` — event and queue totals
- `GET /api/endpoints` — configured destinations and health summaries
- `POST /api/endpoints` — register a local simulator or HTTPS destination
- `PATCH /api/endpoints/:id` — update retry or Failure Lab settings, pause, or resume
- `POST /api/endpoints/:id/test` — send a signed test event
- `POST /api/endpoints/:id/rotate-secret` — rotate the signing secret
- `GET /api/events?q=&status=&endpointId=` — searchable delivery history
- `GET /api/events/:id` — event details and attempts
- `POST /api/events/:id/replay` — start a new delivery run for a completed event
- `GET /api/analytics/endpoints` — rolling 24-hour delivery indicators
- `GET /api/receiver/inbox` — accepted demo receiver receipts
- `POST /api/store/orders` — create a MiniStore order and event together
- `GET /api/quickstart` — local sandbox integration values

The OpenAPI contract is in [`docs/openapi.yaml`](docs/openapi.yaml).

## Reliability model

- **Transactional outbox:** the event and queue handoff intent commit in one Postgres transaction. API and worker processes publish pending outbox rows to BullMQ. Stable job IDs make repeat publishing safe; stale delivery claims are recovered through a fresh outbox row after a worker crash.
- **At-least-once delivery:** receivers can see repeated requests after retries or replay. HookGuard does not promise exactly-once effects.
- **Idempotency:** the producer key prevents duplicate event creation for the same endpoint. The sample receiver stores one business receipt per endpoint and event ID.
- **Retry policy:** endpoint settings include bounded attempts, exponential backoff, a cap, and jitter. Events that exhaust their attempts remain available for inspection and replay.
- **Request security:** outbound requests are signed with a per-endpoint secret and timestamp. External targets must resolve to public addresses at registration and connection time; redirects are disabled to reduce SSRF risk.

## Configuration

Copy `.env.example` to `.env`. Set a new `HOOKGUARD_API_KEY`, `HOOKGUARD_SECRET_KEY`, and `DEMO_WEBHOOK_SECRET` before sharing the local service. Keep `HOOKGUARD_SECRET_KEY` stable; it encrypts endpoint signing secrets at rest. The default API key is intentionally exposed in the local quickstart screen and is not suitable for an internet-facing deployment. The dashboard itself is a single-workspace local demo without user login, billing, or team permissions.

## Project structure

```text
backend/api/       Express API and verified demo receiver
backend/worker/    BullMQ delivery worker
backend/shared/    Postgres repository, migrations, outbox, signing, safety
frontend/          React + Vite product console
docs/              Project report and OpenAPI contract
test/              Domain unit tests
```
