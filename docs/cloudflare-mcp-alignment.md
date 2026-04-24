# Cloudflare MCP Alignment

Last reviewed: 2026-04-24

This server is already shaped like Cloudflare's current remote MCP recommendation in the parts that matter for production clients: it exposes Streamable HTTP at `/mcp`, deploys as a Worker, uses Cloudflare bindings for durable OAuth and operation state, and keeps `vibecodr-api` access behind a service binding when deployed on Cloudflare.

Cloudflare's current docs now split MCP hosting guidance by state needs: `createMcpHandler` is the recommended Streamable HTTP path for stateless remote MCP servers in plain Workers, while `McpAgent` is for stateful Agent-backed servers that need persisted session state, Agent state APIs, elicitation/sampling, hibernation, or legacy SSE. This repository intentionally keeps its custom handler for now because it also serves generic MCP OAuth compatibility endpoints and Vibecodr-specific auth challenges. Replacing that handler should be a dedicated transport refactor, with `createMcpHandler` as the first official-transport target and `McpAgent` adopted only if a real stateful MCP requirement appears.

Codemode is useful when an MCP server exposes many fine-grained tools and the model needs to chain them with loops, conditionals, and recovery logic. Vibecodr's public tool surface should continue to prefer goal-shaped tools such as quick publish, account capabilities, runtime readiness, and live-vibe refinement. The gateway now exposes an opt-in `/mcp?codemode=search_and_execute` route to dogfood the search/execute shape before making any default-client change.

Current alignment decisions:

- Keep `/mcp` as the single Streamable HTTP endpoint for remote clients.
- Keep OAuth on the gateway endpoints: `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, and `/revoke`.
- Keep production OAuth and refresh state on `OPERATIONS_KV` plus `AUTH_CODE_COORDINATOR`; memory stores are local-dev fallbacks only.
- Keep Cloudflare rate-limit bindings for production abuse control, with the fixed-window in-memory limiter only as a local fallback.
- Use `__Host-vc_session` for secure production cookies and keep reading `vc_session` as a migration fallback.
- Enable Workers Logs and Traces in Wrangler config so auth, MCP, and upstream API failures are diagnosable after deploy.
- Keep native `/mcp` as the default compatibility surface while Code Mode is opt-in at `/mcp?codemode=search_and_execute`.

Codemode adoption criteria:

- Add Codemode only behind an explicit feature flag or separate route while it is beta.
- Do not expose Vibecodr user tokens, Clerk tokens, or gateway refresh grants to the Codemode sandbox; host-side tool handlers must keep credentials outside generated code.
- Configure Dynamic Workers only as the Code Mode execution lane, never as a general user-code sandbox; follow [`dynamic-worker-sandbox-configuration.md`](./dynamic-worker-sandbox-configuration.md).
- Prefer `codeMcpServer` only after the server has an SDK `McpServer` adapter, or build a separate Codemode MCP worker that composes this server as an upstream client.
- Run the existing transport regression and auth tests plus a new Codemode-specific eval before exposing it to production clients.

Detailed migration plan:
- [`cloudflare-mcp-production-architecture-spec.md`](./cloudflare-mcp-production-architecture-spec.md)
- [`cloudflare-codemode-migration-plan.md`](./cloudflare-codemode-migration-plan.md)
