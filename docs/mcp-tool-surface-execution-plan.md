# MCP Tool Surface Execution Plan

Last updated: 2026-04-24

## Execution Status

Implemented in this repo:

- default `tools/list` remains product-shaped at 29 public tools
- `explain_operation_failure` moved to hidden recovery while staying callable by exact name
- `prepare_publish_package` and `validate_creation_payload` added as no-write creation package validation/prep tools
- `get_runtime_readiness` added as the public blocker/next-action runtime read
- `resume_latest_publish_flow` added so agents can continue from recent account history without asking users for operation ids
- public social read tools added for homepage discovery, post, profile, search, and remix lineage
- post-publish polish helpers added for share copy, launch checklist, social preview, next-step suggestions, and engagement follow-up
- `src/mcp/capabilityCatalog.ts` added with native handler coverage and catalog entries for publish lanes, runtime, pulses, social, ops, and policy
- `/mcp?codemode=search_and_execute` added as an opt-in Code Mode route exposing only `search` and `execute`
- `src/mcp/server.ts` added as the SDK-aligned adapter for native tools, Code Mode tools, prompts, and empty resources
- `src/mcp/handler.ts` now routes MCP tool/prompt/resource behavior through that adapter while preserving the existing hardened gateway transport
- `scripts/measure-mcp-token-surface.mjs` added behind `npm run mcp:measure`
- `scripts/codemode-live-sandbox-regression.mjs` added behind `npm run codemode:live-sandbox`, with `npm run verify:release` as the combined local-plus-staged gate
- transport regression now asserts default visibility, hidden auth challenges, and opt-in Code Mode discovery/search

Kept as catalog-only by design until main Vibecodr API contracts are selected:

- pulse owner lifecycle native tools
- ops/telemetry/cloudflare recovery native tools

The current Code Mode executor is wired for Cloudflare Dynamic Worker execution through `@cloudflare/codemode` when `CODEMODE_WORKER_LOADER` is present, with deterministic fallback available only when explicitly allowed for local/CI-style tests. The remaining non-deployment gate is to run the live sandbox harness against the first staged Worker bucket after the loader binding is provisioned.

## Purpose

This is the targeted execution plan for turning the Vibecodr MCP gateway into a more readable, scalable, reliable, and functional tool surface.

It incorporates the codebase research pass across the main `C:\Users\brade\OneDrive\Desktop\vibecodr` repo with five lenses:

- publish/import/draft/package lifecycle
- runtime/player/sandbox readiness
- pulses/backend/private infrastructure
- social/live-vibe product workflows
- ops/telemetry/admin recovery

The core conclusion is simple: the MCP server should be lane-shaped, not route-shaped.

## North Star

Default MCP discovery should answer: "What can I help the user do with Vibecodr?"

It should not answer: "What internal routes, queues, storage lanes, dispatch primitives, telemetry tables, and maintenance scripts exist?"

Use this split:

- Default visible tools: user-facing product intent.
- Hidden recovery tools: explicit repair, diagnostics, and compatibility.
- Codemode catalog entries: dense capability metadata, schemas, constraints, and low-level operations.
- Prompts/skills: judgment, copy, polish, explanations, and workflow guidance.
- Not MCP: ingestion-only endpoints, internal plumbing, secret/token surfaces, crawler infrastructure, frontend components, and direct admin internals.

## Current State

The gateway currently has:

- 29 default visible MCP tools
- 37 total native handlers when hidden compatibility tools are included
- prompts for guided publish, launch polish, publish recovery, and pulse decisioning
- widget surface removed
- hidden handlers still callable by exact name for compatibility and regression coverage

The pre-execution shape was much better than the old all-tools-visible surface, but it still had one immediate mismatch:

- `explain_operation_failure` was public-visible.
- The runtime/player audit recommends treating it as recovery-only because it requires an operation id and only makes sense after failure.

## Target Native Tool Shape

### Default Visible Tools

These are safe to advertise by default when implemented or already present.

#### Platform And Account

- `get_vibecodr_platform_overview`
- `get_upload_capabilities`
- `get_account_capabilities`
- `get_pulse_setup_guidance`

