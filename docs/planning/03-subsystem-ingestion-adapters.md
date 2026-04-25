# 03. Subsystem Plan: Ingestion Adapters

## Goal

Implement a unified ingestion pipeline with source-specific adapters that produce one normalized package contract.

## Adapter Strategy

- Adapter codex_v1:
  - Input: exported project package from Codex app
  - Expected payload: file list, runner hint, entry hint, project title, optional metadata
- Adapter chatgpt_v1:
  - Input: uploaded zip or generated file bundle from ChatGPT widget flow
  - Expected payload: file list or archive, optional manifest hints, source conversation metadata

Both adapters output NormalizedCreationPackage.

## NormalizedCreationPackage Contract

- sourceType: codex_v1 | chatgpt_v1
- sourceReference: opaque source id or upload id
- title: string
- runner: client-static | webcontainer
- entry: string
- files: array of { path, contentEncoding, content }
- importMode: direct_files | zip_import | github_import
- metadata: source-safe object with redactable fields
- idempotencyKey: caller-provided or server-derived stable key

## Build Plan

### Phase A: Contract and Validation

1. Define schema and parser with strict validation.
2. Enforce canonical path policy:
- no traversal
- no absolute paths
- no null byte
3. Enforce file count and total bytes caps.
4. Add MIME and extension policy for non-code assets.

Acceptance:
- malformed payloads fail with deterministic error codes
- valid payloads normalize to stable ordering

### Phase B: Adapter Implementations

1. Implement codex_v1 adapter:
- map known Codex fields to normalized contract
- generate deterministic idempotency hash from file map + title + runner
2. Implement chatgpt_v1 adapter:
- support direct file list
- support zip payload handoff
- preserve user-selected entry point when present
3. Add adapter version negotiation for forward compatibility.

Acceptance:
- golden fixtures for both adapters
- no cross-source behavior regressions

### Phase C: Ingestion Execution Paths

Path 1 direct_files:
- POST /capsules/empty
- PUT /capsules/:id/files/:path for each file
- optional compile and publish

Path 2 zip_import:
- POST /import/zip with async option
- poll GET /import/jobs/:id
- optional compile and publish

Path 3 github_import:
- POST /import/github
- accepts HTTPS github.com repository URLs only
- poll GET /import/jobs/:id as needed
- optional compile and publish

Acceptance:
- each path returns unified operation status shape
- operation can resume from persisted state

## Error Taxonomy

- INGEST_INVALID_SCHEMA
- INGEST_UNSUPPORTED_SOURCE_VERSION
- INGEST_PATH_POLICY_BLOCK
- INGEST_FILE_LIMIT_EXCEEDED
- INGEST_IMPORT_JOB_TIMEOUT
- INGEST_UPSTREAM_API_FAILURE
- INGEST_PARTIAL_WRITE_ROLLBACK_REQUIRED

Each error includes:
- retryable
- userSafeMessage
- traceId
- upstreamStatus when applicable

## Rollback and Recovery

- direct_files path:
  - if write fails mid-way, mark operation failed and keep draft for manual recovery
- async import path:
  - if job times out, allow user to resume poll via operationId
- publish path:
  - compile failure does not delete draft
  - publish failure retains staging state diagnostics

## Dependencies

- Auth subsystem (user resolution and token exchange)
- Vibecodr integration subsystem (endpoint wrappers)
- Data and jobs subsystem (operation store)
