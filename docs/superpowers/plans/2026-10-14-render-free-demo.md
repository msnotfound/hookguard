# All-Render Free Demo Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HookGuard deploy as one free Render portfolio demo with its frontend, Express API, BullMQ worker, Postgres, and Redis-compatible Key Value service.

**Architecture:** A Render free web service builds the Vite frontend and runs the existing `npm start` command, which starts the API and worker in one service. A free Render Postgres database and a private free Key Value service provide the data stores; the Blueprint supplies their URLs, the public Render URL, and generated secrets.

**Tech Stack:** Render Blueprint YAML, Node.js 22, Express, React/Vite, PostgreSQL, Redis, BullMQ, Markdown.

---

### Task 1: Define the complete free Render stack

**Files:**
- Modify: `render.yaml`

- [ ] Replace the paid worker-only resource with one `web` service using the `free` plan, `npm ci && VITE_PUBLIC_DEMO=true npm run build`, `npm start`, `HOST=0.0.0.0`, and `PORT=10000`.
- [ ] Add a free Render Postgres resource and free Render Key Value resource in Singapore. Set Key Value `maxmemoryPolicy: noeviction` and `ipAllowList: []`.
- [ ] Wire `DATABASE_URL`, `REDIS_URL`, and `HOOKGUARD_PUBLIC_API_URL` with Blueprint references. Set `HOOKGUARD_PUBLIC_DEMO=true`, `PG_POOL_MAX=1`, and generate the three server secrets in Render.
- [ ] Parse the Blueprint with Ruby's YAML parser and assert it contains exactly one free web service, one free Postgres database, one free Key Value service, and no worker service.

Run:

```bash
ruby -ryaml -e 'bp=YAML.load_file("render.yaml"); services=bp.fetch("services"); web=services.select { |s| s["type"] == "web" }; kv=services.select { |s| s["type"] == "keyvalue" }; dbs=bp.fetch("databases"); abort "wrong resource layout" unless web.length == 1 && web[0]["plan"] == "free" && kv.length == 1 && kv[0]["plan"] == "free" && dbs.length == 1 && dbs[0]["plan"] == "free" && services.none? { |s| s["type"] == "worker" }; app=web[0]; env=app.fetch("envVars").to_h { |entry| [entry["key"], entry] }; abort "wrong web configuration" unless app["region"] == "singapore" && app["startCommand"] == "npm start" && env["HOST"]["value"] == "0.0.0.0" && env["PORT"]["value"].to_s == "10000" && env["HOOKGUARD_PUBLIC_API_URL"]["fromService"]["envVarKey"] == "RENDER_EXTERNAL_URL" && env["DATABASE_URL"]["fromDatabase"]["property"] == "connectionString" && env["REDIS_URL"]["fromService"]["property"] == "connectionString"; abort "wrong queue configuration" unless kv[0]["region"] == "singapore" && kv[0]["maxmemoryPolicy"] == "noeviction" && kv[0]["ipAllowList"] == []; abort "wrong database region" unless dbs[0]["region"] == "singapore"; puts "Render Blueprint structure ok"'
```

Expected: `Render Blueprint structure ok`. Review the parsed resource definitions against Render's current [Blueprint YAML reference](https://render.com/docs/blueprint-spec); Render's Dashboard performs the authoritative schema validation when deploying the Blueprint.

### Task 2: Document Render setup and free-tier behavior

**Files:**
- Modify: `README.md`
- Modify: `explanation.md`

- [ ] Replace Vercel-plus-paid-worker setup instructions with Render Blueprint creation from the GitHub `main` branch.
- [ ] Explain the generated secret values, the single public URL, `/app`, `/api/health`, and the wait for the worker heartbeat after cold start.
- [ ] Document that this is a shared, unauthenticated synthetic-data demo; include the free web sleep, free Postgres expiry, and volatile Redis queue limitations.
- [ ] Explain that updating a Blueprint does not remove an already-created paid worker, so a user who deployed the older worker must delete or suspend it separately.
- [ ] Update architecture and presentation explanation to describe the combined Render service and managed free data stores.

### Task 3: Verify and commit

**Files:**
- Verify: `render.yaml`, `README.md`, `explanation.md`

- [ ] Run `npm test` and confirm the full test suite passes.
- [ ] Run `VITE_PUBLIC_DEMO=true npm run build` and confirm Vite creates `dist/` successfully.
- [ ] Run `git diff --check` and review the complete diff, ensuring PowerPoint files remain untracked and excluded.
- [ ] Commit only the Render Blueprint and documentation changes with a focused commit message.

The Render account deployment itself is completed by creating the Blueprint in the user's Render workspace; a public URL cannot be confirmed from local tests.