#### Publish And Package Lanes

Near-term compatibility:

- `quick_publish_creation`
- `get_publish_readiness`
- `list_vibecodr_drafts`
- `get_vibecodr_draft`

Target lane names:

- `import_package` or `bootstrap_package`
- `compile_draft`
- `publish_capsule`
- `get_capsule_state`

The target names matter. In Vibecodr, package bootstrap/import, preview compile, and canonical live publish are distinct. Do not call the bootstrap ingest lane `publish`.

#### Live Vibe Management

- `list_my_live_vibes`
- `get_live_vibe`
- `get_vibe_share_link`
- `get_vibe_engagement_summary`
- `update_live_vibe_metadata`

#### Implemented Social Read Suite

The public read suite is now implemented as native tools with compact summaries:

- `discover_vibes`
- `get_public_post`
- `get_public_profile`
- `search_vibecodr`
- `get_remix_lineage`

Keep this read-first. Do not expose low-level social writes by default.

#### Future Runtime Readiness

Add a product-level read:

- `get_runtime_readiness`

It should return:

- user-facing state
- blocker, if any
- next recommended action
- whether the issue is package, compile, manifest, launch, policy, or unknown

It should not return raw manifests, iframe internals, CSP details, telemetry rows, or admin inspector data by default.

#### Future Pulse Lifecycle

Potential visible owner-facing pulse tools:

- `list_pulses`
- `get_pulse`
- `create_pulse`
- `update_pulse`
- `run_pulse`
- `archive_pulse`
- `restore_pulse`
- `get_pulse_status`

Rules:

- destructive pulse tools must require explicit confirmation
- `run_pulse` is an execution interface, not a source/projection interface
- Pulse removal and resource cleanup tools are intentionally absent until the main Vibecodr platform owns a tested lifecycle contract for that work.
- do not expose pulse source, `.pulse` contents, dispatch tokens, secret inventory, or public projection internals

### Hidden Recovery Tools

These may remain callable by exact name, but should not be advertised in default `tools/list`.

Already-present hidden or should-be-hidden:

- `get_guided_publish_requirements`
- `get_launch_best_practices`
- `list_import_operations`
- `get_import_operation`
- `watch_operation`
- `start_creation_import`
- `compile_draft_capsule`
- `publish_draft_capsule`
- `cancel_import_operation`
- `explain_operation_failure`

Future hidden recovery namespaces:

- `retry_import`
- `recover_publish`
- `rebuild_artifact`
- `get_runtime_diagnostics`
- `triage_error`
- `query_runtime_telemetry`
- `recover_cloudflare_worker`
- `pulse_wfp_complete`
- `get_moderation_visibility_state`

Rules:

- hidden recovery tools may read operational evidence
- hidden recovery tools may require stronger auth, role, or deployment gating
- hidden recovery tools should summarize, not dump raw internal rows
- mutation actions must be confirmation-gated

### Prompts And Skills

Keep these as prompts/skills instead of tools:

- publish/import lane selection
- launch polish
- SEO and social preview copy
- share copy
- profile/about polish
- title and tag suggestions
- remix explanation
- pulse decisioning
- recovery coaching in plain language

Current prompts should continue to exist:

- `publish_creation_end_to_end`
- `polish_public_launch`
- `recover_publish_failure`
- `decide_when_to_use_pulses`

## Codemode Target Shape

Cloudflare-style Code Mode should become the default once parity is proven.

Default Code Mode tools:

1. `search`
2. `execute`

Catalog namespaces:

- `publish`
- `runtime`
- `pulses`
- `social`
- `ops`
- `policy`
- `errors`
- `telemetry`
- `cloudflare`

Catalog entries should include:

- stable id
- title
- purpose
- visibility tier
- auth requirements
- destructive/idempotent/open-world flags
- confirmation requirements
- input schema summary
- output summary
- related native handler
- examples
- "do not expose by default" notes

The catalog should include dense policy/reference material that should not be loaded into every model context:

