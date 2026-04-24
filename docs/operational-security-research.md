# Operational Security Research And Configuration Runbook

This runbook consolidates what is needed to make the Vibecodr MCP gateway secure and operational with a dedicated gateway service.

## 1. Remote MCP requirements (production)

### MCP endpoint and hosting
- MCP server must be publicly reachable over HTTPS for remote MCP clients.
- Localhost is acceptable for local testing only, not production use.

### Tools and metadata
- Tool descriptors should include proper security schemes and auth challenge behavior.
- The server does not expose widget resources or Apps SDK UI metadata.

## 2. Cloudflare deployment requirements (secure baseline)

### Secrets handling
- Do not store sensitive values in Wrangler `vars`; use Worker secrets.
- Keep local secrets in `.dev.vars` or `.env` files, and never commit them.

### Routing and domain
- Use Custom Domain or Routes for production, not `workers.dev` as primary business endpoint.
- Prefer a dedicated gateway domain for the MCP endpoint.

### Internal service communication
- Use Service Bindings for Worker-to-Worker communication to avoid public internal API exposure.

## 3. Clerk OAuth hardening requirements

### Redirects
- Local: `http://localhost:3000/oauth_callback`
- Production: `https://<domain>/auth/callback`

### Application settings
- Dynamic client registration: OFF
- JWT access-token generation: OFF unless Vibecodr API explicitly requires JWT local verification.

### Scopes
- Keep `openid profile email` baseline.
- Include `offline_access` when an MCP client should stay authorized without sending the user back through the login flow.

## 4. Security controls implemented in this repo

- Enforced minimum `SESSION_SIGNING_KEY` length (32 chars).
- Enforced production `APP_BASE_URL` HTTPS requirement.
- Added `ALLOW_MANUAL_TOKEN_LINK` flag, default OFF.
- Sanitized `return_to` query input to prevent open redirect.
- Added `npm run security:preflight` guard script.
- Added Cloudflare secure deployment assets and secrets automation helper:
  - `deploy/cloudflare/README.md`
  - `deploy/cloudflare/wrangler.gateway.toml.example`
  - `deploy/cloudflare/set-secrets.ps1`

## 5. Final secure go-live sequence

1. Set production env/secrets (do not commit secret files).
2. Run:
- `npm run validate:env`
- `npm run security:preflight`
- `npm run build`
3. Deploy gateway endpoint on public HTTPS domain.
4. Configure Clerk production redirect URI.
5. Verify end-to-end:
- `/health`
- `/auth/start` redirect to Clerk
- callback establishes authenticated session
- MCP tool calls succeed with authenticated draft operations

## Sources

- Cloudflare docs:
  - https://developers.cloudflare.com/workers/development-testing/environment-variables/
  - https://developers.cloudflare.com/workers/wrangler/configuration/
  - https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
  - https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  - https://developers.cloudflare.com/workers/configuration/routing/
- Clerk docs:
  - https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth
  - https://clerk.com/docs/oauth/scoped-access
