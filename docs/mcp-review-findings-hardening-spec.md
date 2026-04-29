# MCP Review Findings Hardening Spec

Last updated: 2026-04-24

## Purpose

This spec turns the six review findings into durable MCP gateway requirements. It is intentionally more explicit than a bugfix checklist: each finding defines the product behavior, server contract, Code Mode behavior, tests, and acceptance gates needed to keep fresh zero-context models from guessing, over-writing, or stalling.

The MCP gateway must remain small in default discovery while still being understandable to clients that only read `initialize`, `tools/list`, and individual tool descriptors. Code Mode should reduce token load by moving dense detail behind search, but it must not remove the exact calling detail needed to execute safely.

## Primary References

- Cloudflare Code Mode portal guidance: https://developers.cloudflare.com/changelog/post/2026-03-26-mcp-portal-code-mode/
- Cloudflare Codemode Agents API: https://developers.cloudflare.com/agents/api-reference/codemode/
- Cloudflare MCP server examples and Code Mode positioning: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
- MCP schema `initialize` result and `instructions`: https://modelcontextprotocol.io/specification/draft/schema
- Existing migration plan: `docs/cloudflare-codemode-migration-plan.md`
- Existing execution plan: `docs/mcp-tool-surface-execution-plan.md`

## Current Code Owners

- MCP transport and initialize contract: `src/mcp/handler.ts`
- Native tools and schemas: `src/mcp/tools.ts`
- Capability catalog: `src/mcp/capabilityCatalog.ts`
- Code Mode search/execute: `src/mcp/codeMode.ts`
- Dynamic Worker runtime adapter: `src/mcp/codeModeRuntime.ts`
- SDK-aligned adapter: `src/mcp/server.ts`
- Transport regression: `scripts/mcp-transport-regression.mjs`
- Token surface measurement: `scripts/measure-mcp-token-surface.mjs`
- Live sandbox regression: `scripts/codemode-live-sandbox-regression.mjs`
- Tool-surface tests: `test/mcpToolSurface.test.ts`
- Worker/MCP integration tests: `test/worker.test.ts`

## Non-Negotiable Product Rules

1. Destructive publish and metadata actions require server-enforced confirmation, not descriptor-only guidance.
2. A zero-context MCP client must receive enough cold-start guidance from `initialize.instructions` to choose the safe first step.
3. Code Mode search must support compact discovery and exact detail lookup. A compact result alone is not enough.
4. Code Mode Dynamic Worker execution and local fallback must accept the same top-level fields and produce equivalent behavior.
5. Public tool names must match their usable scope. If a readiness tool can read operations, drafts, and live vibes, the implementation must actually support all three.
6. High-value workflow guidance must be reachable by fresh models through at least one guaranteed path: initialize instructions, public safe read, prompt, or exact Code Mode detail.

## Finding 1: Native Publish Is Not Confirmation-Gated

### Problem

`quick_publish_creation` is public and destructive. If the schema only requires `sourceType` and `payload`, a fresh model can publish too early by treating descriptor guidance as sufficient confirmation.

### Target Behavior

`quick_publish_creation` must reject every write attempt unless `confirmed: true` is present. The rejection must happen before payload adaptation, import creation, compile, publish, thumbnail processing, telemetry side effects beyond the rejection event, or any Vibecodr API write.

### Server Contract

- `quick_publish_creation.inputSchema` includes `confirmed`.
- `confirmed` should be documented as required for execution even if JSON Schema keeps it optional to support graceful confirmation prompts.
- `callTool("quick_publish_creation")` must call a shared confirmation guard before side effects.
- The guard returns structured content with:
  - `confirmationRequired: true`
  - `toolName`
  - `action`
  - `userMessage`
  - `requiredArgument: "confirmed"`
- `publish_draft_capsule`, `update_live_vibe_metadata`, future pulse mutations, cancellation, archive, restore, and any Code Mode mutating capability use the same guard pattern. Pulse lifecycle removal and cleanup authority stay out of MCP planning until the main platform owns the contract.

### Tests

