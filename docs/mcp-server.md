# Vibecodr MCP Server

## Purpose

Vibecodr exposes one remote MCP product:

- standards-compliant Streamable HTTP MCP for Codex, Cursor, VS Code, ChatGPT, Windsurf, and other MCP-capable tools

The tool surface is goal-shaped and client-neutral. There is no embedded widget surface.

ChatGPT is a remote MCP client of this gateway, not a separate server product. The active production architecture is one hosted MCP gateway, one OAuth compatibility layer, and one shared tool/prompt surface. See [`canonical-architecture.md`](./canonical-architecture.md) for the boundary contract.

## Endpoints

Base application:
- `GET /health`
- `POST /mcp`

Protected resource metadata:
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`

Generic OAuth compatibility layer:
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-client/vibecodr-mcp.json`
- `POST /register`
- `GET /authorize`
- `POST /token`
- `POST /revoke`

## Authentication architecture

Clerk remains the identity provider.

The gateway acts as the MCP-facing OAuth compatibility layer for generic MCP clients:

1. The MCP client discovers the gateway as the authorization server.
2. A first-party client can use the committed URL-based client metadata document at `/.well-known/oauth-client/vibecodr-mcp.json`, or a generic client can dynamically register at `/register`.
3. The gateway sends the user to Clerk for the real sign-in step.
4. Clerk returns the authorization code to the gateway callback.
5. The gateway exchanges that code with Clerk and returns a gateway-issued authorization code to the MCP client.
6. The MCP client redeems that gateway-issued code at `/token`.
7. Protected MCP tool calls use the resulting bearer token.

This removes the need for manual token entry in remote MCP clients.

On a successful MCP OAuth flow, users usually do not end on a Vibecodr gateway success page. The final visible confirmation belongs to the MCP client because the gateway redirects to the client's registered callback after issuing the gateway authorization code. If a browser lands on `/auth/callback` or `/oauth_callback` with expired, replayed, or invalid MCP callback state, the gateway returns a no-store HTML page that tells the user to close the tab and restart sign-in from the client.

Do not confuse the two auth entrypoints:
- `/authorize` is the MCP OAuth entrypoint and is the correct path for Codex, Cursor, VS Code, Windsurf, and other remote MCP clients
- `/auth/start` is the browser login entrypoint and normally returns to `/`

## Security properties

- PKCE S256 is required for public MCP clients.
- Redirect URIs are validated. Dynamic clients must match the registered redirect exactly, while preregistered loopback redirects may vary only by port.
- The gateway advertises `client_id_metadata_document_supported=true` and recognizes the official Vibecodr CLI client metadata document URL as a public client.
- Dynamic registration issues public clients only (`token_endpoint_auth_method=none`).
- The gateway issues opaque refresh tokens and keeps the upstream Clerk refresh token server-side.
- Authorization codes are one-time use and short lived.
- The gateway does not create a second user identity system; it delegates sign-in to Clerk.
- Protected resource metadata is still emitted for the MCP resource.
- Existing Vibecodr bearer-to-session exchange remains intact for tool execution.

## Remote MCP mode

Remote MCP mode is optimized for clients that want standards-compliant MCP over Streamable HTTP without manual token entry.

Recommended setup:
- MCP URL: `https://openai.vibecodr.space/mcp`
- the client should discover auth from the protected resource metadata and gateway auth metadata
- the official Vibecodr CLI should use the committed client metadata document URL with PKCE
- other generic clients can register dynamically and use PKCE

### Codex example

```powershell
codex mcp add vibecodr-space --url https://openai.vibecodr.space/mcp
```

Current public Codex docs explicitly document `codex mcp add`, `codex mcp list`, and direct `~/.codex/config.toml` editing. Treat any separate Codex login UX for protected HTTP MCPs as build-specific behavior that should be live-tested against the current Codex build.

For the best user-facing workflow guide, start with [`build-with-vibecodr-mcp.md`](./build-with-vibecodr-mcp.md). This file is the protocol/reference view; the build guide is the "what should an agent or user actually do?" view.

