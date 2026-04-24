# AGENTS.md (Vibecodr MCP Gateway)

This repository is the public-facing MCP gateway for Vibecodr. It is not the full `vibecodr.space` application, but it sits on a real trust boundary: remote MCP clients, OAuth, session cookies, Cloudflare Workers, and the Vibecodr API all meet here.

Agents must protect both sides:

- the gateway must stay secure, reliable, protocol-correct, and compatible with remote MCP clients
- the product must still feel like Vibecodr, not a generic developer dashboard or an exposed admin panel

This file is the local control plane for agents working in this repo. Read it before systemic work.

## Default Operating Stance

You are maintaining a hosted MCP gateway for a living social coding platform. Treat every change as part of a connected system: MCP protocol behavior, OAuth compatibility, session storage, Cloudflare deployment, Vibecodr API contracts, telemetry, docs, and model-facing tool semantics.

Prefer designs that are legible, boring in the best way, and intentionally scoped. Complexity must earn its place through real protocol, safety, compatibility, or product need. Do not expose internal machinery because it is convenient. Do not hide product capability because modeling it well is harder.

## Core Principles

Three co-equal principles guide this repo:

1. Be Social.
2. Be Permissive.
3. Be Safe.

For this gateway, that means:

- Be Social: MCP tools should help people publish, inspect, polish, share, remix, and understand vibes.
- Be Permissive: preserve standards-compliant MCP/OAuth flows, broad client compatibility, and useful recovery paths.
- Be Safe: keep auth, secrets, raw code bundles, private user data, telemetry, dispatch internals, and admin recovery surfaces out of the public tool shape.

When these principles conflict, find the design that satisfies all three. If none exists, escalate.

## Current Standards

It is 2026. MCP, OAuth, Cloudflare Workers, and Cloudflare Agents guidance change quickly. For platform-shaping changes, check current primary docs before relying on stale assumptions.

Default to a Cloudflare developer mindset for Workers, bindings, compatibility dates, observability, OAuth, Durable Objects, Dynamic Workers, and remote MCP deployment patterns.

## Non-Negotiables

- Map the relevant code paths before changing systemic behavior. Include upstream callers, downstream consumers, tests, scripts, docs, and deployment config.
- Operate PowerShell-natively in this workspace.
- Never commit secrets. Never log tokens, raw code bundles, raw user payloads, PII, cookies, authorization headers, or refresh tokens.
- Assume MCP client input, uploaded package input, OAuth callback input, and Vibecodr API responses can be malformed or hostile.
- Do not weaken auth, redirect validation, session signing, origin policy, rate limits, protocol validation, thumbnail/file validation, or telemetry redaction for convenience.
- Do not reintroduce the removed widget surface unless explicitly asked and backed by a fresh product/security decision.
- Keep default `tools/list` small and product-shaped. Internal guidance, recovery, admin, telemetry, and low-level operation tools belong behind hidden compatibility, prompts, or Codemode catalog/search.
- Preserve compatibility for existing tool names when possible. If a shared public tool is renamed or demoted, keep a deliberate alias or hidden callable path until clients have migrated.
- Prefer correct changes with targeted verification over fast, weak ones.

## Default Workflow

1. Understand the task and classify the mode below.
2. Read the entrypoint first. For MCP requests, start at `src/worker.ts`, `src/app.ts`, `src/mcp/handler.ts`, and `src/mcp/tools.ts`.
3. Trace affected auth/session paths, Vibecodr API calls, telemetry, docs, scripts, and tests.
4. Find the SSOT owner and extend it instead of forking local policy.
5. Make the smallest complete change that preserves system coherence.
6. Run the targeted checks while iterating.
7. Before declaring done, run the completion self-check.

## Mode Selection

### Gateway-Systems Mode

Use this mode for:

- `src/worker.ts`
- `src/app.ts`
- `src/auth/`
- `src/mcp/handler.ts`
- `src/mcp/tools.ts`
- `src/services/`
- `src/storage/`
- `src/vibecodr/`
- `deploy/`
- `wrangler*.toml`
- OAuth, session, cookie, telemetry, protocol, transport, and Cloudflare behavior

Rules:

- Identify the request entrypoint and all auth/session side effects.
- Preserve MCP JSON-RPC shape, Streamable HTTP behavior, protocol version handling, and auth challenge metadata.
- Preserve OAuth discovery, dynamic client registration compatibility, preregistered client handling, redirect validation, refresh-token replay safety, and Clerk proxy issuer alignment.
- Keep output schemas and structured tool errors stable.
- Update tests and regression scripts when protocol, auth, tool registration, or transport behavior changes.
- Run at least `npm run check`; run `npm test`, `npm run transport:regression`, or `npm run security:regression` when the touched area warrants it.

### MCP Product-Surface Mode

Use this mode for:

- tool names, descriptions, visibility, annotations, input schemas, output schemas, prompts, launch guidance, README/docs explaining the tool surface

Rules:

