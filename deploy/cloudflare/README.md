# Cloudflare Deployment: Vibecodr OpenAI Gateway Worker

This repo now includes a real Cloudflare Worker runtime at `src/worker.ts` and a ready-to-fill Wrangler config at:

- `deploy/cloudflare/wrangler.gateway.toml.example`

## Architecture

- Public Worker: `vibecodr-openai-gateway`
  - Hosts OAuth endpoints, MCP endpoint, auth session APIs
  - Runs on `openai.vibecodr.space`
- Internal Vibecodr API Worker: `vibecodr-api`
  - Invoked through Cloudflare Service Binding `VIBE_API`
  - Not required to be publicly exposed for gateway-to-api communication
- Clerk Frontend API proxy:
  - Production OAuth discovery/token exchange uses `https://vibecodr.space/__clerk`
  - `clerk.vibecodr.space` must exist as a DNS-only CNAME for Clerk domain verification, but this Clerk instance currently canonicalizes OAuth metadata to the `__clerk` proxy URL
- Clerk Account Portal:
  - `accounts.vibecodr.space` is a human UI surface only
  - Do not use it as `OAUTH_ISSUER_URL` or `OAUTH_DISCOVERY_URL`
- KV namespace: `OPERATIONS_KV`
  - Stores import operation state/idempotency in Worker runtime
- Worker Rate Limiting bindings:
  - `GLOBAL_RATE_LIMITER` and `MCP_RATE_LIMITER`
  - Enforced by Cloudflare runtime (cross-isolate), with app-memory fallback for local Node runtime

## One-time setup

1. Authenticate Wrangler:
- `npx wrangler whoami`

2. Create KV namespaces:
- `npx wrangler kv namespace create OPERATIONS_KV`
- `npx wrangler kv namespace create OPERATIONS_KV --preview`

3. Copy `deploy/cloudflare/wrangler.gateway.toml.example` to `deploy/cloudflare/wrangler.gateway.toml`, then paste namespace IDs into:
- `deploy/cloudflare/wrangler.gateway.toml`
  - `[[kv_namespaces]].id`
  - `[[kv_namespaces]].preview_id`

4. Ensure service binding target exists:
- Worker service name in config must match your internal API worker:
  - `[[services]].service = "vibecodr-api"`

5. Set ratelimit namespace IDs in Wrangler config:
- `[[ratelimits]].namespace_id` must be unique per account (string/number)
- Example values in repo: `41001` (global), `41002` (mcp)

6. Set secrets:
- `npx wrangler secret put SESSION_SIGNING_KEY`
- `npx wrangler secret put OAUTH_CLIENT_SECRET`

You can automate secret upload from your local secret env file:
- `./deploy/cloudflare/set-secrets.ps1`
- `./deploy/cloudflare/set-secrets.ps1 -SecretsFile deploy/cloudflare/secrets.local.env`

Recommended local secret file workflow:
- copy `deploy/cloudflare/secrets.local.env.example` to `deploy/cloudflare/secrets.local.env`
- keep `deploy/cloudflare/secrets.local.env` out of Git

6. Ensure DNS record exists and is proxied:
- Name: `openai`
- Type: `CNAME`
- Target: `vibecodr-openai-gateway.braden-yig.workers.dev`
- Proxy status: Proxied (orange cloud)

7. Ensure Clerk Frontend API verification DNS exists:
- Name: `clerk`
- Type: `CNAME`
- Target: `frontend-api.clerk.services`
- Proxy status: DNS only

## Configure OAuth and domain

Set in your local `deploy/cloudflare/wrangler.gateway.toml`:

- `APP_BASE_URL=https://openai.vibecodr.space`
- `OAUTH_CLIENT_ID=<clerk client id>`
- `OAUTH_ISSUER_URL=https://vibecodr.space/__clerk`
- `OAUTH_DISCOVERY_URL=https://vibecodr.space/__clerk/.well-known/openid-configuration`
- `OAUTH_SCOPES=openid profile email offline_access`
- `MAX_REQUEST_BODY_BYTES=1500000`
- `RATE_LIMIT_WINDOW_SECONDS=60`
- `RATE_LIMIT_REQUESTS_PER_WINDOW=240`
- `RATE_LIMIT_MCP_REQUESTS_PER_WINDOW=120`
- `CODEMODE_ENABLED=false`
- `CODEMODE_DEFAULT=false`
- `CODEMODE_REQUIRE_DYNAMIC_WORKER=true`
- `CODEMODE_ALLOW_NATIVE_FALLBACK=false`
- `CODEMODE_MAX_EXECUTION_MS=5000`
- `CODEMODE_MAX_OUTPUT_BYTES=32768`
- `CODEMODE_MAX_LOG_BYTES=8192`
- `CODEMODE_MAX_NESTED_CALLS=5`

Keep the Worker config aligned with Cloudflare's current MCP/Workers guidance:

- use Streamable HTTP at `/mcp`; do not reintroduce SSE for new clients
- keep `nodejs_compat` enabled because the MCP gateway uses Node-compatible crypto and SDK-adjacent packages
- enable Workers Logs and Traces before production deploy; tune `head_sampling_rate` lower if traffic volume requires it
- keep OAuth state, refresh grants, and operation persistence on Cloudflare bindings rather than in process memory
- `[[ratelimits]]` limits should match these values in production for deterministic behavior
- keep `CODEMODE_ENABLED=false` until `[[worker_loaders]] binding = "CODEMODE_WORKER_LOADER"` is provisioned for this Worker

In Clerk OAuth app:

- Redirect URI:
  - `https://openai.vibecodr.space/auth/callback`
- Component paths:
  - Sign-in page on application domain: `https://vibecodr.space/sign-in`
  - Sign-up page on application domain: `https://vibecodr.space/sign-up`
  - Signing out path on application domain: `https://vibecodr.space/sign-in`
- Keep:
  - Dynamic client registration: OFF
  - JWT access tokens: OFF (unless your API specifically requires JWTs)

## Deploy commands

Local worker dev:
- `npm run dev:worker`

Deploy:
- `npm run deploy:gateway`

## Verification checklist

After deploy, verify:

- `GET /health` returns 200
- `GET /auth/start` redirects to Clerk through `https://vibecodr.space/__clerk/oauth/authorize`
- MCP `/authorize` redirects through the gateway and then to the Vibecodr application-domain sign-in page when the user has no active Clerk session
- OAuth callback sets `__Host-vc_session` in secure production, keeps `vc_session` for local non-HTTPS development, and redirects to `/`
- `GET /api/auth/session` returns `authenticated: true` after login
- `POST /mcp` responds to:
  - `initialize`
  - `tools/list`
  - `tools/call`
- oversize request returns `413 REQUEST_BODY_TOO_LARGE`
- rate-limit breaches return `429 RATE_LIMITED`
- error responses include `traceId` and `x-trace-id`
- for rate-limit load checks, reuse a persistent HTTP session/cookie jar so repeated requests map to one client key

## Security notes

- Keep `SESSION_SIGNING_KEY` and `OAUTH_CLIENT_SECRET` in Wrangler secrets only.
- Keep `COOKIE_SECURE=true` in production.
- Keep `ALLOW_MANUAL_TOKEN_LINK=false` in production.
- Rotate OAuth client secret if it has ever been shared in plaintext.