## Tool classes

Default public tools:
- `get_vibecodr_platform_overview`
- `get_guided_publish_requirements`
- `get_upload_capabilities`
- `prepare_publish_package`
- `validate_creation_payload`
- `get_launch_best_practices`
- `get_pulse_setup_guidance`
- `get_account_capabilities`
- `quick_publish_creation`
- `get_publish_readiness`
- `get_runtime_readiness`
- `resume_latest_publish_flow`
- `list_vibecodr_drafts`
- `get_vibecodr_draft`
- `list_my_live_vibes`
- `get_live_vibe`
- `get_vibe_engagement_summary`
- `get_vibe_share_link`
- `discover_vibes`
- `get_public_post`
- `get_public_profile`
- `search_vibecodr`
- `get_remix_lineage`
- `build_share_copy`
- `get_launch_checklist`
- `inspect_social_preview`
- `suggest_post_publish_next_steps`
- `get_engagement_followup_context`
- `update_live_vibe_metadata`

Hidden compatibility and recovery handlers:
- `list_import_operations`
- `get_import_operation`
- `watch_operation`
- `explain_operation_failure`
- `start_creation_import`
- `compile_draft_capsule`
- `publish_draft_capsule`
- `cancel_import_operation`

The hidden handlers are still implemented and can be called by exact name when an older client, regression script, or future Codemode executor needs them. They are intentionally absent from the default `tools/list` response so first-run agents see a product-shaped contract instead of operation plumbing.

## Cold-start and write safety

The `initialize` response includes server instructions for fresh models. Those instructions define Vibecodr product intent, recommend safe first reads for publish flows, and require explicit user confirmation before any live write.

Destructive native tools now enforce `confirmed: true` server-side. This currently applies to:

- `quick_publish_creation`
- `update_live_vibe_metadata`
- `publish_draft_capsule`
- `cancel_import_operation`

Tool descriptions are still guidance for the model, but confirmation is no longer only a descriptor convention. Calls without explicit confirmation return `CONFIRMATION_REQUIRED` before package import, metadata update, publish, or cancellation side effects begin.

`get_runtime_readiness` now requires a known target rather than pretending to inspect arbitrary context. Use `operationId` during a current publish flow, `postId` for an already-live vibe, or `draftId` for a safe draft summary.

## Opt-In Code Mode

The native MCP surface remains the default at `/mcp`.

For clients dogfooding the Cloudflare-style search/execute shape, use:

```text
https://openai.vibecodr.space/mcp?codemode=search_and_execute
```

In this mode:
- `tools/list` returns only `search` and `execute`
- `search` reads the server-side Vibecodr capability catalog; pass an exact `capabilityId` to receive input schema, output schema, and examples for that capability
- `execute` calls gateway-owned capability proxies and preserves the same OAuth challenge behavior as native protected tools
- catalog-only entries are explicitly marked as non-callable so the model can distinguish roadmap/policy lanes from executable capabilities
- generated code is treated as discovery/execution intent, not as permission to access secrets, tokens, raw env vars, or arbitrary network calls

The MCP surface is now registered through `src/mcp/server.ts`, an SDK-aligned adapter backed by `@modelcontextprotocol/sdk/server/mcp.js`. The existing gateway still owns the HTTP request parsing, OAuth challenge metadata, session resolution, body limits, telemetry, and regression-tested Streamable HTTP behavior.

Production Code Mode is configured to require `CODEMODE_WORKER_LOADER` and fail closed when the Dynamic Worker loader is absent. Keep `CODEMODE_ENABLED=false` until the Cloudflare Worker Loader binding is provisioned in the target environment. Local tests can explicitly set `CODEMODE_REQUIRE_DYNAMIC_WORKER=false` to use the deterministic in-process fallback.

