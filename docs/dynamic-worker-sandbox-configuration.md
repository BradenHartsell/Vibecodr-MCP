# Dynamic Worker Sandbox Configuration

Last reviewed: 2026-04-24

## Purpose

This document defines how Vibecodr MCP should use Cloudflare Dynamic Workers for Code Mode.

The goal is narrow: run generated Code Mode snippets that can search the Vibecodr capability catalog and call approved gateway-owned capabilities.

This is not a general-purpose user-code sandbox, not a backend hosting lane, not a pulse runner, not a preview runtime, and not a place to run arbitrary uploaded projects. Vibecodr already has separate product lanes for browser runtime previews and trusted backend execution.

## Primary Cloudflare Findings

Cloudflare's current Dynamic Workers documentation says:

- Dynamic Workers execute arbitrary code in on-demand Worker isolates, and the parent chooses which bindings the child receives and whether it can reach the network.
- `load(code)` is intended for one-time execution such as Code Mode; `get(id, callback)` is intended for warm reuse of the same code.
- Worker Loader bindings are configured with `worker_loaders`.
- `globalOutbound: null` blocks outbound `fetch()` and `connect()` from the child Worker.
- If `globalOutbound` is omitted, the child can inherit the parent Worker's network access, which usually means public Internet access.
- Dynamic Worker bindings should be capability-shaped RPC stubs, not broad platform bindings.
- Custom limits can cap CPU milliseconds and subrequest counts.
- Dynamic Worker logs require explicit Tail Worker wiring if we want durable observability.

Sources:

- https://developers.cloudflare.com/dynamic-workers/
- https://developers.cloudflare.com/dynamic-workers/getting-started/
- https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- https://developers.cloudflare.com/dynamic-workers/usage/limits/
- https://developers.cloudflare.com/dynamic-workers/usage/observability/
- https://developers.cloudflare.com/dynamic-workers/pricing/
- https://developers.cloudflare.com/agents/api-reference/codemode/
- https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/

## Configuration Decision

Do not add a generic `LOADER` binding to this gateway.

Configure a purpose-named loader:

```toml
[[worker_loaders]]
binding = "CODEMODE_WORKER_LOADER"
```

The binding name matters. `CODEMODE_WORKER_LOADER` communicates that this loader exists only for MCP Code Mode. It should not be reused for app previews, pulses, user uploads, CLI code execution, image/video jobs, build systems, or admin experiments.

## Required Executor Shape

The production executor is a small adapter around `@cloudflare/codemode`:

```ts
const executor = new DynamicWorkerExecutor({
  loader: env.CODEMODE_WORKER_LOADER,
  timeout: config.codeMode.maxExecutionMs,
  globalOutbound: null
});
```

Rules:

- `globalOutbound` must be explicitly set to `null`.
- Timeout must be explicit and short. Start at `5_000` ms or lower for MCP Code Mode.
- The child Worker must receive no secrets, OAuth tokens, Clerk tokens, gateway refresh tokens, Vibecodr bearer tokens, raw cookies, raw request headers, or unfiltered environment.
- The child Worker must receive no KV, R2, D1, Durable Object, Queue, Service, AI, Browser, or external fetch binding directly.
- The child Worker may call only host-owned RPC methods that enforce the same auth, confirmation, rate-limit, output-size, and telemetry contracts as native MCP tools.
- Search and execute should be separate capabilities, even if both share the same executor primitive.

## Capability Binding Model

Use capability-based RPC, not network allowlists, as the main security model.

The parent Worker owns the sensitive work. The child Worker gets a narrow typed object, conceptually:

```ts
declare const vibecodr: {
  searchCatalog(input: { query?: string; terms?: string[] }): Promise<CapabilitySearchResult>;
  callCapability(input: {
    capabilityId: string;
    arguments: unknown;
    confirmed?: boolean;
  }): Promise<CapabilityCallResult>;
};
```

Host-side enforcement must happen before calling native handlers:

- Resolve the MCP session in the parent gateway, not inside the child Worker.
- Reject missing auth before sandbox execution for protected calls when possible.
- Resolve `capabilityId` through `src/mcp/capabilityCatalog.ts`.
- Reject unknown or catalog-only capabilities for `execute`.
- Reject destructive capabilities unless `confirmed === true` and the outer request context has user-visible confirmation evidence.
- Pass only normalized arguments to native handlers.
- Truncate structured results before returning them to generated code.
- Log nested capability calls with the outer MCP trace id.
- Preserve the same top-level `query`, `capabilityId`, `arguments`, and `confirmed` semantics in Dynamic Worker execution and the local fallback. The sandbox runtime must not silently require a different call shape than tests use locally.

## Network Policy

Default policy:

```ts
globalOutbound: null
```

Do not replace this with a normal Fetcher during the first production Code Mode rollout.

If a future workflow needs controlled outbound access, route it through a named host-owned service such as `CODEMODE_OUTBOUND_PROXY`, and make that service deny by default. It must allow only explicit product-owned destinations and methods. It must not become a generic HTTP proxy.

Initial deny list by design:

- arbitrary public Internet
- Vibecodr API direct HTTP
- Clerk or OAuth provider direct HTTP
- Cloudflare API direct HTTP
- local metadata endpoints
- private IP ranges and link-local addresses
- user-supplied URLs

## Resource Limits

Use both SDK timeout and platform limits where the API surface allows it.

Recommended starting limits for MCP Code Mode:

- executor timeout: `5_000` ms
- dynamic Worker CPU: `50` ms
- dynamic Worker subrequests: `0` for search, `5` for execute if RPC calls count as subrequests in the selected implementation
- output cap from sandbox to parent: `32 KB`
- log cap per execution: `8 KB`
- catalog search result cap: `20` entries
- nested capability call cap: `5`

Cloudflare documents custom limits as:

```ts
limits: { cpuMs: 10, subRequests: 5 }
```

The current adapter sets SDK timeout and host-enforced output, log, and nested-call caps. The selected `@cloudflare/codemode` version does not expose Cloudflare `limits` directly through `DynamicWorkerExecutor`, so CPU/subrequest platform limits remain a deploy-configuration follow-up if Cloudflare adds that option to the package surface.

## Loader Mode

For Code Mode, prefer one of these two patterns:

1. `load(code)` for one-time generated snippets when using Cloudflare's Code Mode SDK default path.
2. `get(stableId, callback)` only for stable, versioned sandbox harness code where user/model code is passed as data to the harness.

Do not use user id, session id, operation id, or raw code hash as an unconstrained warm Worker id. Cloudflare pricing counts unique ID/code combinations, and unconstrained IDs can create cost and abuse risk.

If using `get`, derive stable IDs from the sandbox harness version, not from arbitrary user input:

```ts
const stableId = "vibecodr-codemode-harness-v1";
```

## Observability

Minimum telemetry:

- outer MCP trace id
- `codemode.search` / `codemode.execute`
- sandbox timeout, CPU-limit, subrequest-limit, output-limit, and unknown-capability failures
- nested capability id, visibility tier, auth result, confirmation result, outcome, and latency
- counts only for logs by default, not raw generated code or raw returned user data

Do not log:

- generated code bodies by default
- raw package payloads
- raw capability arguments that may include user files
- tokens, cookies, authorization headers, refresh grants, or upstream API responses
- complete sandbox stdout/stderr without redaction and byte limits

If Tail Workers are added, they must redact and cap logs before writing to Workers Logs.

## Deployment Flags

Recommended production flags:

```toml
[vars]
CODEMODE_ENABLED = "false"
CODEMODE_DEFAULT = "false"
CODEMODE_REQUIRE_DYNAMIC_WORKER = "true"
CODEMODE_ALLOW_NATIVE_FALLBACK = "false"
CODEMODE_MAX_EXECUTION_MS = "5000"
CODEMODE_MAX_OUTPUT_BYTES = "32768"
CODEMODE_MAX_LOG_BYTES = "8192"
CODEMODE_MAX_NESTED_CALLS = "5"
```

Rules:

- Production must not silently fall back to the in-process interpreter when `CODEMODE_REQUIRE_DYNAMIC_WORKER=true`.
- Local tests may use the deterministic in-process interpreter, but production must fail closed if the Dynamic Worker loader is missing.
- Default `/mcp` stays native until Code Mode evals and live client compatibility are proven.

## Tests Required Before Enabling

Implemented tests prove:

- production Code Mode fails closed when `CODEMODE_REQUIRE_DYNAMIC_WORKER=true` and `CODEMODE_WORKER_LOADER` is absent
- sandbox executor is created with explicit `globalOutbound: null`
- fallback search output is capped before returning to the client
- `execute` rejects catalog-only capabilities as non-callable
- nested capability telemetry is recorded without logging generated code

Implemented pre-deploy live harness:

```powershell
$env:MCP_BASE_URL = "https://staging-openai.vibecodr.space"
$env:MCP_BEARER_TOKEN = "<optional staged MCP bearer token>"
npm run verify:release
```

The live harness asserts the actual staged Worker exposes only `search` and `execute` at `/mcp?codemode=search_and_execute`, uses the `dynamic_worker` runtime, blocks `fetch()` and `connect()`, hides parent environment/bindings, enforces output and timeout caps, rejects catalog-only execution, and keeps destructive native execution behind confirmation.

Still required before enabling production Code Mode:

- run `npm run verify:release` against the first staged Worker after `CODEMODE_WORKER_LOADER` is provisioned
- inspect staged Worker logs/observability for the harness trace ids
- `execute` cannot call hidden/destructive capabilities without catalog permission and confirmation
- confirm platform-level CPU/subrequest limits if Cloudflare exposes them for the selected `@cloudflare/codemode` executor version

## Not MCP Code Mode

Do not route these through this Dynamic Worker loader:

- uploaded Vibecodr projects
- runtime previews
- pulse source or backend implementation
- source projection
- Cloudflare admin repair scripts
- generic JavaScript/Python execution
- package build systems
- crawler/sitemap/snapshot generation
- user-provided webhook execution

If one of those needs a sandbox, design a separate product-specific sandbox with its own binding, threat model, limits, tests, and billing controls.
