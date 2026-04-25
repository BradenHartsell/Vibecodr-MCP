# Canonical Architecture

This repository is the canonical hosted MCP gateway for Vibecodr.

## Product Boundary

Vibecodr has one hosted MCP server:

- production MCP URL: `https://openai.vibecodr.space/mcp`
- production OAuth gateway URL: `https://openai.vibecodr.space`
- source repo: `Vibecodr-MCP`
- package/runtime identity: `vibecodr-mcp-gateway`

Codex, ChatGPT, Cursor, VS Code, Windsurf, and other MCP-capable clients all use this same remote MCP server. ChatGPT is a client of the server, not a separate server product.

The `openai.vibecodr.space` hostname is retained for client compatibility. It is the current production MCP endpoint even though the hostname reflects earlier ChatGPT/OpenAI app exploration.

## What Is Collapsed

The active production design is:

- one MCP transport at `/mcp`
- one OAuth compatibility layer at `/.well-known/*`, `/authorize`, `/token`, `/register`, and `/revoke`
- one tool and prompt registration surface shared by all MCP clients
- one Cloudflare Worker deployment path for the hosted gateway
- no embedded ChatGPT widget surface
- no separate OpenAI app server

The former widget concept is intentionally absent. `resources/list` stays empty, removed `ui://widget/*` resources stay unavailable, and tool metadata must not advertise `openai/outputTemplate` unless a future product/security decision deliberately restores a widget.

## CLI Boundary

The first-party CLI is separate by design:

- CLI repo: `Vibecodr-MCP-CLI`
- package name: `@vibecodr/mcp`
- executable names: `vibecodr`, `vibecodr-mcp`
- default server URL: `https://openai.vibecodr.space/mcp`

The CLI is a client and installer surface, not the hosted server. It can log itself into the MCP gateway, discover tools, call tools, and write editor MCP config. It does not share token storage with Codex, Cursor, VS Code, Windsurf, or ChatGPT; each MCP client owns its own OAuth session.

## Auth Model

Clerk remains upstream identity. The gateway owns the MCP-compatible OAuth surface:

1. The MCP client discovers protected-resource and authorization-server metadata.
2. The client uses the official client metadata document or dynamic registration.
3. The gateway sends the user to Clerk.
4. Clerk returns to the gateway callback.
5. The gateway issues an MCP authorization code and then gateway access/refresh tokens.
6. Protected MCP calls use gateway bearer tokens.

The gateway keeps upstream provider refresh material server-side and gives clients only gateway-issued refresh tokens. With `offline_access`, clients should refresh without asking the user to sign in again unless the session is revoked, expires upstream, or the client discards its stored OAuth state.

## Cloudflare Deployment Boundary

The production Cloudflare Worker resource is currently named `vibecodr-openai-gateway`. That infrastructure name is retained to preserve existing routes, logs, bindings, and Wrangler secrets. Do not rename the production Worker casually; Worker secrets are scoped to the Worker service name.

New deployments and local examples should use the neutral product name `vibecodr-mcp-gateway`, but production continuity takes priority over aesthetic renaming.

## Compatibility Rules

- Keep `/mcp` Streamable HTTP compatible.
- Keep OAuth metadata stable for remote clients.
- Keep `https://openai.vibecodr.space/mcp` stable until every known client has migrated to any future hostname.
- Keep hidden recovery tools callable by exact name even when not advertised in default `tools/list`.
- Keep Code Mode opt-in until the Cloudflare Worker Loader binding is provisioned and release-verified.
- Keep widget resources absent unless explicitly reintroduced by a fresh product/security decision.
