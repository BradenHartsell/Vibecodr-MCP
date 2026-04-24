# Clerk OAuth Setup For Vibecodr OpenAI App

This document captures the exact information needed to complete real account linking so imported creations publish to the authenticated Vibecodr user.

## 1. Clerk OAuth application

Create an OAuth app in Clerk with:

- Redirect URI (local example):
  - `http://localhost:3000/oauth_callback`
- Redirect URI (production):
  - `https://<app-domain>/auth/callback`
- Client type:
  - confidential (recommended for server-side token exchange)

Collect:

- `OAUTH_CLIENT_ID`
- `OAUTH_CLIENT_SECRET` (if confidential)
- `OAUTH_SCOPES=openid profile email offline_access`
- issuer domain (for example `https://<your-clerk-domain>`)

## 2. App environment

Set:

- `APP_BASE_URL=https://<app-domain>` (or local URL)
- `SESSION_SIGNING_KEY=<long-random-secret>`
- `OAUTH_PROVIDER_NAME=clerk`
- `OAUTH_CLIENT_ID=<from-clerk>`
- `OAUTH_CLIENT_SECRET=<from-clerk>` (if confidential)
- `OAUTH_SCOPES=openid profile email offline_access`
- `OAUTH_ISSUER_URL=https://<your-clerk-domain>`

You can optionally use explicit endpoints instead:

- `OAUTH_AUTHORIZATION_URL`
- `OAUTH_TOKEN_URL`

Callback handling supports both:

- `/auth/callback`
- `/oauth_callback`

For Cloudflare Worker deployment, set runtime variables in:

- `deploy/cloudflare/wrangler.gateway.toml.example`
- local override: `deploy/cloudflare/wrangler.gateway.toml` (gitignored)

And keep secrets in Wrangler (not in vars):

- `SESSION_SIGNING_KEY`
- `OAUTH_CLIENT_SECRET`

## 3. Vibecodr API exchange requirement

Vibecodr API must expose:

- `POST /auth/cli/exchange`

Request body:

\`\`\`json
{ "access_token": "<oauth_access_token>" }
\`\`\`

Response body:

\`\`\`json
{
  "token_type": "Bearer",
  "access_token": "<vibecodr_publish_token>",
  "expires_at": 1739999999,
  "user_id": "user_123"
}
\`\`\`

The `user_id` and `access_token` are used to bind all imports and publishing actions to the user account.

## 4. Local retrievable secret storage

Saved local secret file:

- `deploy/cloudflare/secrets.local.env`

This file is gitignored and can be used as your local source-of-truth for the Clerk app credentials.

## 5. Smoke tests

1. Browser flow: start app and hit `/auth/start`:
- expect 302 to Clerk authorization endpoint with PKCE parameters.
2. Complete login:
- expect redirect to `/`.
3. Hit `/api/auth/session`:
- expect `authenticated: true`.
4. Call MCP `tools/call` `list_vibecodr_drafts`:
- expect user-scoped draft list from Vibecodr.
5. Worker persistence check:
- ensure `OPERATIONS_KV` namespace is bound and operation state is preserved across requests.

MCP OAuth flow is different:
- start at `/authorize`, not `/auth/start`
- expect redirect to Clerk
- after approval, the gateway should redirect to the MCP client's registered `redirect_uri`, not to `/`

## 6. Security notes

- Keep `SESSION_SIGNING_KEY` and `OAUTH_CLIENT_SECRET` in secret manager.
- Enforce HTTPS and set `COOKIE_SECURE=true` in production.
- Prefer short token lifetimes on Vibecodr exchange tokens.
- Since the client secret was shared in chat, rotate it after local verification.


## 7. Clerk OAuth application toggles

Recommended for this architecture:

- Dynamic client registration: OFF
- Generate access tokens as JWTs: OFF (enable only if Vibecodr API requires local JWT validation instead of introspection/exchange)
