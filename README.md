# Vibecodr.Space OpenAI App

Production-grade ChatGPT App and ingestion service for importing vibecoded creations from Codex and ChatGPT into Vibecodr.

## Documentation

- [docs/mcp-server.md](docs/mcp-server.md)
- [docs/mcp-client-setup.md](docs/mcp-client-setup.md)
- [docs/openai-app.md](docs/openai-app.md)
- [docs/public-repo.md](docs/public-repo.md)

## Repo scope

This repository is the public-facing gateway for the Vibecodr ChatGPT app and MCP server.

It contains:

- the MCP server and tool surface
- the ChatGPT widget
- the OAuth gateway layer
- the import/publish orchestration that talks to Vibecodr

It does **not** contain the full `vibecodr.space` frontend or the full private `api.vibecodr.space` backend source tree.

## License

This code is published under the [PolyForm Noncommercial 1.0.0](LICENSE) license.

That means:

- noncommercial use, study, modification, and sharing are allowed under the license terms
- commercial use is not granted by this public repo license
- this repo is source-available, not OSI-approved open source

The repository license governs the source code in this repo. It does not block normal use of the hosted Vibecodr service. Anyone with a Vibecodr account can use the hosted MCP server, while commercial reuse or resale of this source code still requires separate permission.

See [docs/public-repo.md](docs/public-repo.md) for the public-repo boundary and what is intentionally excluded.

## What is implemented

- MCP endpoint at `/mcp` with Apps-compatible tool catalog
- Cloudflare Worker runtime entrypoint at `src/worker.ts`
- OAuth account linking flow:
  - `/auth/start`
  - `/auth/callback`
  - `/oauth_callback` (alias for local compatibility)
- Vibecodr CLI grant exchange integration:
  - exchanges OAuth access token at Vibecodr `/auth/cli/exchange`
- Ingestion adapters:
  - `codex_v1`
  - `chatgpt_v1`
- Ingestion modes:
  - `direct_files`
  - `zip_import`
  - `github_import`
- Draft, compile, publish, cancel operation tooling
- Draft listing and draft detail tools
- Persistent operation store with idempotency
  - Node runtime: file-backed store in `data/operations.json`
  - Worker runtime: KV-backed store via `OPERATIONS_KV` binding
- Sealed stateless auth session cookies (AES-GCM)
- Submission packaging scripts and deployment wiring

## Local run

1. Install dependencies:
- `npm install`

2. Configure env:
- copy `.env.example` to `.env` or use `.env.local`
- set OAuth and session values

3. Validate env:
- `npm run validate:env`

4. Build and run:
- `npm run build`
- `npm run dev`

Cloudflare local worker:
- `npm run dev:worker`

## MCP client compatibility

The gateway now exposes a generic OAuth compatibility layer for MCP clients that do not have ChatGPT-specific app setup.

Compatible clients should be able to:
- use the official client metadata document at `/.well-known/oauth-client/vibecodr-mcp.json`
- use a preregistered public client when one is issued for other first-party hosted flows
- register dynamically at `/register` when no preregistered client relationship exists
- discover auth metadata at `/.well-known/oauth-authorization-server`
- authorize through `/authorize`
- exchange codes at `/token`

Example Codex setup:
- `codex mcp add vibecodr-space --url https://openai.vibecodr.space/mcp`

Current public Codex docs explicitly document `codex mcp add`, `codex mcp list`, and direct `~/.codex/config.toml` editing for MCP configuration. Protected-HTTP auth behavior should be validated against the current Codex build on first protected use instead of assuming a separate Codex-specific login command surface.

CLI tool discovery:
- the canonical MCP way to discover commands is `initialize` followed by `tools/list`
- this server also exposes optional workflow prompts through `prompts/list` and `prompts/get`
- this repo includes a helper for that:
  - `npm run mcp:tools`
  - raw JSON: `node scripts/list-mcp-tools.mjs --raw`
- this lists the same MCP tool surface the app uses; the widget only changes presentation, not which MCP tools exist

This keeps Clerk as the identity provider while letting generic MCP clients complete OAuth without manual bearer token entry.
When `offline_access` is included, the gateway can renew ChatGPT and MCP sessions with its own refresh tokens while keeping the upstream Clerk refresh token server-side.

