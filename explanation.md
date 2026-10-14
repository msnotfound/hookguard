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

For the all-Render portfolio deployment, one free Render web service serves the landing page, dashboard assets, and Express API while running the worker as a second Node process. Both processes share a free Render Postgres database and private free Key Value service. The seeded receiver URL points back to the same public Render web service. The `api/` Vercel adapter remains in the repository for the earlier deployment path, but the Render Blueprint does not use it.

| Component | Responsibility |
| --- | --- |
| React + Vite frontend | Operator console for monitoring, endpoint configuration, event inspection, demo orders, failure injection, and API instructions. |
| Express API | Validates requests, authenticates producer submissions, reads dashboard data, and writes events and related records. |
| PostgreSQL | Durable event state, idempotency constraints, retry history, and the transactional outbox. |
| Outbox publisher | Runs in the worker process, finds committed delivery work, and publishes it to BullMQ. |
| Redis + BullMQ | Holds runnable and delayed jobs and coordinates workers. |
| Delivery worker | Claims an event, signs and sends an HTTP request, records the outcome, and schedules a retry if required. |
| Notification Receiver | Verifies HookGuard signatures and stores one accepted receipt per event. |
| MiniStore | Creates a persistent example order and its order-created event. |
| Render web service | Hosts the built frontend and API, and starts the separate worker process with `npm start`. |

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

The portfolio deployment intentionally has no dashboard login. All visitors share one database and can operate the demo. Production mode applies a Redis-backed limit of 20 mutating requests per minute per IP, allows endpoint creation only for the built-in simulator, and keeps the producer API key out of browser responses. These limits make the public demo suitable for synthetic product exploration, not a real multi-user service. Do not add confidential payloads, production endpoints, or customer secrets. The producer `POST /v1/events` route still requires its separate server-side `HOOKGUARD_API_KEY`.

The API allows its own request origin and the local Vite origins; additional cross-origin frontends can be listed with `HOOKGUARD_ALLOWED_ORIGINS`. In the Render deployment, the public host is accepted as a same-origin request. The Render web service runs `npm start`, which starts the local API server and delivery worker as separate Node processes. Both run the idempotent schema setup at startup, and the worker publishes the outbox and consumes jobs. The Blueprint supplies Postgres, a private Key Value connection, and the public API URL reference.

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

Requirements are Node.js 22.19 or newer, Docker Compose, and available local ports 3000, 5173, 5432, and 6379. From the project root, create `.env` from `.env.example` and set a unique `HOOKGUARD_SECRET_KEY` before the first application start. Keep that key stable while endpoint secrets exist in the database. The README has the full fresh-machine clone and setup steps.

    cp .env.example .env
    npm ci
    docker compose up -d --wait
    npm run db:migrate
    npm run dev

Open **http://127.0.0.1:5173**. Development starts the API, worker, and frontend as separate processes. Stop these processes with Ctrl+C, then stop PostgreSQL and Redis with `docker compose down`; this preserves the database volume. For a production-style local build, run **npm run build** and then **npm start**; the API serves the compiled frontend at **http://127.0.0.1:3000**.

### Public portfolio deployment