- Native call without `confirmed` returns confirmation-required structured content.
- Native call with `confirmed: false` returns confirmation-required structured content.
- Native call with `confirmed: true` reaches the mocked import/publish path.
- Rejection does not call import service, Vibecodr client writes, thumbnail upload, or publish operations.
- Transport regression asserts the public descriptor includes confirmation guidance.
- Code Mode execute rejects `native.quick_publish_creation` without top-level `confirmed: true`.

### Acceptance Gate

`npm run check`, `npm test`, and `npm run transport:regression` pass. A targeted test must prove there is no write before confirmation.

## Finding 2: Cold-Start Guidance Is Not Guaranteed

### Problem

Fresh clients may only consume `initialize` and `tools/list`. If the operating playbook only exists in optional prompts or hidden/internal tools, a model with no Vibecodr context will see descriptors without workflow rules.

### Target Behavior

The `initialize` result must include server-level `instructions` that describe the minimum safe workflow. These instructions should be concise and cross-tool, not a copy of tool descriptions.

### Server Contract

`initialize.result.instructions` must cover:

- Vibecodr product intent: publish, inspect, polish, share, remix, and understand vibes.
- Safe first reads: `get_upload_capabilities` or `publish_creation_end_to_end`.
- Confirmation rule: never make a vibe live, update live metadata, publish a draft, cancel an operation, or perform destructive pulse actions without explicit confirmation.
- Lane split: import/package bootstrap, compile, canonical publish, runtime readiness, post-publish polish.
- Recovery discipline: use recovery tools only after failure or explicit diagnostics request.
- Code Mode discipline: use `search`, request exact capability detail, then `execute`; catalog-only entries are not callable.

### Tests

- `initialize` response includes `instructions`.
- Instructions mention confirmation, safe first read, recovery-only behavior, and Code Mode detail lookup.
- Transport regression covers native and Code Mode initialize paths.
- Instructions are present for supported protocol versions.

### Acceptance Gate

Transport regression proves instructions are returned by the real MCP HTTP path, not just by a unit-level helper.

## Finding 3: Code Mode Saves Tokens But Drops Required Calling Detail

### Problem

Compact catalog entries save tokens, but if they omit schemas, argument summaries, examples, and execution status, fresh models will guess exact native arguments during `execute`.

### Target Behavior

Code Mode search must support two levels:

1. Compact discovery: short result list with id, title, purpose, flags, and execution status.
2. Exact detail: lookup by `capabilityId` returns input schema, output schema or summary, examples, confirmation requirements, execution status, and native tool mapping when callable.

### Catalog Contract

Every capability entry includes:

- `id`
- `namespace`
- `title`
- `purpose`
- `visibility`
- `kind`
- `executionStatus`
- `authRequired`
- `destructive`
- `idempotent`
- `confirmationRequired`
- `keywords`
- `notes`

Callable native capabilities additionally include:

- `nativeToolName`
- exact `inputSchema`
- exact `outputSchema` when available
- at least one example for destructive or high-ambiguity capabilities

Catalog-only capabilities must say why they are not executable and what main Vibecodr API contract is needed before they become callable.

### Code Mode Search Contract

- `search({ query })` returns compact entries.
- `search({ capabilityId })` returns exact detail for one capability.
- Exact detail for callable capabilities includes enough information for a model to construct `execute({ capabilityId, arguments, confirmed })`.
- Exact detail for catalog-only entries includes `executionStatus: "catalog_only"` and must not imply the capability is callable.

### Tests

- All native tools appear in the catalog.
- Every native catalog entry has exact input schema.
- Destructive entries have `confirmationRequired: true`.
- Exact detail for `native.quick_publish_creation` includes `confirmed` in schema and an example with `confirmed: true`.
- Exact detail for `pulses.lifecycle` and other planned entries returns `catalog_only`.
- Measurement script reports compact Code Mode descriptor size separately from catalog size.

### Acceptance Gate

Fresh-model evals can discover a publish capability, fetch exact detail, and form a valid execute call without seeing the full native tool list.

## Finding 4: Dynamic Worker Code Mode Diverges From Fallback Behavior

### Problem

The Dynamic Worker path can ignore top-level `capabilityId`, `arguments`, `query`, and `confirmed` unless generated code manually calls the injected provider. The local fallback may handle those fields directly, creating inconsistent behavior between local tests and hosted Code Mode.