- runtime launch contract
- sandbox and CSP policy matrix
- bundle constraints
- error catalog
- analytics schema map
- debugging runbooks
- pulse private-backend visibility rules
- source/runtime analysis contract
- starter-template publish gate

## Non-Goals

Do not implement these as public default MCP tools:

- telemetry ingestion endpoints
- CSP report ingestion
- automation event ingestion
- direct `/internal/*` routes
- dispatch route resolution
- dispatch-token mint/revoke
- secret inventory
- pulse source projection
- `.pulse` contents
- sitemaps
- crawler snapshots
- public HTML snapshot generation
- frontend runtime components
- raw `loadRuntimeManifest`
- raw Cloudflare API scripts
- raw D1 SQL execution
- generic admin search rebuilds

## Execution Phases

### Phase 0: Freeze The Contract

Goal: prevent accidental surface growth while refactoring.

Tasks:

- Add a snapshot test for default `tools/list` names.
- Add a snapshot test for hidden-inclusive `getTools({ includeHidden: true })`.
- Add a test proving hidden auth-required tools still produce auth challenges when called by exact name.
- Add a measurement script for default native tools, all native tools, and future Code Mode descriptor size.

Acceptance:

- Public tool count and names are explicit.
- Hidden tool count and names are explicit.
- Size measurement is part of CI or a documented regression command.

Verification:

- `npm run check`
- `npm test`
- `npm run transport:regression`

### Phase 1: Correct Public Visibility

Goal: make default discovery match the user-facing product surface.

Tasks:

- Move `explain_operation_failure` from public to hidden recovery.
- Keep it callable by exact name.
- Update `get_upload_capabilities` and `get_guided_publish_requirements` structured content so recovery lists do not imply default visibility.
- Update docs to list it as hidden recovery.
- Update transport regression assertions.

Acceptance:

- Default `tools/list` excludes operation-failure explanation.
- Explicit `tools/call` for `explain_operation_failure` still follows auth and validation contracts.
- Docs and tests agree.

Verification:

- `npm run check`
- `npm test`
- `npm run transport:regression`
- `npm run security:regression`

### Phase 2: Split Publish Lanes

Goal: stop conflating package bootstrap, compile, and canonical publish.

Tasks:

- Introduce capability ids for:
  - `publish.import_package`
  - `publish.compile_draft`
  - `publish.publish_capsule`
  - `publish.get_capsule_state`
- Keep `quick_publish_creation` as the default orchestration wrapper for first-run users.
- Decide whether the new lane names are native tools, catalog entries first, or hidden aliases until the Vibecodr API mapping is fully verified.
- Update prompt wording so models understand the lane split.
- Avoid naming any bootstrap/import path `publish`.

Acceptance:

- `quick_publish_creation` remains the easy path.
- The internal capability catalog can distinguish import, compile, publish, and state reads.
- Docs explain the difference without exposing low-level backend names.

Verification:

- `npm run check`
- `npm test`
- focused transport regression for tool descriptions and prompt text

### Phase 3: Build Capability Catalog

Goal: prepare for Codemode without rewriting business logic.

Tasks:

- Add `src/mcp/capabilityCatalog.ts`.
- Generate native handler entries from `getTools({ includeOutputSchema: true, includeHidden: true })`.
- Add manual entries for main-Vibecodr concepts not yet native in this repo:
  - runtime readiness
  - pulse lifecycle
  - social reads
  - remix lineage
  - ops/error/telemetry recovery
- Include visibility tier and confirmation requirements.
- Add catalog snapshot tests.

Acceptance:

- Every native tool appears in the catalog.
- Every catalog entry has a visibility tier.
- Public, hidden, prompt, catalog-only, and not-MCP decisions are encoded.

Verification:

- `npm run check`
- catalog snapshot test
- token-surface measurement script

### Phase 4: Add Code Mode Opt-In

Goal: prove search/execute without breaking native MCP clients.

Tasks:

- Add `/mcp?codemode=search_and_execute` as an opt-in route.
- Add `search` against read-only capability catalog.
- Add `execute` against host-owned proxies, not raw secrets or direct environment access.
- Use Dynamic Worker execution when available.
- Provide deterministic in-process test fallback only in test mode.
- Enforce timeouts, output caps, and no arbitrary network access from search.