The deployed structure separates API and delivery processes inside one web service:

    Browser
      | landing page, dashboard, /api/*
      v
    Render free web service
      |-- API process: Express routes, static assets, receiver
      |-- Worker process: outbox polling, signatures, retries
      |       | BullMQ jobs
      |       v
      |   Private free Render Key Value
      |       ^
      |       | SQL state and outbox
      +---- Render Postgres (free)
      |
      +---- receiver delivery returns to this same public service

The Express app is in `backend/api/app.js`. `backend/api/server.js` adds static-file serving, schema setup, and graceful shutdown. `backend/worker/worker.js` starts the outbox publisher and BullMQ consumer. Render's `npm start` script launches the API and worker as two processes in the same web-service instance. `HOOKGUARD_PUBLIC_API_URL` references the service's `RENDER_EXTERNAL_URL`, so the demo receiver points back to the deployed service rather than localhost.

To deploy, connect the GitHub `main` branch to Render and create a Blueprint using `render.yaml`. It declares one free Node web service, one free Key Value instance, and one free Postgres database in Singapore. Render wires `DATABASE_URL`, `REDIS_URL`, and the public API URL, and generates `HOOKGUARD_SECRET_KEY`, `HOOKGUARD_API_KEY`, and `DEMO_WEBHOOK_SECRET`. The build sets `VITE_PUBLIC_DEMO=true`; the service sets `HOOKGUARD_PUBLIC_DEMO=true` and `PG_POOL_MAX=1`. The API server and worker each run schema setup at startup. Check `/api/health`; it reports healthy after Postgres, Key Value, and a recent worker heartbeat are available.

The public demo has no login. Every visitor shares the dashboard and database, destinations are restricted to the built-in simulator, and mutating requests are rate limited. Use synthetic data only and do not connect production systems.

The free hosting trade-offs affect the demonstrated reliability guarantees. Render allows one active free Postgres database and one active free Key Value instance per workspace. A free web service sleeps after 15 minutes without incoming traffic, and waking it can take about a minute. Free Postgres provides 1 GB, no backups, and expires 30 days after creation. Free Key Value is in-memory only; a restart clears BullMQ jobs and rate-limit data. If a queue restart loses a job after its outbox row has been marked published, an event may remain in `queued` or `scheduled` state. The app only exposes replay for completed or failed events, so this case can need operator repair. Free services have monthly quotas, and excess outbound bandwidth can incur charges. Review Render's [current free-plan terms](https://render.com/docs/free) and workspace usage.

If the older deployment was already created, remove or disable the paid `hookguard-delivery-worker` service. The current Blueprint runs the worker inside the free web service and does not need that separate process on Render.

Before sharing a local service, set unique values for **HOOKGUARD_API_KEY**, **HOOKGUARD_SECRET_KEY**, and **DEMO_WEBHOOK_SECRET** in the environment. Keep the encryption key backed up and stable. Do not treat the default local credentials as deployment secrets.

## 9. What the system guarantees—and what it does not

HookGuard durably accepts an event before acknowledging it, keeps the delivery and retry history, retries according to bounded endpoint policy, recovers stale worker claims, and exposes terminal failures for replay. The bundled receiver verifies signed requests and demonstrates idempotent receipt storage.

HookGuard does not guarantee exactly-once HTTP delivery, exactly-once side effects, or successful delivery when a receiver remains unavailable. A receiver should validate signatures, reject stale timestamps, and use the event ID or idempotency key when applying business changes. The dashboard has no user authentication, and the project is not a hosted multi-tenant service.

## 10. Ten-minute presentation script

This script follows the current 20-slide deck. The time ranges add up to ten minutes and follow the deck's planned pace: one minute for the introduction, one and a half minutes for the literature review, three minutes for methodology, three minutes for results, and one and a half minutes for the close. Speak at a measured pace and use the slide visuals instead of reading every bullet. Slide 20 is a viva backup slide and is not part of the ten-minute talk.

Before presenting, replace `[Guide Name]` on slide 1. Slide 18 is currently blank. Add the future-scope bullets suggested in that part of this script, or remove the blank slide and adjust the last segment's timing.

### Introduction, 0:00 to 1:00

**Slide 1, 0:00 to 0:20**

Good morning. I am Nivedita Dewangan, a B. Tech student in CSE-CTIS at ITM University. My major project is HookGuard, a self-hosted platform for reliable webhook delivery, retry, inspection, and replay.

**Slide 2, 0:20 to 1:00**

Webhooks let one application notify another when something happens. The difficulty is that the receiver may be offline, slow, or may process a request while the sender times out. HookGuard addresses this uncertainty by storing an event before delivery, sending it asynchronously, and keeping an attempt history. The goal is recoverable at-least-once delivery, not a claim of exactly-once processing.

### Literature review, 1:00 to 2:30

**Slide 3, 1:00 to 1:45**

The reliability part of the literature review informed four design choices. The transactional outbox pattern keeps the event and its queue intent in one database transaction. Idempotency keys help prevent duplicate event creation. Bounded exponential backoff with jitter spaces out retries. BullMQ provides runnable and delayed jobs. These references guide the design; they are not experimental results from HookGuard.

**Slide 4, 1:45 to 2:30**

The security and HTTP references informed the other controls. HMAC authenticates the request bytes, timestamps limit the useful lifetime of an old signature, and receiver-side deduplication handles repeated delivery. SSRF guidance leads us to validate external destinations and resolved IP addresses. Finally, HTTP 202 means accepted for processing, not already delivered. These controls are implemented design choices, not a security certification.

### Problem and methodology, 2:30 to 5:30

**Slide 5, 2:30 to 3:00**

The problem is uncertainty during receiver failures. The objectives are to accept events durably, deliver them without holding the producer request open, retry within clear limits, protect outbound requests, and give an operator a history and replay path. The current scope is a local, single-workspace product.

**Slide 6, 3:00 to 3:30**

The implementation has a React and Vite console, an Express API, PostgreSQL, Redis with BullMQ, a separate Node worker, and a signed receiver. PostgreSQL is the source of truth for events and attempts. Redis and BullMQ coordinate work between the publisher and worker.

**Slide 7, 3:30 to 4:30**

Here is the delivery lifecycle. A producer submits JSON with an endpoint and idempotency key. The API validates the request and commits the event with an outbox row in PostgreSQL, then returns 202. The publisher locks pending outbox rows and creates stable BullMQ jobs. A worker claims the current event run, signs the exact body, and sends a timed HTTP request. It then records the response and either completes the event, schedules a retry, or marks it failed. Stale claims can be recovered after a worker interruption.

**Slide 8, 4:30 to 5:00**

The separation of responsibilities is deliberate. PostgreSQL stores endpoints, events, attempts, and outbox intent. Redis holds work that is ready or delayed. The worker performs network delivery. The portfolio deployment has no user login and is a shared demo, with the production API limited to the built-in receiver. It is not a private workspace or multi-tenant service.

**Slide 9, 5:00 to 5:30**

The verification protocol covers the production build, database migrations, service health, and the intended order-to-retry-to-replay behavior. Build, migration, syntax, and health checks have been completed. The full browser-driven recovery scenario has not been rerun, so I will distinguish that remaining check from verified results.

### Results and discussion, 5:30 to 8:30

**Slide 10, 5:30 to 5:55**

The product surface gives an operator an overview, endpoint controls, event search, failure simulation, and demo integrations. The console is intended to make delivery state visible, rather than hiding retries inside a background process.

**Slide 11, 5:55 to 6:20**

The transactional handoff is the main reliability result. An accepted event and its queue intent are committed together. Each attempt is stored separately. Replay creates a new run and keeps the earlier timeline, which helps an operator compare the original failure with recovery.

**Slide 12, 6:20 to 6:45**

Temporary failures use bounded exponential backoff with jitter. If all configured attempts fail, the event remains in the database in the failed state for inspection and replay. Stale worker claims are requeued. Because the original HTTP request may have reached the receiver before a worker failure, duplicate requests remain possible.

**Slide 13, 6:45 to 7:10**

Outbound requests use timestamped HMAC-SHA256 over the timestamp and raw JSON bytes. Endpoint secrets are encrypted at rest. In local development, external destinations require HTTPS, are checked against private or reserved addresses, and are not followed through redirects. The shared public demo has no dashboard login and uses only its built-in receiver.

**Slide 14, 7:10 to 7:45**

The automated tests and production frontend build pass. The all-Render Blueprint is included, but a live deployment still depends on creating the resources in a Render account. The free web service may sleep, the free database expires after 30 days, and the in-memory queue can lose jobs on a Key Value restart. I have not measured throughput or delivery rates, so I do not make performance claims.

**Slide 15, 7:45 to 8:10**

The intended operator workflow starts in MiniStore, where an order and its event are created together. Event Explorer then shows the event state, request, response, latency, and attempt history. Receiver Inbox shows accepted notifications after signature verification and deduplication.

**Slide 16, 8:10 to 8:30**

The discussion is therefore balanced: the architecture and local service checks are in place, while the end-to-end browser scenario still needs a live rerun. The remaining evidence should include the order, induced receiver failure, retry timeline, final receipt, and replay behavior.

### Conclusion and future scope, 8:30 to 10:00

**Slide 17, 8:30 to 9:15**

HookGuard demonstrates durable webhook intake, asynchronous delivery, signed requests, retry, history, and replay. The outbox addresses the database-to-queue dual-write problem. At-least-once delivery means a receiver must deduplicate. The current public deployment design is a shared portfolio demo, with browser validation and live provider setup still outstanding. These limitations define the next steps rather than weakening the core reliability model.

**Slide 18, 9:15 to 9:45**

For future work, I would add dashboard authentication and role-based access, production-grade secret and API-key management, and metrics with alerts. I would also run load and failure-injection tests, then evaluate horizontal worker scaling and high availability for PostgreSQL and Redis. These are proposed extensions, not current features.

Suggested slide 18 bullets to add before presenting:

- Add dashboard authentication, roles, and managed API-key rotation.
- Add metrics, tracing, alerts, load tests, and failure-injection results.
- Evaluate worker scaling and highly available PostgreSQL and Redis deployments.

**Slide 19, 9:45 to 9:50**

The references on this slide informed the reliability, HTTP, and security design choices.

**Closing, 9:50 to 10:00**

Thank you. I am ready to answer questions about the design, its evidence, and its current limitations.

## 11. Viva question and answer bank

The viva is two minutes, so answers should be direct. Start with the concept, connect it to HookGuard, and state a limitation when it matters. The examiner may ask only a few questions; this bank is for preparation. Avoid claiming exactly-once effects, measured throughput, completed browser validation, or production readiness.

### Problem and architecture

**1. What problem does HookGuard solve?**

It makes webhook delivery recoverable when a receiver is unavailable or a request outcome is uncertain. It durably accepts an event, delivers asynchronously, records attempts, and supports retry and replay.

**2. Why use webhooks instead of polling?**

Webhooks let the producer notify the receiver when an event occurs, without the receiver repeatedly polling for changes. The trade-off is that the sender must handle receiver outages, retries, duplicate requests, and authentication.

**3. Why are the API and worker separate processes?**

The API can acknowledge durable acceptance without waiting on a remote receiver. The worker handles slower network calls and retry timing independently, so receiver latency does not occupy the producer request for the full delivery lifecycle.

**4. What is the role of each main technology?**

React and Vite provide the console. Express handles HTTP routes. PostgreSQL stores durable state. Redis and BullMQ coordinate immediate and delayed work. The Node worker sends signed requests, and the receiver verifies them.

**5. Why use PostgreSQL and Redis together?**

PostgreSQL provides durable relational state, transactions, constraints, and queryable history. Redis with BullMQ coordinates runnable and delayed jobs. Redis is not the authoritative record of event history.

**6. What does HTTP 202 mean in this project?**

It means HookGuard has accepted the event for processing after committing it and its outbox intent. It does not mean the destination has received or processed the webhook.

### Persistence, queues, and delivery semantics

**7. What problem does the transactional outbox solve?**

PostgreSQL and Redis cannot be committed atomically in one ordinary transaction. HookGuard stores the event and a durable queue intent together in PostgreSQL, then a publisher transfers that intent to BullMQ.

**8. What happens if the publisher crashes after creating a BullMQ job?**

The outbox row may still appear unpublished and be processed again. The job ID is derived from the outbox row, so repeated publication uses the same stable ID while BullMQ retains that job.

**9. Why is delivery at least once instead of exactly once?**

A worker can send a request successfully and then crash before recording the result. Recovery must retry because it cannot know whether the receiver processed the first request. That can produce duplicates, so receivers must deduplicate business effects.

**10. How do producer idempotency and receiver deduplication differ?**

Producer idempotency prevents repeated API submissions from creating multiple stored events for the same endpoint and key. Receiver deduplication prevents repeated delivery of one event from applying the same business effect more than once.

**11. What are the main event states?**

An event moves from queued to delivering, then to succeeded, scheduled for retry, or failed after the attempt limit. A replay starts a new run for a succeeded or failed event while retaining its earlier attempts.

**12. How does retry backoff work?**

The delay grows exponentially from a configured base, is capped, and gets a random jitter adjustment. The endpoint also sets a maximum number of attempts. Jitter helps avoid many events retrying at the same instant.

**13. What does the failed state represent? Is there a separate dead-letter queue?**

Failed is HookGuard's retained dead-letter state in PostgreSQL. The event and attempts remain available for inspection and replay. The project does not use a separate BullMQ dead-letter queue.

**14. What is `FOR UPDATE SKIP LOCKED` used for?**

The outbox publisher locks rows it is processing and skips rows locked by another publisher. Multiple publishers can divide pending work without waiting on the same rows or publishing the same row simultaneously.

**15. How does the worker avoid two jobs delivering the same current run?**

It conditionally updates the event from queued or scheduled to delivering in PostgreSQL. Only a job that successfully claims that state proceeds. The replay-run check also prevents an older job from taking over a newer replay.

**16. What happens after a worker crashes during delivery?**

An event left in delivering for more than 60 seconds is treated as stale and requeued with a fresh outbox generation. This favors recovery, but the receiver may see a duplicate if it processed the earlier request.

**17. How are duplicate receiver effects prevented in the bundled demo?**

The receiver verifies the signature and stores one receipt per endpoint and event ID. An external receiver should implement equivalent idempotency using the event ID or idempotency key.

### Security

**18. How is an outbound webhook signed?**

HookGuard computes HMAC-SHA256 with the endpoint secret over the Unix timestamp, a period, and the exact raw request body. It sends the timestamp and signature in headers. The receiver recalculates and compares the digest.

**19. Why sign the raw request body?**

Parsing and serializing JSON again can change whitespace or representation, which changes the bytes. Signing the transmitted bytes lets the receiver verify the exact body that arrived.

**20. What does the timestamp add to the signature?**

The receiver rejects signatures outside a five-minute freshness window, reducing the usefulness of captured requests. Event-level deduplication is still needed because freshness checks alone do not prevent a duplicate inside that window.

**21. How are endpoint secrets protected at rest?**

The application encrypts them using AES-256-GCM before storing them. The encryption key comes from `HOOKGUARD_SECRET_KEY` and must remain stable to decrypt existing values. This local demo does not include a managed production key service.

**22. What SSRF defenses are implemented?**

External destinations must use HTTPS, cannot contain credentials or fragments, must resolve only to public addresses, and are checked again when connecting. Redirects are disabled. A narrow exception allows the configured local demo receiver.

**23. Is the dashboard safe to expose to the internet?**

No. The producer API requires a server-side API key. The dashboard has no login and shares one demo database among all visitors. Production limits endpoint destinations to the built-in simulator and rate limits writes, but this still is not suitable for private data or real customer systems.

### Testing, limitations, and future work

**24. How was the project verified?**

The current checks include the automated Node test suite, a production frontend build, database migrations, source syntax checks, and local service health. The full browser-driven order-to-retry-to-replay scenario still needs to be rerun.

**25. What does the Failure Lab demonstrate?**

It can make the local receiver return success, transient or persistent errors, HTTP 429, and timeouts. This provides a controlled way to examine retry and recovery behavior without relying on an external service.

**26. Were throughput or delivery-rate benchmarks performed?**

No. The project has not measured throughput or delivery rate, so it makes no performance claim. Load testing and collecting repeatable measurements are future work.

**27. What is the largest current limitation?**

The product is a shared single-workspace portfolio demonstration without dashboard authentication or multi-tenant permissions. Live provider configuration and browser-driven recovery validation are still outstanding. These are clear next steps before using HookGuard for real workloads.

**28. How could HookGuard be scaled?**

First measure the current system under load. Then evaluate multiple workers, queue concurrency, database connection limits, and high availability for PostgreSQL and Redis. Scaling must preserve event claims, outbox safety, and receiver idempotency.

**29. What future features would you prioritize?**

I would add dashboard authentication and roles, managed secret rotation, operational metrics and alerts, repeatable load and failure tests, and deployment guidance with highly available infrastructure. These are proposed features, not implemented claims.

**30. What is the most important design trade-off?**

HookGuard chooses recoverable at-least-once delivery over silent loss. A retry can duplicate a request, so the receiver must be idempotent. This is safer for event delivery than pretending the system can guarantee exactly-once effects across independent services.

## 12. Key terms

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