### Target Behavior

Top-level Code Mode tool arguments are first-class in both runtimes:

- `search({ query })`
- `search({ capabilityId })`
- `execute({ capabilityId, arguments, confirmed })`

Generated code remains supported, but the direct top-level path must be equivalent across Dynamic Worker and fallback.

### Runtime Contract

For `search`:

- If top-level `query` or `capabilityId` is present, both runtimes resolve search without requiring generated code.
- If only code is present, both runtimes allow generated code to call `codemode.search` or `vibecodr.search`.

For `execute`:

- If top-level `capabilityId` is present, both runtimes call the same `executeCapability` path.
- `arguments` are passed as native tool arguments.
- `confirmed` is checked at the capability layer before native tool execution.
- Catalog-only capabilities fail with `CATALOG_ONLY_CAPABILITY`.
- Unknown capabilities fail with `UNKNOWN_CAPABILITY`.
- Missing capability id fails with `MISSING_CAPABILITY_ID`.

### Tests

- Fallback `search` by `query` and Dynamic Worker `search` by `query` return equivalent structured content.
- Fallback `search` by `capabilityId` and Dynamic Worker `search` by `capabilityId` both return exact detail.
- Fallback `execute` and Dynamic Worker `execute` both honor top-level `capabilityId`, `arguments`, and `confirmed`.
- Both runtimes reject `quick_publish_creation` without `confirmed`.
- Both runtimes reject catalog-only capability execution.
- Live sandbox regression exercises top-level arguments, not only generated-code provider calls.

### Acceptance Gate

`npm run verify:release` passes against a staged Worker with `CODEMODE_WORKER_LOADER` configured before Code Mode can become default.

## Finding 5: Runtime Readiness Overpromises Its Usable Scope

### Problem

`get_runtime_readiness` sounds like a general runtime/launch readiness tool, but if it only accepts `operationId`, users with a draft or live vibe hit a missing-context wall.

### Target Behavior

`get_runtime_readiness` must support all advertised subjects:

- current operation by `operationId`
- draft by `draftId` or `capsuleId`
- live vibe by `postId`

If the server cannot determine readiness for a subject, it should return `state: "unknown"` with a concrete next action, not a missing-operation-id error.

### Input Contract

At least one of these identifiers may be supplied:

- `operationId`
- `capsuleId`
- `postId`
- `draftId`

No identifier should return `MISSING_RUNTIME_TARGET` with guidance to call `resume_latest_publish_flow` once that tool exists.

### Output Contract

Successful structured content includes:

- `state`: `ready | blocked | degraded | unknown`
- `subject`: `{ type: "operation" | "draft" | "live_vibe", id: string }`
- optional summarized `operation`
- optional `blocker`
- `nextAction`
- `evidence`

Evidence must be product-safe. Do not expose raw manifests, iframe internals, CSP details, telemetry rows, raw source bundles, secrets, or pulse private-backend internals.

### Main Vibecodr Dependency

Long-term full fidelity needs a main Vibecodr read projection that can answer readiness for drafts and live vibes without reimplementing app logic in the MCP gateway. The projection should live in the main app API, not as duplicated MCP heuristics.

### Tests

- `operationId` path returns operation readiness.
- `postId` path reads live vibe summary and returns ready/degraded/unknown.
- `draftId` or `capsuleId` path returns safe draft summary or unknown with next action.
- No-target path returns `MISSING_RUNTIME_TARGET` and recommends the resume/readiness flow.
- Output schema validation prevents internal details from leaking.

### Acceptance Gate

Descriptor, schema, implementation, and tests all agree on the supported subjects.

## Finding 6: High-Value Guidance Is Hidden From Default Discovery

### Problem

`get_guided_publish_requirements` and `get_launch_best_practices` contain exactly the workflow scaffolding a fresh model needs, so they are now visible in default `tools/list`. The remaining recovery handlers stay hidden because they require operation context and would make first-run discovery look like an operator console.

### Target Behavior

The guidance remains hidden/internal as callable tools, but its core workflow must be available through guaranteed cold-start paths.

### Required Exposure Paths

At least three of these should be true:

- `initialize.instructions` summarizes the critical workflow.
- `get_upload_capabilities` includes `recommendedFirstRunFlow`, public primary tools, recovery tools, and entry conventions.
- Public prompts list includes `publish_creation_end_to_end` and `polish_public_launch`.
- Code Mode `search` can find internal guidance capabilities and exact detail by `capabilityId`.
- `quick_publish_creation` descriptor explicitly describes confirmation and launch-polish expectations.

### Hidden Tool Policy

`get_guided_publish_requirements` and `get_launch_best_practices` should remain callable by exact name for compatibility and Code Mode detail, but not visible in default public discovery unless a future product decision expands the surface.

### Tests

- Default `tools/list` does not include internal guidance tools.
- Hidden-inclusive tool registry includes both guidance tools.
- `tools/call` by exact hidden name still works.
- `initialize.instructions` covers the core guidance.
- `get_upload_capabilities` references the recommended first-run flow and public/recovery tool names.
- Code Mode search can discover guidance by terms like "publish requirements" and "launch polish".

### Acceptance Gate

A fresh client with only initialize plus default tools can infer the safe publish workflow without seeing hidden tools.

## Follow-On Capability Spec

The six findings fix reliability and comprehension. The next layer is capability completeness, using main Vibecodr APIs as the source of truth.

### `validate_creation_payload` / `prepare_publish_package`

Purpose: no-write validation and packaging preview before publish.

Behavior:

- Accept the same `sourceType` and `payload` shape as `quick_publish_creation`.
- Normalize files through the same adapters.
- Infer entry, title, runner, project type, and pulse/vibe/combo shape.
- Return `canPublish`, `requiredFixes`, `warnings`, `normalizedSummary`, `suggestedArguments`, and `confirmationPrompt`.
- Never create import operations, capsules, posts, artifacts, thumbnails, or live vibes.

Main Vibecodr dependency:

- Reuse project analysis and package policy from the main app rather than duplicating validation in the gateway.
- Prefer a main API dry-run endpoint or shared package validator exported from the canonical app code.

MCP placement:

- Public, read-only native tool.
- Also cataloged as `publish.prepare_package`.
- Recommended first call before `quick_publish_creation` for zero-context models with raw files.

### `resume_latest_publish_flow`

Purpose: remove operation-id dependency from normal recovery.

Behavior:

- Authenticated read.
- Finds the user's latest actionable import/compile/publish operation or recent draft/live vibe.
- Returns current phase, known ids, next safe action, confirmation requirement, and recommended tool call.
- Does not mutate state.

Main Vibecodr dependency:

- Needs a user-scoped recent-operation projection that survives MCP restarts and non-MCP Studio flows.
- Should consult import jobs, capsule/draft status, publish state, and live post status.

MCP placement:

- Public, read-only recovery/readiness tool.
- Mention from `get_runtime_readiness` when no target id is supplied.

### Pulse Lifecycle Tools

Purpose: turn catalog-only pulse guidance into owner-facing lifecycle operations.

Initial native tools:

- `list_pulses`
- `get_pulse`
- `create_pulse`
- `update_pulse`
- `run_pulse`
- `archive_pulse`
- `restore_pulse`
- `get_pulse_status`

Rules:

- Owner-auth required.
- Mutations require `confirmed: true`.
- Pulse removal, account lifecycle cleanup, and state-resource cleanup are not Phase 2 MCP capabilities. They must wait for a main-platform lifecycle contract before any gateway tool or catalog entry names them.
- Public output must not expose source, `.pulse` contents, dispatch tokens, secret values, raw logs, deployment internals, or public pulse projection internals.
- Public vibe/post projections may expose `hasPrivateBackend` only.

Main Vibecodr dependency:

- Wrap existing owner pulse routes from the main API.
- Add missing OpenAPI/shared contracts before adding MCP wrappers if response shapes are unstable.

### Social Discovery And Read Tools

Purpose: make the MCP useful for social Vibecodr workflows with zero context.

Initial native tools:

- `discover_vibes`
- `get_public_post`
- `get_public_profile`
- `search_vibecodr`
- `get_remix_lineage`

Rules:

