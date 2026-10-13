# HookGuard: Architecture and Computer Science Concepts

This guide explains how HookGuard works from the user interface down to the database and delivery worker. It is intended for someone reading the project, presenting it, or extending it. The descriptions match the implementation in this repository.

## 1. What HookGuard does

HookGuard is a self-hosted webhook delivery service. An application submits an event once; HookGuard stores it, schedules delivery in the background, signs the outbound request, retries temporary failures, and keeps a history that an operator can inspect or replay.

The bundled MiniStore and Notification Receiver make this behavior visible without an external application. A user can place a demo order, follow its event through the system, cause receiver failures in the Failure Lab, and replay an event after correcting the receiver.

The central engineering problem is reliable communication between two independently running services. A receiver can be unavailable, slow, or return an error after the sender has already transmitted a request. HookGuard therefore separates accepting an event from delivering it and records each attempt.

## 2. Architecture at a glance

    MiniStore or external producer
                |
                | HTTP request: create an event
                v
       Express API and dashboard API <------ React + Vite console
                |
                | one PostgreSQL transaction
                v
        webhook_events + delivery_outbox
                |
                | outbox publisher
                v
          Redis + BullMQ queue
                |
                | background job
                v
          Delivery worker
                |
                | timestamped HMAC-signed HTTP POST
                v
       Notification receiver or HTTPS endpoint

PostgreSQL is the durable record of endpoints, events, attempts, outbox work, demo orders, receiver receipts, and service heartbeats. Redis and BullMQ coordinate background delivery, but the database remains the source of truth for event state and delivery history.

The API, worker, and Vite development server are separate processes. Docker Compose provides PostgreSQL and Redis for local development. In a production-style local run, the API also serves the compiled frontend.

| Component | Responsibility |
| --- | --- |
| React + Vite frontend | Operator console for monitoring, endpoint configuration, event inspection, demo orders, failure injection, and API instructions. |
| Express API | Validates requests, authenticates producer submissions, reads dashboard data, and writes events and related records. |
| PostgreSQL | Durable event state, idempotency constraints, retry history, and the transactional outbox. |
| Outbox publisher | Finds committed delivery work and publishes it to BullMQ. It runs alongside the API and worker. |
| Redis + BullMQ | Holds runnable and delayed jobs and coordinates workers. |
| Delivery worker | Claims an event, signs and sends an HTTP request, records the outcome, and schedules a retry if required. |
| Notification Receiver | Verifies HookGuard signatures and stores one accepted receipt per event. |
| MiniStore | Creates a persistent example order and its order-created event. |

## 3. The complete event flow

### 3.1 Accepting an event

An external producer calls **POST /v1/events** with a configured endpoint ID, an event payload, and optionally an idempotency key. The route requires a bearer API key. The JSON body is limited to 1 MB. The dashboard's local APIs provide the same core event functions to the screens.

MiniStore uses a dedicated order route. It creates the order, the webhook event, and the initial outbox record in one PostgreSQL transaction. If any insert fails, the transaction rolls back, so an order cannot be committed without its corresponding event and delivery intent.

For a normal API event, HookGuard also inserts the event and its outbox row in the same transaction. Once PostgreSQL commits, the API returns **202 Accepted**. This means the event has been durably accepted for processing; it does not mean the destination has already received it.

### 3.2 Moving durable work into the queue

The outbox publisher polls rows whose published timestamp is empty. It locks rows using PostgreSQL's **FOR UPDATE SKIP LOCKED** so multiple publishers can work without selecting the same row at the same time. For each row, it creates a BullMQ job and marks the outbox row published.

The job ID is derived from the outbox row ID. This makes repeated publication of the same outbox item safe while BullMQ retains the job. The outbox is important because writing to PostgreSQL and writing to Redis are separate operations; without it, a process crash between those writes could lose the queue handoff.

### 3.3 Claiming and delivering

