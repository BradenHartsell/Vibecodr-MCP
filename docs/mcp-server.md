# Vibecodr MCP Server

## Purpose

Vibecodr exposes one MCP product with two client modes:

- ChatGPT app mode for the guided publish-and-manage experience
- generic MCP client mode for Codex, Cursor, VS Code, and other MCP-capable tools

The tool surface is shared. The difference is in the client integration and auth path.

## Endpoints

Base application:
- `GET /health`
- `GET /widget`
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

This preserves the existing ChatGPT flow while removing the need for manual token entry in generic MCP clients.

Do not confuse the two auth entrypoints:
- `/authorize` is the MCP OAuth entrypoint and is the correct path for Codex, Cursor, VS Code, Windsurf, and other remote MCP clients
- `/auth/start` is the browser/widget login entrypoint used by the hosted widget flow and normally returns to `/widget`

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

## ChatGPT app mode

ChatGPT app mode uses the shared tool surface and widget, but ChatGPT is typically configured with an explicit OAuth client during app setup.
When `offline_access` is available, ChatGPT can refresh through the gateway without forcing the user back through the Clerk login flow.
The gateway keeps refresh-token rotation retry-safe for a short window so native/public clients can survive duplicate startup refresh attempts without self-revoking the session.

This mode is optimized for:
- guided publishing
- account connection
- widget-rich tool output
- launch polish
- live vibe follow-up

## Generic MCP mode

Generic MCP mode is optimized for clients that want standards-compliant MCP over Streamable HTTP without manual token entry.

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

## Tool classes

Public informational tools:
- `get_vibecodr_platform_overview`
- `get_guided_publish_requirements`
- `get_launch_best_practices`
- `get_pulse_setup_guidance`

Authenticated publish/manage tools:
- `get_account_capabilities`
- `quick_publish_creation`
- `get_publish_readiness`
- `list_my_live_vibes`
- `get_live_vibe`
- `get_vibe_engagement_summary`
- `get_vibe_share_link`
- `update_live_vibe_metadata`

Recovery tools:
- `list_import_operations`
- `get_import_operation`
- `watch_operation`
- `compile_draft_capsule`
- `publish_draft_capsule`
- `explain_operation_failure`
- `cancel_import_operation`

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

### Renewable ChatGPT auth

To avoid forcing ChatGPT users back through auth after the first successful link:

1. include `offline_access` in `OAUTH_SCOPES`
2. let the gateway keep the upstream Clerk refresh token server-side
3. let ChatGPT rotate only gateway-issued refresh tokens through `/token`

This keeps the refresh loop inside the gateway and avoids exposing provider refresh tokens to clients.

## Design decision

This is one product, not two separate products.

- ChatGPT app mode and generic MCP mode share tools and business logic.
- The gateway compatibility layer exists only to make OAuth usable for clients that are stricter than ChatGPT.
