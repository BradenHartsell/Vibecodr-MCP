# Deployment Wiring

## Runtime model

- Containerized Node runtime
- HTTP endpoints:
  - /health
  - /mcp
  - /auth/start
  - /auth/callback

## Cloudflare runtime model

- Edge Worker runtime entrypoint: `src/worker.ts`
- Wrangler config:
  - `deploy/cloudflare/wrangler.gateway.toml.example`
  - local override: `deploy/cloudflare/wrangler.gateway.toml` (gitignored)
- Internal API dispatch:
  - Service Binding `VIBE_API`
- Operation persistence:
  - KV namespace binding `OPERATIONS_KV`

## Required environment variables

- PORT
- APP_BASE_URL
- VIBECDR_API_BASE
- SESSION_SIGNING_KEY
- OAUTH_CLIENT_ID

OAuth endpoint configuration (pick one):

1. Issuer/discovery mode (recommended):
- OAUTH_ISSUER_URL (or OAUTH_DISCOVERY_URL)

2. Explicit mode:
- OAUTH_AUTHORIZATION_URL
- OAUTH_TOKEN_URL

Optional:
- OAUTH_CLIENT_SECRET
- OAUTH_PROVIDER_NAME
- OAUTH_SCOPES
- OAUTH_REDIRECT_URI
- OAUTH_AUDIENCE
- COOKIE_SECURE

For Vibecodr production, the gateway should discover Clerk through the
Frontend API proxy on the application domain:

- `OAUTH_ISSUER_URL=https://vibecodr.space/__clerk`
- `OAUTH_DISCOVERY_URL=https://vibecodr.space/__clerk/.well-known/openid-configuration`

Do not use `accounts.vibecodr.space` for these values. That domain is Clerk's
Account Portal UI and can be challenged or unavailable independently of the
machine OAuth endpoints.

## Build and run locally with Docker

1. Build image:
- docker build -t vibecodr-openai-app:local .

2. Run container:
- docker run --rm -p 8787:8787 --env-file .env vibecodr-openai-app:local

3. Verify:
- curl http://localhost:8787/health

## Platform deployment checklist

1. Set all required env vars.
2. Ensure APP_BASE_URL is public HTTPS URL.
3. Ensure OAuth app redirect URI includes:
- https://<your-domain>/auth/callback
4. Ensure production MCP URL is:
- https://<your-domain>/mcp
5. Ensure Clerk Component paths send sign-in/sign-up/sign-out flows to the
   Vibecodr application domain, not the Account Portal, for the MCP production
   browser flow:
- https://vibecodr.space/sign-in
- https://vibecodr.space/sign-up
6. Ensure Vibecodr API accepts OAuth provider access tokens at:
- POST /auth/cli/exchange
7. Validate:
- npm run validate:env
- npm run build
- /health returns 200
- OAuth login roundtrip succeeds
- tools/list works from /mcp

