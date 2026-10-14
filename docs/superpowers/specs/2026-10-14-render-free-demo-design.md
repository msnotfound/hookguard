# All-Render Free Demo Deployment Design

## Goal

Deploy HookGuard's portfolio demo from one Render Blueprint using only Render's free web service, Postgres, and Key Value offerings.

## Context

HookGuard has a Vite/React frontend, an Express API that can serve the built frontend, and a BullMQ delivery worker. The existing `npm start` command launches the API and worker together. The current Render Blueprint only describes a separate paid worker, while the public frontend and API are configured for Vercel.

The demo is shared and unauthenticated by design. Its production demo mode restricts webhook destinations to the built-in receiver and rate-limits write routes. It is intended for a brief synthetic-data presentation, not production use.

## Chosen architecture

Use one Render `web` service on the `free` plan. Its build creates the Vite assets with `VITE_PUBLIC_DEMO=true`; its start command runs `npm start`, which launches the Express API and BullMQ worker together. Express serves the landing page and dashboard from `dist`, so the client has one public URL for the complete demo.

Provision a free Render Postgres database and a free Render Key Value instance in the same region as the web service. Blueprint references inject their internal connection URLs into `DATABASE_URL` and `REDIS_URL`; the Key Value instance's external IP allow list is empty so only Render's private network can connect. Configure the web service to bind `0.0.0.0` on Render's `PORT`, use the Render external URL as `HOOKGUARD_PUBLIC_API_URL`, and enable `HOOKGUARD_PUBLIC_DEMO` at runtime. Render generates the encryption, receiver, and producer secrets without storing their values in Git.

Use one service instead of a separate background-worker resource because Render does not provide a free plan for background workers. The combined process may sleep with the free web service, which is acceptable for the one-time demonstration.

## Deployment behavior and limits

- The free web service sleeps after 15 minutes without inbound traffic and can take about a minute to wake. While it is asleep, the worker cannot process jobs.
- Free Render Postgres is limited to 1 GB and expires 30 days after creation. The demo database can be recreated by the Blueprint and the application's startup migration.
- Free Render Key Value has no persistence and may lose queue data when it restarts. A job can disappear after its outbox row is marked published, leaving its event in `queued` or `scheduled`; recover such demo records manually after the restart. The queue is only for the demonstration; it is not a durable record of delivery history.
- The application remains unauthenticated, shared by visitors, and limited to synthetic data and its built-in receiver.

## Files in scope

- `render.yaml`: define the single free web service, free Postgres, free Key Value, build/start commands, generated secrets, and internal service references.
- `backend/shared/config.js` only if the Render external URL cannot be wired directly through a Blueprint self-reference.
- `README.md`: replace the Vercel-plus-paid-worker deployment steps with the all-Render Blueprint flow, environment behavior, demo URL paths, and free-tier limits.
- `explanation.md`: update the hosting architecture and runtime flow to describe the combined Render web process and free managed stores.

## Validation

Validate the Blueprint structure against Render's current schema, build with `VITE_PUBLIC_DEMO=true`, run the project's automated tests, and check the final diff for whitespace errors. Render account provisioning and the live URL are verified only after the Blueprint is created in the user's Render workspace.
