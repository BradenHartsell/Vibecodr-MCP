# Archived Planning Notes

This folder contains historical planning notes from the original upload app and ChatGPT widget exploration. Those notes are useful design context, but they are not the current production contract.

The current production surface is the hosted Vibecodr MCP gateway:

- no embedded widget surface
- no OpenAI app submission packet
- no `resources/list` UI resources
- public MCP tools shaped around publishing, reading, polish, sharing, remixing, and recovery
- hidden recovery handlers callable by exact name for compatibility
- Code Mode staged behind Cloudflare Dynamic Worker configuration

The current architecture is one hosted gateway/server with many MCP clients, including ChatGPT and Codex. The first-party CLI is a separate client repo. There is no separate OpenAI app server unless a future widget/UI resource is deliberately reintroduced.

Use these current documents as the source of truth:

- [MCP server behavior](../mcp-server.md)
- [Canonical architecture](../canonical-architecture.md)
- [MCP client setup](../mcp-client-setup.md)
- [Cloudflare MCP alignment](../cloudflare-mcp-alignment.md)
- [Code Mode migration plan](../cloudflare-codemode-migration-plan.md)
- [Dynamic Worker sandbox configuration](../dynamic-worker-sandbox-configuration.md)
- [Public surface minimization](14-public-surface-minimization.md)

## Historical Index

1. [01-overview](01-overview.md)
2. [02-architecture-and-data-flow](02-architecture-and-data-flow.md)
3. [03-subsystem-ingestion-adapters](03-subsystem-ingestion-adapters.md)
4. [04-subsystem-auth-and-identity](04-subsystem-auth-and-identity.md)
5. [05-subsystem-openai-app-mcp-widget](05-subsystem-openai-app-mcp-widget.md)
6. [06-subsystem-vibecodr-integration](06-subsystem-vibecodr-integration.md)
7. [07-subsystem-data-model-jobs-storage](07-subsystem-data-model-jobs-storage.md)
8. [08-subsystem-security-compliance](08-subsystem-security-compliance.md)
9. [09-subsystem-observability-ops](09-subsystem-observability-ops.md)
10. [10-delivery-roadmap](10-delivery-roadmap.md)
11. [11-test-validation-acceptance](11-test-validation-acceptance.md)
12. [12-openai-submission-dossier](12-openai-submission-dossier.md)
13. [13-system-wiring-matrix](13-system-wiring-matrix.md)
14. [14-public-surface-minimization](14-public-surface-minimization.md)

## Historical Templates

- [OpenAI Submission Payload Template](templates/openai-submission-payload.template.json)
- [Tool Catalog Template](templates/tool-catalog.template.yaml)
- [Environment Matrix Template](templates/environment-matrix.template.md)
