# Alert Manager Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an optional official Alertmanager plus a durable Site Agent relay that uploads real-time alert events and 60-second active-alert snapshots to the cloud API.

**Architecture:** LibreNMS uses its native Alertmanager Transport. Alertmanager sends grouped Webhooks to a Node.js relay; the relay validates and atomically spools deliveries before returning success, drains them through authenticated outbound requests, and periodically reconciles `/api/v2/alerts`. The existing server supplies authenticated prototype cloud ingestion/query endpoints for end-to-end testing.

**Tech Stack:** Node.js ESM and built-in HTTP/filesystem/crypto APIs, Node test runner, Prometheus Alertmanager official container, Docker Compose, OpenAPI 3.1.

---

### Task 1: Cloud alert contracts and tenant-scoped storage

**Files:**
- Create: `src/alert-contracts.mjs`
- Modify: `src/site-agent-service.mjs`
- Modify: `src/site-agent-store.mjs`
- Modify: `src/app-insights.mjs`
- Test: `test-next/alert-cloud-api.test.mjs`

**Steps:**

1. Write failing API tests for `POST /api/v1/site-agent/alert-events`, `POST /api/v1/site-agent/alert-snapshots`, tenant-scoped event/snapshot reads, duplicate delivery IDs, spoofed identity, unknown fields and request-size rejection.
2. Run `node --test test-next/alert-cloud-api.test.mjs`; expect route-not-found failures.
3. Implement strict `schemaVersion: '1.0'` normalizers with no tenant authority in payloads, maximum 100 alerts per event delivery and 5,000 per snapshot.
4. Extend the in-memory prototype store with bounded event receipts, bounded event history and latest sequence-protected alert snapshot. Generate `sourceId/alert/<fingerprint>` server-side.
5. Add authenticated routes and 1 MiB limits.
6. Re-run the focused test; expect all pass.
7. Commit: `feat: add cloud alert ingestion contracts`.

### Task 2: Alertmanager payload normalization

**Files:**
- Create: `src/alertmanager-normalizer.mjs`
- Test: `test-next/alertmanager-normalizer.test.mjs`

**Steps:**

1. Write failing tests using official Webhook and API v2 shaped fixtures for firing, resolved, silenced and inhibited alerts.
2. Require fingerprint, status and RFC3339 timestamps; normalize severity to `critical|warning|info|unknown`.
3. Allow only reviewed labels (`alertname`, `severity`, `instance`, `job`, device/port/rule/source/service/site/cluster identifiers) and annotations (`summary`, `description`, `runbook_url`). Reject control characters and cap counts/lengths.
4. Ensure keys matching token/password/secret/community/credential/authorization cannot pass.
5. Run focused tests and commit: `feat: normalize alertmanager payloads`.

### Task 3: Atomic file queue

**Files:**
- Create: `src/alert-file-queue.mjs`
- Test: `test-next/alert-file-queue.test.mjs`

**Steps:**

1. Write failing tests for atomic enqueue, restart discovery, ordered dequeue, acknowledgement, retry metadata, dead-letter movement and capacity rejection.
2. Implement `tmp`, `pending` and `dead` directories. Write with exclusive temporary file, flush, close and atomic rename into `pending`.
3. Keep a pending file until cloud 2xx; move permanent invalid deliveries to `dead`; preserve files after transient errors.
4. Enforce configurable defaults of 10,000 entries and 256 MiB. Return queue depth, bytes and oldest age.
5. Run focused tests including simulated process re-instantiation; commit: `feat: add durable alert spool`.

### Task 4: Authenticated cloud client and queue drainer

**Files:**
- Create: `src/alert-cloud-client.mjs`
- Create: `src/alert-queue-worker.mjs`
- Test: `test-next/alert-cloud-client.test.mjs`

**Steps:**

1. Write failing tests for Bearer authentication, event/snapshot endpoint selection, request timeout, duplicate success, 429/5xx retry and permanent 400 dead-letter classification.
2. Implement strict HTTP(S) URL configuration with no embedded credentials/query/fragment.
3. Add single-flight draining and bounded exponential backoff with jitter.
4. Verify tokens never appear in error messages or queued payloads.
5. Run focused tests and commit: `feat: upload queued alerts reliably`.

### Task 5: Webhook Relay and active-alert snapshots

**Files:**
- Create: `src/alert-relay-config.mjs`
- Create: `src/alert-relay-service.mjs`
- Create: `alert-relay.mjs`
- Create: `.env.alert-relay.example`
- Modify: `package.json`
- Test: `test-next/alert-relay.test.mjs`

**Steps:**

1. Write failing tests for local Bearer authentication, JSON content type, 1 MiB body limit, enqueue-before-202, health metrics and invalid payload rejection.
2. Implement `/api/v1/alertmanager/webhook` and `/health`; default bind `127.0.0.1:4312`.
3. Poll `${ALERTMANAGER_URL}/api/v2/alerts` every 60 seconds, normalize the complete active set and enqueue a monotonic snapshot.
4. Start one queue worker; implement SIGTERM/SIGINT shutdown without accepting new Webhooks during drain.
5. Add `pnpm alert-relay:start` and syntax checks.
6. Run focused and full tests; commit: `feat: add optional alert relay service`.

### Task 6: Optional Alertmanager deployment bundle

**Files:**
- Create: `deploy/examples/alertmanager/compose.yaml`
- Create: `deploy/examples/alertmanager/alertmanager.yml`
- Create: `deploy/examples/alertmanager/Dockerfile.relay`
- Create: `deploy/examples/alertmanager/README.md`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `module.yaml`
- Test: `test-next/alert-deployment.test.mjs`

**Steps:**

1. Write a structural test that requires an opt-in `alerts` profile, persistent Alertmanager/relay volumes, no hard-coded site IP or credential, and loopback-only published management ports.
2. Pin a reviewed official Alertmanager image tag; do not copy upstream source.
3. Configure Alertmanager Webhook with `send_resolved: true`, grouping defaults and token file; keep user-editable silence/inhibition rules local.
4. Document LibreNMS native Transport configuration, shared external Docker network, startup, health, backup and rollback commands.
5. Run Compose config validation and focused tests; commit: `docs: add optional alertmanager deployment`.

### Task 7: Isolated end-to-end and failure recovery verification

**Files:**
- Create: `test-next/live-alert-manager-smoke.sh`
- Modify: `package.json`
- Modify: `contracts/openapi.yaml`

**Steps:**

1. Start isolated temporary cloud, Relay and official Alertmanager ports without modifying formal 4310.
2. POST a firing alert to Alertmanager API v2 and verify cloud real-time event identity/fingerprint.
3. Verify the 60-second path with a test override interval and compare the active snapshot.
4. Stop cloud, send another alert, verify it remains on disk; restart cloud and verify delivery then acknowledgement.
5. Send a resolved alert and verify resolved event delivery.
6. Assert temporary processes, ports, token files and queue directories are cleaned.
7. Run `pnpm check`, `pnpm test`, OpenAPI parse and the live smoke test.
8. Record CPU, memory, queue size, elapsed time, formal-service health and recovery commands.
9. Commit: `test: verify alert manager end to end`.