- Default visible tools should describe user/product intent, not implementation mechanics.
- Hidden recovery tools may remain callable by exact name for older clients, diagnostics, and future Codemode execution.
- Guidance belongs in prompts, skills, catalog metadata, or server instructions unless the model truly needs a callable read.
- Do not expose admin, telemetry, dispatch, secret inventory, crawler, sitemap, or internal API plumbing as public default tools.
- Be precise with lifecycle names. In Vibecodr, package bootstrap/import, preview compile, and canonical live publish are different lanes.

### Docs And Research Mode

Use this mode for:

- `docs/`
- `README.md`
- research notes
- migration plans
- client setup docs

Rules:

- Keep docs executable and repo-grounded. A plan should name files, phases, checks, and acceptance gates.
- Do not let research docs drift into policy unless they are wired to code, tests, or a follow-up execution plan.
- When documenting current external behavior, include dates or source links if the behavior is likely to change.
- `docs/CHANGELOG.md` does not exist in this repo; do not invent changelog workflow here unless asked.

## MCP Surface Invariants

- Default `tools/list` is intentionally minimized.
- Public tools are for product-level user workflows: account capability, publish/readiness, live vibe reads, metadata polish, upload capability, pulse guidance, and other user-facing actions.
- Recovery tools are for failed or stalled flows: operation inspection, retry, manual compile/publish, cancellation, failure explanation, runtime diagnostics, admin support.
- Codemode should eventually absorb dense low-level surfaces through `search` and `execute`, not by advertising dozens of native tools.
- Prompts/skills should carry subjective or conversational work: launch polish, SEO/share copy, remix explanations, pulse decisioning, and recovery coaching.
- Internal Vibecodr API implementation details are not automatically MCP tools.

## Auth And Session Invariants

- The hosted gateway is the MCP-facing OAuth compatibility layer.
- Clerk remains upstream identity; this gateway owns MCP-compatible OAuth metadata and session exchange behavior.
- Preserve `__Host-vc_session` behavior and legacy session-cookie reading unless deliberately migrated.
- Do not expose upstream refresh tokens to MCP clients.
- Auth challenge responses must include the resource metadata and required scopes expected by remote MCP clients.
- Do not loosen redirect URI checks, client registration checks, verifier checks, or token replay handling.

## Cloudflare And Deployment Invariants

- Treat Worker compatibility dates, observability, KV/session persistence, and secret configuration as deployment contracts.
- Prefer repo scripts and documented deployment paths over ad hoc Wrangler commands.
- Do not assume a local secret exists. Do not print secret values when debugging.
- Keep `deploy/cloudflare/wrangler.gateway.toml.example`, deployment docs, and runtime config expectations aligned when bindings or env vars change.

## Decision Trace Comments

Use `// WHY:` comments sparingly at non-obvious trust-boundary decisions, compatibility shims, fallback paths, protocol quirks, and deliberate deviations from obvious local simplifications.

`// WHY:` explains why the system must behave that way. It is not a restatement of what the code does.

## Verification Matrix

Choose checks by blast radius:

- Type-only or descriptor-only code changes: `npm run check`.
- Tool schema, prompt, or MCP handler changes: `npm run check` and `npm test`.
- Transport, protocol, resources, prompts, batching, or client metadata changes: add `npm run transport:regression`.
- Auth, OAuth, cookies, request limits, redirect, token, or structured error changes: add `npm run security:regression`.
- Deployment config changes: inspect the relevant `deploy/` docs/examples and run the strongest local static checks available.
- Docs-only changes: at minimum run `git diff --check`.

If you cannot run a check, say exactly why.

## Completion Self-Check

Before marking work complete:

- Did I finish the actual task, or only the easiest local slice?
- Did I preserve MCP client compatibility?
- Did I preserve auth/session security?
- Did I keep the public tool surface product-shaped?
- Did I update docs/tests/scripts that encode the contract I changed?
- Did I avoid reverting or overwriting unrelated dirty work?
- Did I run the right verification for the blast radius?

If any answer is uncertain, trace the gap before declaring done.

## Git And Editing Hygiene

- Never use destructive resets unless explicitly requested.
- Do not discard or rewrite unrelated changes.
- Keep edits minimal and consistent with existing style.
- Use `apply_patch` for manual file edits.
- Do not commit, push, deploy, or publish unless explicitly asked.
- If committing is requested, include the required `Co-authored-by: Codex <noreply@openai.com>` trailer exactly once.

## Sub-Agent Discipline

Use read-only subagents for broad audits across independent domains. Give each agent a narrow scope and ask for file-backed findings.

Do not let subagent recommendations become implementation without a synthesis pass. Convert them into explicit tool-surface decisions, phases, and verification gates first.

## High-Signal References

- `README.md` - repo purpose, hosted gateway scope, setup links
- `docs/mcp-server.md` - current MCP behavior and tool classes
- `docs/mcp-client-setup.md` - remote MCP client setup and OAuth notes
- `docs/cloudflare-mcp-alignment.md` - Cloudflare platform alignment
- `docs/cloudflare-codemode-migration-plan.md` - Code Mode research and migration direction
- `docs/planning/14-public-surface-minimization.md` - public surface minimization rationale
- `scripts/mcp-transport-regression.mjs` - MCP transport compatibility regression
- `scripts/security-regression.mjs` - security and auth regression coverage

## Stop Switch

If `/.haltagent` exists, stop immediately, summarize findings, and wait.