Run `npm run mcp:measure` after surface changes. The current local measurement is 29 default native tools, 37 total native handlers with output schemas, 46 catalog entries, and 2 Code Mode tools. As of 2026-04-29, the Code Mode descriptor is 1,773 bytes, while exact capability schemas live behind `search` detail results instead of the two default tool descriptors.

Run `npm run verify` for the local gateway gate. Run `npm run verify:release` against the first staged Worker before enabling production Code Mode. Set `MCP_BASE_URL` to the staged gateway URL and optionally set `MCP_BEARER_TOKEN` to cover authenticated `execute` checks.

## Prompt workflows

The server now exposes optional MCP prompts as user-invoked workflow starters. They are not required for tool correctness, but they help agents consistently ask for the missing launch details instead of improvising:

- `publish_creation_end_to_end`
- `polish_public_launch`
- `recover_publish_failure`
- `decide_when_to_use_pulses`

These prompts are intended to steer first-run behavior such as:
- asking whether the user wants SEO and social preview polish for a public launch
- asking whether the user already has a cover image or wants generated art
- checking account capabilities before promising premium polish or pulse-backed behavior
- teaching Pulse capability APIs only: policy-mediated `env.fetch`, policy-bound `env.secrets.bearer/header/query/verifyHmac`, provider-helper `env.webhooks.verify("stripe")` as the first certified helper, generic HMAC format presets such as `github-sha256`, `shopify-hmac-sha256`, and `slack-v0` for non-Stripe signed webhooks until fixture-backed helpers exist, provider-scoped `env.connections.use(provider).fetch`, structured `env.log`, sanitized `env.request`, safe `env.runtime`, and best-effort `env.waitUntil`
- keeping recovery flows in plain language instead of dumping operation internals

## Troubleshooting

### ChatGPT works, generic MCP login fails

Check:
1. `GET /.well-known/oauth-authorization-server`
2. confirm the client can either use a preregistered public client ID or see `registration_endpoint`
3. confirm `token_endpoint_auth_methods_supported` includes `none`
4. confirm `GET /mcp` returns `405`, not plain text

### Generic client says auth is unsupported

The most common causes are:
- stale client-side auth metadata cache
- missing preregistered-client support or missing dynamic registration support in the client
- old server metadata cached before the compatibility layer was deployed

### Clerk DCR toggle confusion

The gateway no longer relies on Clerk exposing DCR directly to clients. Clerk still handles user identity. The gateway presents the generic OAuth surface.

### Clerk domain confusion

The production gateway should not use `accounts.vibecodr.space` as its issuer or
discovery URL. That domain is Clerk's Account Portal UI. The gateway discovers
upstream OAuth through Vibecodr's Clerk Frontend API proxy at
`https://vibecodr.space/__clerk`, while exposing MCP-facing OAuth metadata at
`https://openai.vibecodr.space`.

`clerk.vibecodr.space` should exist as Clerk DNS verification for the Frontend
API custom domain, but this Clerk instance can still return metadata whose
issuer and token endpoints canonicalize to `https://vibecodr.space/__clerk`.
That canonicalized metadata is the contract the gateway follows.

For user-facing browser auth, configure Clerk Component paths to the Vibecodr
application-domain pages (`/sign-in` and `/sign-up`) so the MCP flow does not
depend on the Account Portal being reachable.

### Renewable ChatGPT auth

To avoid forcing ChatGPT users back through auth after the first successful link:

1. include `offline_access` in `OAUTH_SCOPES`
2. let the gateway keep the upstream Clerk refresh token server-side
3. let the MCP client rotate only gateway-issued refresh tokens through `/token`

This keeps the refresh loop inside the gateway and avoids exposing provider refresh tokens to clients.

## Design decision

This is one product, not two separate products.

- All clients share tools and business logic.
- The gateway compatibility layer exists to make OAuth usable for strict remote MCP clients.
- The first-party CLI remains a separate client/distribution package, not a second server.
- A ChatGPT widget or OpenAI app package should only return after a fresh product/security decision, and then as an optional UI resource layered onto this same MCP server.