The worker runs with concurrency four. Before sending a request, it atomically changes an event from **queued** or **scheduled** to **delivering**, provided that the event is still in the job's replay run. If another job already claimed it, or if it belongs to an older replay run, the worker skips it.

The worker serializes the event payload, sets the event and idempotency headers, signs the exact request bytes, and sends an HTTP POST. Redirects are not followed. A configurable timeout aborts a request that takes too long. The worker records the HTTP status, a short response-body excerpt, latency, signature metadata, and any network or timeout error.

### 3.4 Success, retry, and terminal failure

A successful HTTP response marks the event **succeeded**. A non-success response or network error schedules another attempt while the event is below its configured attempt limit. If the limit is exhausted, the event becomes **failed**. In this project, **failed is the retained dead-letter state**: the event and its history remain in PostgreSQL and can be inspected or replayed; a separate BullMQ dead-letter queue is not used.

The attempt result, the updated event state, and any next retry outbox row are committed in one database transaction. Thus, a crash cannot commit a retry state without also recording the retry work that will publish it.

### 3.5 Recovery after a worker crash

An event can remain in **delivering** if a worker process stops after claiming it. The outbox publisher periodically looks for delivery claims older than 60 seconds. It returns those events to a queueable state and creates another outbox row with a new generation. The generation distinguishes recovery work from the original queue handoff.

This recovery may cause the receiver to see the same event again if the original request actually reached it before the worker crashed. That is why HookGuard provides idempotency identifiers and why delivery is described as at least once rather than exactly once.

## 4. Event state and replay history

The main event states are:

    queued -> delivering -> succeeded
    queued -> delivering -> scheduled -> delivering
    queued -> delivering -> failed
    succeeded or failed -> queued (operator starts a replay run)

An event stores its current status, attempt count, retry configuration snapshot, next-attempt time, terminal timestamps, and replay count. Each delivery attempt is a separate row. Attempts include both a **run number** and an **attempt number**.

Replaying a succeeded or failed event increments its run number, resets the current attempt counter, and adds fresh queue work. It does not delete previous attempts. This gives the new run a fresh retry budget while preserving the original timeline for debugging and audit.

| Table | What it represents |
| --- | --- |
| webhook_endpoints | Destination URL, encrypted signing secret, active state, retry settings, and Failure Lab behavior. |
| webhook_events | Accepted payload, destination snapshot, idempotency key, lifecycle status, retry policy snapshot, and replay count. |
| delivery_outbox | Durable intent to publish a particular run and attempt to BullMQ, including its availability time and recovery generation. |
| delivery_attempts | One record per actual HTTP attempt, including response, timing, result, and signing metadata. |
| demo_orders | Orders created through MiniStore and their associated event IDs. |
| receiver_inbox | Successfully accepted demo notifications, uniquely keyed by endpoint and event ID. |
| service_heartbeats | Recent worker liveness timestamps used by the health endpoint. |

The database uses foreign keys, check constraints, a unique index on endpoint plus idempotency key, and indexes for event status, endpoint history, outbox polling, and attempt lookup. Payloads are stored as PostgreSQL JSONB so they remain structured JSON while being queryable by the application.

## 5. Reliability and distributed-systems concepts

### Asynchronous producer-consumer design

The API is the producer and the worker is the consumer. The producer can respond after durable acceptance instead of waiting for an external endpoint. This reduces request latency and keeps remote outages out of the producer's synchronous request path. The queue buffers work while the receiver is slow or unavailable.

### Transactional outbox

PostgreSQL cannot atomically commit a row and a Redis job using one ordinary database transaction. The outbox pattern solves this dual-write problem by committing the event and the intent to queue it together in PostgreSQL. A separate publisher retries the handoff to BullMQ. Stable outbox-derived job IDs and database constraints make repeat publication manageable.

### At-least-once delivery

The system prefers recoverable duplicate delivery over silently losing an accepted event. A worker crash, network timeout, retry, or replay can result in a repeated HTTP request. HookGuard therefore does **not** promise exactly-once delivery or exactly-once business effects.