Important flow split:
- `GET /auth/start` is the browser/widget auth flow and normally returns to `/widget`
- `GET /authorize` is the MCP OAuth flow used by remote MCP clients and redirects back to the client's registered `redirect_uri`
- if you want to test what Codex, Cursor, VS Code, Windsurf, or ChatGPT MCP actually use, test `/authorize`, not `/auth/start`

Public packaging boundary:
- this repository remains the source-available hosted MCP server and ChatGPT app gateway
- any public CLI installer/runtime should live in a separate permissively licensed repo so hosted-service use stays clearly distinct from commercial reuse of this source code

Token lifetime model for MCP clients:
- the gateway-issued bearer access token is short-lived, roughly 1 hour
- MCP clients also receive a gateway refresh token when `offline_access` is granted
- normal clients should refresh automatically and keep the login alive without sending the user back through sign-in
- refresh rotation is retry-safe for short startup and reconnect races, so a duplicate refresh attempt should replay the successful response instead of invalidating the session
- long-lived authorization only breaks if the user disconnects, the gateway revokes the session, or the upstream Clerk refresh token becomes invalid

## Endpoints

- `GET /health`
- `GET /health/observability`
- `GET /.well-known/oauth-client/vibecodr-mcp.json`
- `GET /widget`
- `GET /auth/start`
- `GET /auth/callback`
- `GET /oauth_callback`
- `POST /mcp`
- `GET /mcp`
- `GET /api/auth/session`
- `POST /api/auth/logout`
- `GET /api/observability/summary`

## OAuth configuration

Required:

- `OAUTH_CLIENT_ID`
- `SESSION_SIGNING_KEY`
- `APP_BASE_URL`
- callback URL must match redirect URI in provider config

Then choose one endpoint strategy:

1. Issuer/discovery mode (recommended):
- `OAUTH_ISSUER_URL` (or `OAUTH_DISCOVERY_URL`)

2. Explicit endpoint mode:
- `OAUTH_AUTHORIZATION_URL`
- `OAUTH_TOKEN_URL`

Optional:

- `OAUTH_CLIENT_SECRET` (for confidential clients)
- `OAUTH_SCOPES` (default: `openid profile email offline_access`)
- `OAUTH_REDIRECT_URI` (override)
- `OAUTH_AUDIENCE`
- `MCP_STATIC_CLIENT_ID` (optional preregistered first-party MCP client)
- `MCP_STATIC_CLIENT_SECRET` (only if that preregistered client is confidential)
- `MCP_STATIC_CLIENT_REDIRECT_URIS` (space- or comma-separated allowlist; loopback http entries ignore only the port)
- `COOKIE_SECURE` (defaults to true when `APP_BASE_URL` uses https)

The official public CLI path now uses the committed URL-based client metadata document served from:

- `https://openai.vibecodr.space/.well-known/oauth-client/vibecodr-mcp.json`

Runtime safety controls:

- `MAX_REQUEST_BODY_BYTES` (default `8500000`)
- `RATE_LIMIT_WINDOW_SECONDS` (default `60`)
- `RATE_LIMIT_REQUESTS_PER_WINDOW` (default `240`)
- `RATE_LIMIT_MCP_REQUESTS_PER_WINDOW` (default `120`)

Gateway/API error responses include `traceId` in JSON and `x-trace-id` response headers for request correlation.
Cloudflare deployments should configure `GLOBAL_RATE_LIMITER` and `MCP_RATE_LIMITER` bindings in Wrangler for cross-isolate enforcement.

## Observability

- Structured telemetry is emitted for:
  - HTTP request completion
  - auth start, challenge, success, and failure
  - MCP method and tool invocation outcomes
  - import/compile/publish lifecycle transitions
  - upstream Vibecodr API latency and status
- Recent telemetry and aggregate metrics are available at:
  - `GET /health/observability`
  - `GET /api/observability/summary` (requires authenticated session)
- Active alerts are surfaced in both observability endpoints under `alerts`, with `alertCount` on `/health/observability`.
- Core counters emitted:
  - `imports_started_total`
  - `imports_completed_total`
  - `imports_failed_total`
  - `compile_failures_total`
  - `publish_failures_total`
  - `auth_challenge_total`
  - `auth_failure_total`
  - `duplicate_idempotency_hits_total`

