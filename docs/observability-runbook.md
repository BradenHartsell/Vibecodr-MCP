# Observability Runbook

## Telemetry Surfaces

- Public health summary:
  - `GET /health/observability`
- Authenticated summary with recent filtered events:
  - `GET /api/observability/summary`
- Active alert payload:
  - `alerts[]` with `severity`, `code`, `message`, `details`
  - `alertCount` on `GET /health/observability`
- Request correlation:
  - response header `x-trace-id`
  - JSON error field `traceId`
  - tool structured error field `errorId`

## Structured Event Categories

- `http.request`
- `auth.audit`
- `auth.audit.failure`
- `tool.call`
- `tool.call.failure`
- `operation.lifecycle`
- `operation.lifecycle.failure`
- `upstream.request`
- `upstream.request.failure`

## Core Metrics

- `imports_started_total`
- `imports_completed_total`
- `imports_failed_total`
- `import_stage_duration_ms`
- `compile_failures_total`
- `publish_failures_total`
- `auth_challenge_total`
- `auth_failure_total`
- `duplicate_idempotency_hits_total`
- `http_requests_total`
- `http_request_latency_ms`
- `upstream_requests_total`
- `upstream_request_latency_ms`
- `tool_calls_total`

## Triage Flows

### Import stuck in `waiting_on_import_job`

1. Call `get_import_operation` and verify `importJobId`, `traceId`, and latest diagnostics.
2. Check `operation.lifecycle` and `upstream.request` events for the same `operationId`.
3. If upstream polling is healthy but still pending, continue with `watch_operation`.
4. If upstream requests are failing or timing out, cancel and rerun the import path.

### Publish failures spike

1. Inspect `publish_failures_total` and `upstream_requests_total` for `/capsules/:id/publish`.
2. Filter recent events for `operation.lifecycle.failure` with `errorCode=PUBLISH_FAILED`.
3. Compare upstream status distribution for publish and metadata patch calls.
4. If failures are source-specific, disable the affected feature flag and continue read-only paths.

### Auth challenge loop

1. Inspect `auth_challenge_total` and `auth_failure_total`.
2. Verify callback URI, Clerk discovery endpoints, and `vc_session` cookie issuance.
3. Compare `auth.audit.failure` events with `tool.call.failure` and `tool.call` challenge events.
4. If callback is healthy but session is not persisting, inspect cookie security and app base URL alignment.

## Load Check Notes

- Cloudflare rate limiting is keyed per client identity.
- For synthetic rate-limit verification, reuse one persistent HTTP session or cookie jar.
- Stateless one-off requests can distribute across identities and under-report `429` behavior.

## Regression Gate

- Run `npm run security:regression` before production deploys and gateway release checks.
- The regression gate validates:
  - path traversal and malformed package rejection
  - request body size enforcement
  - OAuth challenge and failure telemetry
  - structured MCP tool errors with `errorId`
  - observability summary contract and alert generation
