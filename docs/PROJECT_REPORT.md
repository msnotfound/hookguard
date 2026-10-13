# HookGuard Project Report

## Abstract

HookGuard is a self-hosted webhook delivery product for applications that need to send events to another service and recover when the destination is slow or unavailable. It accepts events over an authenticated API, records them in PostgreSQL, publishes delivery work through a transactional outbox to Redis/BullMQ, and sends signed requests from a separate worker. The dashboard exposes endpoint health, event history, retry attempts, and replay.

A MiniStore and signed Notification Receiver make the system demonstrable as a complete product flow. The Failure Lab injects transient HTTP errors, persistent errors, rate limits, and timeouts into the local receiver.

## Problem statement

An application that sends a webhook synchronously can lose the event when the destination is unavailable, and it has little evidence of what happened. Retrying in the request path slows the producer and still leaves recovery logic scattered through application code. HookGuard separates event acceptance from delivery and records each delivery attempt so a developer can observe and recover failures.

## Objectives

- Accept and validate events without waiting for the destination.
- Persist the event and intent to enqueue it atomically.
- Deliver asynchronously through a separate worker process.
- Sign requests and let receivers verify authenticity and freshness.
- Retry transient failures with bounded exponential backoff and jitter.
- Retain terminal failures for inspection and manual replay.
- Demonstrate normal delivery, transient recovery, and dead-letter recovery through a connected example.

## System architecture

```text
MiniStore / external producer
            |
            v
      Express API  <---- dashboard
            |
            v
    PostgreSQL transaction
     event + outbox record
            |
            v
   Outbox publisher ----> Redis / BullMQ
                              |
                              v
                       Delivery worker
                              |
                  signed HTTPS POST request
                              |
                              v
                  Notification receiver
                    verify + deduplicate
```

The API and worker are separate processes in one codebase. PostgreSQL stores endpoints, events, outbox rows, attempts, demo orders, and receiver receipts. Redis and BullMQ coordinate background work and delayed retries. Docker Compose supplies PostgreSQL and Redis for local development.

## Product areas

| Screen | Purpose |
| --- | --- |
| Overview | Event totals, success rate, active queue, endpoint health, recent activity, and system path. |
| Endpoints | Destination setup, retry policy, HMAC signing, test sends, pause/resume, and secret rotation. |
| Event Explorer | Search and filter events, inspect payloads and attempts, and replay terminal events. |
| Failure Lab | Configure controlled receiver success, transient and persistent failures, 429 responses, and timeouts. |
| MiniStore | Create a persistent demo order and emit `order.created`. |
| Receiver Inbox | Show successful signed receipts and demonstrate receiver-side idempotency. |
| API Quickstart | Provide a sandbox API key, cURL example, delivery headers, and signature verifier. |

## Event lifecycle

```text
queued -> delivering -> succeeded
queued -> delivering -> scheduled -> delivering
queued -> delivering -> failed
failed/succeeded -> queued (new replay run)
```

The API inserts a webhook event and its outbox row within one database transaction. API and worker processes claim pending outbox rows and publish them to BullMQ. The worker claims eligible events, sends one signed request, and commits the attempt result and any next retry outbox row together. A periodic recovery pass returns delivery claims older than 60 seconds to the outbox so a worker crash cannot leave an event stuck in `delivering` forever.

Attempts include a run number. Manual replay starts a new run and resets that run's attempt counter, while retaining the previous run's timeline. This keeps retry limits meaningful after replay and preserves the audit trail.

## Security and delivery semantics

- HookGuard signs the Unix timestamp and exact raw request body with HMAC-SHA256.
- Endpoint signing secrets are encrypted at rest with AES-256-GCM; the encryption key must remain stable across restarts.
- The receiver rejects missing, stale, malformed, or incorrect signatures using constant-time digest comparison.
- External destination URLs require HTTPS, cannot include credentials, resolve only to public unicast addresses, and do not follow redirects.
- Producer API requests use a bearer API key. The bundled key is a local sandbox value shown in the Quickstart screen; the dashboard has no user authentication and should remain local or behind an appropriate access layer.
- Delivery is **at least once**. Network failures and replays can result in duplicate requests. Receiver code must use the event ID or idempotency key to avoid duplicate business effects.
- The transactional outbox makes queue publication recoverable. It does not make the HTTP side effect exactly once.

## Reliability concepts demonstrated

| Concept | Implementation |
| --- | --- |
| Producer-consumer separation | Express accepts events while BullMQ workers deliver them independently. |
| Transactional outbox | Event and enqueue intent are committed together; publishers safely retry with stable job IDs. |
| At-least-once delivery | Queue recovery, retries, and replay may send duplicates. |
| Idempotency | Producer keys suppress duplicate event creation; the receiver stores one receipt per event ID. |
| HMAC authentication | Timestamped HMAC-SHA256 protects payload integrity and limits replay age. |
| Exponential backoff with jitter | Endpoint policy controls attempt count, base delay, cap, and jitter percentage. |
| Dead-letter recovery | Exhausted events remain queryable and replayable. |
| Fault injection | Failure Lab controls response codes and receiver delay. |
| SSRF controls | HTTPS-only external targets, private address rejection, connection-time address checks, and disabled redirects. |

## Demonstration sequence

1. Place an order in MiniStore.
2. Observe the created event in Event Explorer and the accepted order in Receiver Inbox.
3. Configure Failure Lab to return HTTP 500 twice, then succeed, and inspect the retry delays.
4. Configure persistent failure until the event reaches dead letter.
5. Restore success and replay the event while preserving the original attempts.
6. Submit an event through the bearer-authenticated API quickstart.

## Local setup

See the root README for installation and run commands. The stack is intentionally self-hosted and bounded for a student major project. It does not include cloud deployment, billing, multi-user accounts, team permissions, a custom message broker, or a promise of exactly-once effects.