### Idempotency at two boundaries

Producer idempotency prevents an application retry from creating duplicate HookGuard events: the same endpoint and idempotency key resolve to the existing event. Receiver idempotency handles duplicate deliveries: the bundled receiver stores only one inbox receipt per endpoint and event ID. These solve different problems and both matter in a distributed system.

### Bounded exponential backoff with jitter

Retry delay grows exponentially from the configured base, is capped by the endpoint's maximum delay, and receives a random jitter adjustment. In simplified terms, the delay is based on the smaller of the cap and base multiplied by two to the attempt index, then adjusted by the configured jitter percentage.

Exponential backoff avoids hammering a receiver during an outage. Jitter spreads retries from many events across time, reducing synchronized retry bursts. The maximum attempt count and delay cap bound resource use and recovery time.

### Concurrency control and stale work

The worker's conditional database update is the authoritative event claim. BullMQ coordinates job execution, while PostgreSQL prevents two jobs from successfully claiming the same event state. The replay-run check prevents an old, delayed job from overwriting a newer replay. The outbox publisher's row locks allow competing publishers to divide work safely.

### Fault injection and observability

The Failure Lab can simulate success, temporary failures, persistent failures, HTTP 429 responses, and timeouts. This makes retry and recovery behavior observable without depending on an unreliable external service. Event Explorer shows each attempt, response, latency, and retry delay. Overview and endpoint analytics summarize outcomes, and worker heartbeats help distinguish an idle queue from an offline worker.

## 6. Security concepts

### Producer API authentication

**POST /v1/events** accepts a configured bearer API key (or the documented API-key header). The comparison uses SHA-256 digests and a timing-safe comparison. The local sandbox key is a development convenience, not a production credential.

### HMAC request signatures

For an outbound request, HookGuard computes HMAC-SHA256 using the endpoint's secret over the Unix timestamp, a period, and the exact raw request body. The signature and timestamp travel in headers. The receiver recalculates the digest over the raw bytes, rejects signatures outside a five-minute time window, and compares digest bytes in constant time.

Signing the raw body matters: parsing JSON and serializing it again can change whitespace or field representation and therefore change the bytes. A valid HMAC demonstrates that the request body was produced by someone holding the secret and was not modified in transit. The timestamp narrows the replay window; event-level idempotency handles duplicate business effects.

### Secrets at rest

Endpoint signing secrets are encrypted using AES-256-GCM before storage. The key is derived from **HOOKGUARD_SECRET_KEY**, which must remain stable across restarts or existing secrets cannot be decrypted. The application shows a new secret at endpoint creation or rotation; it does not include it in ordinary endpoint listings. The built-in fallback encryption key is for local development and must be replaced before sharing a deployment.

### SSRF defenses for destinations

External destinations must use HTTPS, cannot contain embedded credentials or URL fragments, and must resolve only to public unicast IP addresses. HookGuard checks DNS results when a destination is configured and checks again when opening the connection, helping defend against DNS rebinding. Redirects are disabled so an allowed public endpoint cannot redirect the worker to a private service.

The worker has a narrow exception for HookGuard's own local demo receiver. That exception is limited to the configured local host, API port, and receiver path. Custom external targets do not get this exception.

### Deployment boundary

The producer API is authenticated, but the dashboard is a single-workspace local demo without user login, team permissions, or billing. CORS is limited to the local Vite origins. Keep the dashboard local or place it behind an appropriate access-control layer before making the service reachable by other users. The project is self-hosted; it does not include cloud deployment or production account management.

## 7. API and product surfaces

