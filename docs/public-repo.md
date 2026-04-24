# Public Repo Guide

This repository is the public-facing source for the Vibecodr MCP gateway:

- the MCP server at `/mcp`
- the gateway OAuth compatibility layer for remote MCP clients
- the Vibecodr publish/import orchestration that talks to the private Vibecodr API

It is intentionally **not** the full Vibecodr product monorepo.

## What this repo contains

- MCP transport, tool descriptors, and tool handlers
- OAuth gateway integration with Clerk
- import/compile/publish orchestration logic
- Cloudflare Worker deployment config templates

## What this repo does not contain

- the full `vibecodr.space` frontend application
- the full `api.vibecodr.space` backend source tree
- a public permissively licensed Vibecodr CLI package
- production secrets, private OAuth credentials, or local operator overrides
- local screenshots or review evidence that may contain production user data
- internal agent scaffolding used only for local development workflows

## Public repo hygiene

The following categories are intentionally kept out of the public repository via `.gitignore` or local-only templates:

- `.env*` local environment files, except `.env.example`
- Cloudflare local overrides such as `deploy/cloudflare/wrangler.gateway.toml`
- local secret bundles such as `deploy/cloudflare/secrets.local.env`
- internal agent directories such as `.agent/` and `.agents/`
- local build artifacts (`dist/`, `data/`, `.wrangler/`, `coverage/`)
- local screenshots, review evidence, and staged release artifacts

Use the committed templates instead:

- `.env.example`
- `deploy/cloudflare/wrangler.gateway.toml.example`
- `deploy/cloudflare/secrets.local.env.example`

## License

This repository is published under the **PolyForm Noncommercial 1.0.0** license in the root [`LICENSE`](../LICENSE) file.

That means:

- individuals, researchers, educators, nonprofits, and other noncommercial users can study, run, modify, and share the code under the license terms
- commercial use is **not** granted by this public license
- this repo is **source-available**, not OSI-approved open source

The license applies to the source code in this repository.

It does **not** restrict ordinary use of the hosted Vibecodr service by account holders. Anyone with a Vibecodr account may use the hosted MCP server at `openai.vibecodr.space/mcp`, subject to the Vibecodr service terms. What requires separate permission is commercial reuse of this source code itself, including resale, commercial self-hosting, or embedding derivative versions of this connector in paid products.

If you need commercial rights, production embedding beyond the license, or another licensing arrangement, that should be handled separately by the Vibecodr team.

## Public CLI boundary

If Vibecodr ships a public CLI installer and runtime for the hosted MCP service, that package should live in a separate repo with its own permissive license. This repo remains the source-available hosted MCP server and OAuth gateway. Keeping those surfaces separate avoids implying that commercial use of the hosted service is restricted just because this implementation repo is PolyForm-licensed.

## How to read the docs

Start here:

- [`../README.md`](../README.md)
- [`mcp-server.md`](./mcp-server.md)
- [`mcp-client-setup.md`](./mcp-client-setup.md)
- [`../deploy/cloudflare/README.md`](../deploy/cloudflare/README.md)

For deeper design context:

- [`planning/README.md`](./planning/README.md)

## Scope note for external readers

This repo is intended to give a real, working glimpse into how Vibecodr exposes:

- a standards-oriented MCP server
- an OAuth bridge that keeps user identity in Clerk while preserving Vibecodr account-linked publishing

Some implementation details necessarily stop at the boundary of the private Vibecodr API and product monorepo. That boundary is intentional.