- Read-only by default.
- Respect public viewer/auth optional fetch contracts.
- Preserve moderation and visibility semantics from the main app.
- Do not expose moderator-only details, private backend internals, or hidden feed-control state as public MCP output.

Main Vibecodr dependency:

- Use existing feed, profile, search, and remix endpoints.
- Add a consolidated `post context` projection if the MCP would otherwise need to chain too many reads.

### Post-Publish Polish Helpers

Purpose: keep the model from stopping at "published" when the product goal is social launch quality.

Initial native or prompt-backed helpers:

- `build_share_copy`
- `get_launch_checklist`
- `inspect_social_preview`
- `suggest_post_publish_next_steps`
- `get_engagement_followup_context`

Rules:

- Read/compose first.
- Metadata writes remain separate and confirmation-gated.
- Output should produce useful launch language, not generic deployment status.

Main Vibecodr dependency:

- Needs post URL, player URL, author/profile, title, description, tags, visibility, post-commit state, stats, comments, remix count, and SEO/social preview status.

### Capability-Level Evals

Purpose: prove Code Mode works for fresh zero-context models before making it default.

Eval scenarios:

1. Fresh model discovers how to publish, validates a payload, asks for confirmation, then publishes only with `confirmed: true`.
2. Fresh model resumes a publish flow without operation id.
3. Fresh model fetches exact Code Mode detail before execute.
4. Dynamic Worker and fallback return equivalent behavior for top-level `query`, `capabilityId`, `arguments`, and `confirmed`.
5. Fresh model uses social read tools to understand a live vibe, profile, search result, and remix lineage.
6. Fresh model uses pulse tools without exposing private backend internals.
7. Fresh model produces post-publish polish from live context.
8. Catalog-only capabilities are not executed.
9. Hidden guidance remains hidden from default tools but discoverable through allowed guidance paths.

Failure gates:

- Any publish without confirmation.
- Any mutation through Code Mode that bypasses native guards.
- Any Dynamic Worker/fallback divergence for the same top-level input.
- Any raw secret, token, private backend internals, raw source bundle, telemetry row, or admin-only detail in public output.
- Any default Code Mode switch before live sandbox regression passes.

## Implementation Phases

### Phase A: Lock The Six Review Findings

- Add or update tests for all six findings.
- Ensure current code satisfies every server contract above.
- Update docs if any behavior differs from this spec.

Verification:

- `npm run check`
- `npm test`
- `npm run transport:regression`

### Phase B: Add No-Write Preparation And Resume

- Add `validate_creation_payload` or `prepare_publish_package`.
- Add `resume_latest_publish_flow`.
- Update prompts, upload capabilities, and Code Mode catalog.

Verification:

- `npm run check`
- `npm test`
- targeted transport regression for new public tools

### Phase C: Add Read-First Social And Polish Tools

- Add social read wrappers over stable main Vibecodr routes.
- Add post-publish polish helpers.
- Keep subjective guidance in prompts where appropriate.

Verification:

- `npm run check`
- `npm test`
- schema tests for public read outputs

### Phase D: Add Owner Pulse Lifecycle

- Add pulse owner tools after main API contracts are confirmed.
- Confirmation-gate mutations.
- Add redaction tests for private backend invariants.

Verification:

- `npm run check`
- `npm test`
- `npm run security:regression`

### Phase E: Code Mode Default Gate

- Add capability eval harness.
- Run fallback and Dynamic Worker parity tests.
- Run the staged release gate.
- Only then consider `CODEMODE_DEFAULT=true`.

Verification:

- `npm run mcp:measure`
- `npm run verify:release`

## Done Criteria

This hardening work is complete when:

- All six findings have executable regression coverage.
- Public native discovery remains small and product-shaped.
- Hidden guidance stays callable but is no longer required for cold-start success.
- Code Mode search supports compact discovery and exact detail lookup.
- Dynamic Worker and fallback Code Mode paths are behaviorally equivalent.
- Destructive native and Code Mode paths enforce confirmation server-side.
- Runtime readiness supports the subjects its descriptor advertises.
- New capability families are read-first or confirmation-gated as appropriate.
- Code Mode default is blocked until capability evals and live sandbox regression pass.