Acceptance:

- Search finds publish, runtime, pulse, social, and recovery capabilities.
- Execute can reproduce the quick publish happy path.
- Execute cannot access env vars, raw tokens, arbitrary fetch, or hidden tools without the correct catalog/confirmation path.

Verification:

- `npm run check`
- `npm test`
- `npm run transport:regression`
- `npm run security:regression`
- Code Mode-specific sandbox tests
- `npm run verify:release` against the staged Worker after provisioning `CODEMODE_WORKER_LOADER`

### Phase 5: Runtime Readiness Tool

Goal: expose runtime readiness without exposing runtime internals.

Tasks:

- Add `get_runtime_readiness` as a product-level read.
- Base it on existing publish/readiness and Vibecodr API evidence available to this gateway.
- Return summarized state:
  - ready
  - blocked
  - degraded
  - unknown
- Include one recommended next action.
- Keep manifest, iframe, CSP, and telemetry internals out of default output.

Acceptance:

- The tool helps a user understand whether a vibe can launch.
- The tool does not become an admin inspector.
- Hidden diagnostics can later provide deeper evidence.

Verification:

- `npm run check`
- `npm test`
- output schema validation test

### Phase 6: Pulse Owner Lifecycle

Goal: add pulse capability without violating private-backend boundaries.

Tasks:

- Start with catalog entries and prompt guidance.
- Only add visible native tools after confirming main Vibecodr API contracts.
- Confirmation-gate destructive actions.
- Keep source/projection/dispatch/secret/token surfaces out of public discovery.

Acceptance:

- Agents can explain when pulses are appropriate.
- Owner-facing lifecycle is possible without revealing implementation.
- Private backend remains execution-available but not publicly discoverable.

Verification:

- `npm run check`
- auth/confirmation tests for destructive pulse actions if implemented

### Phase 7: Social Read Suite

Goal: let agents help with live social workflows without becoming an admin panel.

Tasks:

- Add read-only catalog entries for feed/post/profile/search/remix.
- Add native tools with stable response summaries.
- Keep moderation and visibility recovery hidden.
- Keep low-level moderation and social mutation out of default discovery.

Acceptance:

- Agents can inspect and explain live vibes, public profiles, and remix lineage.
- Agents cannot perform broad social mutations by default.
- Moderation/admin state remains hidden recovery.

Verification:

- `npm run check`
- read tool schema tests

### Phase 8: Ops Recovery Namespace

Goal: create trusted recovery capability without bloating public discovery.

Tasks:

- Add hidden/catalog namespaces:
  - `errors`
  - `telemetry`
  - `cloudflare`
  - `runtime-diagnostics`
- Route through safe host-owned APIs or scripts only.
- Summarize operational evidence.
- Require explicit trusted/operator mode before live production diagnostics.

Acceptance:

- Operator workflows are possible.
- Public users do not see admin or telemetry tools.
- No raw tokens, raw logs, or raw D1 dumps are exposed.

Verification:

- `npm run security:regression`
- targeted tests for auth gating and redaction

## Implementation Order

Recommended order:

1. Phase 0: freeze and measure current contract.
2. Phase 1: move `explain_operation_failure` to hidden recovery.
3. Phase 3: add capability catalog.
4. Phase 2: encode publish lane split in catalog and prompts.
5. Phase 4: add opt-in Code Mode.
6. Phase 5: add runtime readiness.
7. Phase 6: add pulse catalog/lifecycle.
8. Phase 7: add social reads.
9. Phase 8: add ops recovery namespace.

Reason: contract freeze and visibility correction reduce drift immediately. Catalog then becomes the bridge for all future expansion, including Code Mode.

## Done Criteria

The migration is complete when:

- default native `tools/list` is small and stable
- hidden tools remain callable for compatibility
- prompts carry conversational guidance
- catalog carries dense policy and capability metadata
- Code Mode search/execute can replace broad native discovery
- regression scripts prove auth, transport, visibility, and structured errors
- docs match actual server behavior
