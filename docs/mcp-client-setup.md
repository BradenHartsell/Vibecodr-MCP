# Vibecodr MCP Client Setup

This document covers current setup patterns for remote Streamable HTTP MCP clients.

Canonical MCP endpoint:
- \`https://openai.vibecodr.space/mcp\`

Canonical auth flow:
- OAuth through the Vibecodr gateway compatibility layer
- no manual bearer-token entry required
- Clerk remains the identity provider behind the gateway

Important:
- `/authorize` is the MCP OAuth entrypoint for remote MCP clients
- `/auth/start` is the browser/widget auth flow and usually returns to `/widget`
- if you are validating a coding-agent or ChatGPT MCP connection, test `/authorize`

Expected session behavior:
- the initial MCP access token is short-lived, about 1 hour
- the gateway also issues a refresh token when `offline_access` is present
- clients such as Codex should refresh automatically, so the login should persist instead of disappearing after a few minutes
- official first-party installs and other native/public clients should tolerate a short duplicate refresh on startup or reconnect without burning the session
- if the client sends the user back through sign-in, treat that as a refresh-path bug or an upstream revocation event

## Shared expectations

Before testing protected tools in any client:

1. add the Vibecodr MCP server using the client's remote HTTP / Streamable HTTP config
2. trigger the client's MCP OAuth login flow
3. complete the browser sign-in with Vibecodr / Clerk
4. return to the client and confirm the server is authenticated
5. test with:
   - \`What is Vibecodr?\`
   - \`What can my Vibecodr account do right now?\`
   - \`List my live vibes.\`

If you want to inspect the command surface directly from CLI instead of waiting for an agent UI to infer it:
- run `initialize`
- then run `tools/list`
- or use the helper in this repo:
  - `npm run mcp:tools`
  - `node scripts/list-mcp-tools.mjs --raw`

That is the same MCP tool surface the app uses. The widget adds UI, but it does not create a second hidden command set.

## Codex

Codex has native MCP management.

Add the server:
\`\`\`powershell
codex mcp add vibecodr-space --url https://openai.vibecodr.space/mcp
\`\`\`

Inspect:
\`\`\`powershell
codex mcp list
\`\`\`

Notes:
- the server exposes protected-resource metadata plus a gateway OAuth layer for protected remote MCPs
- current public Codex docs explicitly document \`codex mcp add\`, \`codex mcp list\`, and direct \`~/.codex/config.toml\` editing
- treat any separate Codex-side login UX for protected HTTP MCPs as build-specific behavior that should be live-tested, not as a guaranteed public command surface
- if auth state looks stale, restart Codex and retry the protected action

## Cursor

Official docs:
- [Cursor MCP docs](https://docs.cursor.com/en/context/mcp)

Cursor supports Streamable HTTP and OAuth for remote MCP servers.

### UI setup
1. Open \`Cursor Settings -> MCP\`
2. Add a new MCP server
3. Choose remote HTTP / Streamable HTTP
4. Set the URL to:
   - \`https://openai.vibecodr.space/mcp\`
5. Save and start the OAuth login flow when prompted

### File-based setup
Create:
- \`~/.cursor/mcp.json\`

Example:
\`\`\`json
{
  "mcpServers": {
    "vibecodr-space": {
      "type": "http",
      "url": "https://openai.vibecodr.space/mcp"
    }
  }
}
\`\`\`

Notes:
- Cursor's docs describe OAuth support for remote Streamable HTTP servers
- if Cursor caches an older auth state, reload MCP settings or restart Cursor before retrying login

## Windsurf

Official docs:
- [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp)

Windsurf supports Streamable HTTP and OAuth for remote MCP servers.

Config file:
- \`~/.codeium/windsurf/mcp_config.json\`

Example:
\`\`\`json
{
  "mcpServers": {
    "vibecodr-space": {
      "serverUrl": "https://openai.vibecodr.space/mcp"
    }
  }
}
\`\`\`

Alternative:
- add the server from \`Windsurf Settings -> Cascade -> MCP Servers\`

Notes:
- Windsurf's docs use \`serverUrl\` for remote HTTP MCPs
- enterprise/team admins may need to allow or whitelist the server

## VS Code

Official docs:
- [Add and manage MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)

VS Code supports remote HTTP MCP servers and OAuth.

### User profile config
Open user MCP config with:
- \`MCP: Open User Configuration\`

Or create/edit the profile MCP config file.

Example:
\`\`\`json
{
  "servers": {
    "vibecodr-space": {
      "type": "http",
      "url": "https://openai.vibecodr.space/mcp"
    }
  }
}
\`\`\`

### Workspace config
Create:
- \`.vscode/mcp.json\`

With the same \`servers\` block as above.

### CLI install
You can also add it with the VS Code CLI:
\`\`\`bash
code --add-mcp "{\"name\":\"vibecodr-space\",\"type\":\"http\",\"url\":\"https://openai.vibecodr.space/mcp\"}"
\`\`\`

Notes:
- VS Code will prompt for trust before starting a new MCP server
- use the MCP server list UI to restart or re-authenticate if needed

## OpenCode

Official docs:
- [OpenCode config docs](https://opencode.ai/docs/config)

OpenCode supports remote MCP servers via the \`mcp\` config block.

Global config file:
- \`~/.config/opencode/opencode.json\`

Example:
\`\`\`json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vibecodr-space": {
      "type": "remote",
      "url": "https://openai.vibecodr.space/mcp",
      "enabled": true
    }
  }
}
\`\`\`

Notes:
- OpenCode merges remote, global, and project config
- keep Vibecodr in global config unless a project-specific override is actually needed

## Antigravity

Public Antigravity MCP docs are not currently easy to verify from indexed official documentation.

Current MCP registry examples for Antigravity consistently use:
- an \`mcp_config.json\` file
- an \`mcpServers\` object
- remote servers referenced by URL / serverUrl

Recommended configuration shape:
\`\`\`json
{
  "mcpServers": {
    "vibecodr-space": {
      "serverUrl": "https://openai.vibecodr.space/mcp"
    }
  }
}
\`\`\`

Notes:
- treat this as the current best-known integration pattern, not a fully official Antigravity schema guarantee
- if Antigravity exposes a settings UI for custom MCP servers in your build, prefer that UI over editing files by hand
- after configuration, refresh MCP servers and trigger the OAuth login flow

Reference examples using Antigravity MCP config patterns:
- [Chrome DevTools MCP registry example](https://github.com/mcp/ChromeDevTools/chrome-devtools-mcp)
- [Context7 MCP registry example](https://github.com/mcp/io.github.upstash/context7)

## OAuth expectations

The Vibecodr gateway now exposes:
- \`GET /.well-known/oauth-authorization-server\`
- \`GET /.well-known/openid-configuration\`
- \`GET /.well-known/oauth-client/vibecodr-mcp.json\`
- \`POST /register\`
- \`GET /authorize\`
- \`POST /token\`
- \`POST /revoke\`

The official Vibecodr CLI can use the committed URL-based client metadata document at `/.well-known/oauth-client/vibecodr-mcp.json`. Other generic clients can dynamically register and authenticate through the gateway. In both cases, the gateway delegates the actual user login to Clerk.

For downloaded CLI wrappers and one-command npm installers, the important server-side contract is:
- refresh tokens are still rotated
- the just-used token can replay the successful refresh response for a short window
- duplicate startup or reconnect refresh attempts should not force immediate re-authentication

## Troubleshooting

### Client says auth is unsupported
- refresh or restart the client
- verify it is using:
  - \`https://openai.vibecodr.space/mcp\`
- verify the gateway auth metadata loads:
  - [authorization server metadata](https://openai.vibecodr.space/.well-known/oauth-authorization-server)

### Login opens but tools still act unauthenticated
- restart the client after login
- confirm the client shows the server as authenticated
- run a protected prompt such as:
  - \`What can my Vibecodr account do right now?\`

### Remote server trust warnings
Treat the MCP server like any other remote tool provider:
- verify the URL
- verify the domain
- verify the tool list matches Vibecodr expectations
- do not approve lookalike domains

## Should this be an npm package?

Yes, but not in this repository.

Best current server distribution is still:
- remote HTTP MCP server at \`https://openai.vibecodr.space/mcp\`

Best current packaging boundary is:
- keep this repo focused on the hosted MCP server, OAuth gateway, and ChatGPT app integration
- ship any public CLI installer/runtime from a separate repo under a permissive license so hosted-service use remains clearly distinct from commercial reuse of this PolyForm-licensed source tree

That separate package can add real product value when it owns:
- direct CLI login, status, tool listing, and tool invocation against the hosted MCP server
- one-command install and uninstall adapters for Codex, Cursor, VS Code, and Windsurf
- local doctor and troubleshooting flows for browser launch, secret storage, and OAuth discovery

The hosted server remains the source-of-truth endpoint either way. The CLI should be a client product around that endpoint, not a second server implementation inside this repo.