| Surface | Main use |
| --- | --- |
| Overview | Event totals, success rate, active work, endpoint condition, recent deliveries, and service health. |
| Endpoints | Add local or HTTPS destinations, tune retry policy, test delivery, pause new intake, resume, and rotate a secret. |
| Event Explorer | Search and filter event history, inspect payloads and attempt timelines, and replay terminal events. |
| Failure Lab | Change simulator behavior and demonstrate retry, timeout, rate-limit, and dead-letter paths. |
| MiniStore | Create an order and its order-created event transactionally. |
| Receiver Inbox | Inspect successfully verified and deduplicated demo notifications. |
| API Quickstart | Find the local API key, copy a cURL submission, review delivery headers, and inspect sample signature-verification code. |

The main integration route is **POST /v1/events**. Dashboard and demo routes include **GET /api/health**, **GET /api/summary**, **GET /api/endpoints**, **POST /api/endpoints**, **GET /api/events**, **GET /api/events/:id**, **POST /api/events/:id/replay**, **GET /api/analytics/endpoints**, **POST /api/store/orders**, and **GET /api/receiver/inbox**. The complete contract is in **docs/openapi.yaml**.

## 8. Running the project

Requirements are Node.js 22.19 or newer, Docker Compose, and available local ports 3000, 5173, 5432, and 6379. From the project root:

    cp .env.example .env
    npm ci
    docker compose up -d
    npm run db:migrate
    npm run dev

Open **http://127.0.0.1:5173**. Development starts the API, worker, and frontend as separate processes. For a production-style local build, run **npm run build** and then **npm start**; the API serves the compiled frontend at **http://127.0.0.1:3000**.

Before sharing the service, set unique values for **HOOKGUARD_API_KEY**, **HOOKGUARD_SECRET_KEY**, and **DEMO_WEBHOOK_SECRET** in the environment. Keep the encryption key backed up and stable. Do not treat the default local credentials as deployment secrets.

## 9. What the system guarantees—and what it does not

HookGuard durably accepts an event before acknowledging it, keeps the delivery and retry history, retries according to bounded endpoint policy, recovers stale worker claims, and exposes terminal failures for replay. The bundled receiver verifies signed requests and demonstrates idempotent receipt storage.

HookGuard does not guarantee exactly-once HTTP delivery, exactly-once side effects, or successful delivery when a receiver remains unavailable. A receiver should validate signatures, reject stale timestamps, and use the event ID or idempotency key when applying business changes. The dashboard has no user authentication, and the project is not a hosted multi-tenant service.

## 10. Key terms

| Term | Meaning in this project |
| --- | --- |
| Webhook | An HTTP request one application sends to notify another application about an event. |
| Producer | The application or MiniStore that submits an event to HookGuard. |
| Consumer / worker | The background process that reads queued work and sends the webhook. |
| Queue | Redis/BullMQ-managed work waiting for a worker, including delayed retry jobs. |
| Outbox | A PostgreSQL record that makes the intent to enqueue work durable alongside the event. |
| Idempotency key | A caller-provided key that makes repeated event submissions map to one stored event. |
| HMAC | A keyed cryptographic digest used here to authenticate and protect the integrity of the request body. |
| Backoff | A growing delay before retrying a failed delivery. |
| Jitter | A random adjustment to retry delay that spreads load over time. |
| Dead-letter state | The retained **failed** event state after the attempt limit is exhausted. |
| Replay run | A new delivery cycle for a previously succeeded or failed event, with the earlier attempts retained. |
| SSRF | Server-side request forgery: tricking a server into making requests to internal or unintended network targets. |

## Related project files

- [README](README.md) — setup instructions, demo sequence, and API summary.
- [Project report](docs/PROJECT_REPORT.md) — report-style overview of objectives, architecture, and evaluation concepts.
- [OpenAPI contract](docs/openapi.yaml) — machine-readable HTTP API description.
- [Backend API](backend/api/server.js) — request routes, validation, and receiver implementation.
- [Delivery worker](backend/worker/worker.js) — queue processing, signing, HTTP delivery, and retry calculation.
- [Event repository](backend/shared/events-repository.js) — PostgreSQL transactions and event lifecycle operations.