The callback flow exchanges provider access token to Vibecodr publish-scoped token using:

- `POST VIBECDR_API_BASE/auth/cli/exchange` with body:
  - `{ "access_token": "<oauth_access_token>" }`

## Local secret storage

A local non-repo secret env file can be stored at:

- `deploy/cloudflare/secrets.local.env`

You can keep your retrievable credentials there and copy values into runtime env as needed.

## Clerk setup checklist

1. Create a Clerk OAuth application for this app.
2. Configure callback URL:
- `https://<your-domain>/auth/callback`
3. Set:
- `OAUTH_CLIENT_ID`
- `OAUTH_CLIENT_SECRET` (if Clerk app is confidential)
- `OAUTH_ISSUER_URL=https://<your-clerk-domain>` (or set explicit endpoints)
4. Ensure Vibecodr API is configured to accept Clerk-issued access tokens at:
- `POST /auth/cli/exchange`

## MCP tools

- `get_upload_capabilities`
- `list_import_operations`
- `get_import_operation`
- `watch_operation`
- `get_publish_readiness`
- `explain_operation_failure`
- `list_vibecodr_drafts`
- `get_vibecodr_draft`
- `start_creation_import`
- `quick_publish_creation`
- `compile_draft_capsule`
- `publish_draft_capsule`
- `cancel_import_operation`

Recommended first impression flow for ChatGPT/Codex users:

1. `quick_publish_creation` (one-shot import + compile + publish)
2. `watch_operation` (if quick flow times out while waiting on async import jobs)
3. `get_publish_readiness` (if user wants explicit gate checks before publish)
4. `explain_operation_failure` (if any step fails and user needs recovery guidance)

`quick_publish_creation` supports:

- `sourceType`: `chatgpt_v1 | codex_v1`
- `payload`: normalized creation package payload
- `autoCompile`: defaults to `true`
- `timeoutSeconds`, `pollIntervalMs`
- publish metadata options: `visibility`, `coverKey`, `thumbnailFile`, `thumbnailUpload`, `seo`

All tools now define `outputSchema` and runtime output validation to keep `structuredContent` contract-stable for ChatGPT routing and first-run reliability.
Structured tool errors include `errorId` for deterministic troubleshooting and support handoff.

`publish_draft_capsule` supports optional publish metadata:

- `visibility`: `public | unlisted | private`
- `coverKey`: existing uploaded key (for example `thumbnails/<user>/<id>.png`)
- `thumbnailFile`: preferred OpenAI-hosted file reference from ChatGPT/widget uploads:
  - `fileId`
  - `downloadUrl`
  - `contentType`
  - `fileName` (optional)
  - accepted mime: `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/gif`
  - max size: `5 MB`
- `thumbnailUpload`: upload + attach in one call:
  - `contentType`
  - `fileBase64`
  - `fileName` (optional)
  - accepted mime: `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/gif`
  - inline raw file should stay under `900 KB`
  - fallback only when `thumbnailFile` is unavailable or the widget upload APIs are not present
  - uploaded launch art now follows vibe visibility automatically: public/unlisted publishes use the public `app_cover` lane and private publishes use the private `standalone` lane
- `seo`:
  - `title`, `description`, `imageKey`
  - `og`: `title`, `description`, `imageKey`
  - `twitter`: `title`, `description`, `imageKey`

## Deployment

See:
- `deploy/README.md`
- `Dockerfile`
- `deploy/cloudflare/README.md`
- `deploy/cloudflare/wrangler.gateway.toml.example`

For local deployment, copy the example file to `deploy/cloudflare/wrangler.gateway.toml` and keep that local override out of Git.

## Submission packaging

Prepare submission bundle:

- `npm run package:submission`

Output:
- `dist/submission-bundle/`


## Security preflight

Run before production deploy:

- `npm run validate:env`
- `npm run security:preflight`
- `npm run security:regression`
- `npm run build`

## Cloudflare deployment (secure gateway pattern)

See:

- `deploy/cloudflare/README.md`
- `deploy/cloudflare/wrangler.gateway.toml.example`
- `deploy/cloudflare/set-secrets.ps1`
