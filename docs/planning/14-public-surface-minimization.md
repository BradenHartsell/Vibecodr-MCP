# 14. Public Surface Minimization Plan

Last updated: 2026-04-24

## Goal

Keep the public MCP gateway shaped like a guided publish and live-vibe companion instead of an operator console.

This plan covers two related concerns:

1. The former widget surface stays removed.
2. MCP tool discovery stays product-shaped while recovery and operator behavior stays hidden or catalog-only.

The target shape is:

- one obvious publish path
- one no-write package preparation path before writes
- one runtime/readiness path when launch state is unclear
- one live-vibe and social follow-up layer after publish
- one recovery layer, callable by exact name but absent from default discovery

## Current State

The production surface is MCP-only. The former widget file `src/web/widgetHtml.ts` has been removed, `/widget` should return 404, `resources/list` should remain empty, and tool metadata should not advertise `openai/outputTemplate`.

Default `tools/list` currently exposes these product-level tools:

- `get_vibecodr_platform_overview`
- `get_guided_publish_requirements`
- `get_upload_capabilities`
- `prepare_publish_package`
- `validate_creation_payload`
- `get_launch_best_practices`
- `get_pulse_setup_guidance`
- `get_account_capabilities`
- `get_publish_readiness`
- `get_runtime_readiness`
- `resume_latest_publish_flow`
- `list_vibecodr_drafts`
- `get_vibecodr_draft`
- `list_my_live_vibes`
- `get_live_vibe`
- `get_vibe_engagement_summary`
- `get_vibe_share_link`
- `discover_vibes`
- `get_public_post`
- `get_public_profile`
- `search_vibecodr`
- `get_remix_lineage`
- `build_share_copy`
- `get_launch_checklist`
- `inspect_social_preview`
- `suggest_post_publish_next_steps`
- `get_engagement_followup_context`
- `update_live_vibe_metadata`
- `quick_publish_creation`

Hidden recovery handlers remain implemented and callable by exact name for compatibility, scripted diagnostics, and future Code Mode catalog execution:

- `list_import_operations`
- `get_import_operation`
- `watch_operation`
- `explain_operation_failure`
- `start_creation_import`
- `compile_draft_capsule`
- `publish_draft_capsule`
- `cancel_import_operation`

## Public Tool Taxonomy

### Platform And Guidance

- `get_vibecodr_platform_overview`
- `get_guided_publish_requirements`
- `get_upload_capabilities`
- `get_launch_best_practices`
- `get_pulse_setup_guidance`
- `get_account_capabilities`

These tools give a zero-context model the product story, workflow contract, upload limits, launch expectations, pulse/backend boundaries, and current account capability without forcing operation internals into the first interaction.

### Publish And Runtime

- `prepare_publish_package`
- `validate_creation_payload`
- `quick_publish_creation`
- `get_publish_readiness`
- `get_runtime_readiness`
- `resume_latest_publish_flow`
- `list_vibecodr_drafts`
- `get_vibecodr_draft`

The normal path is no-write preparation, explicit user confirmation, quick publish, then readiness or resume if the flow needs state. Import, compile, publish, and watch primitives stay hidden recovery unless the primary path breaks or a client calls them by exact name for compatibility.

### Live Vibe And Social Read

- `list_my_live_vibes`
- `get_live_vibe`
- `get_vibe_engagement_summary`
- `get_vibe_share_link`
- `discover_vibes`
- `get_public_post`
- `get_public_profile`
- `search_vibecodr`
- `get_remix_lineage`

These tools let agents inspect public social context and the connected user's live vibes without exposing private account data, raw source, moderation internals, or social mutations.

### Post-Publish Polish

- `build_share_copy`
- `get_launch_checklist`
- `inspect_social_preview`
- `suggest_post_publish_next_steps`
- `get_engagement_followup_context`
- `update_live_vibe_metadata`

Read-only polish helpers should produce actions and user-facing launch guidance. The metadata update tool remains confirmation-gated because it mutates a live vibe.

## Guardrails

- Keep widget routes and resources unavailable.
- Keep recovery and operation-level handlers hidden from default `tools/list`.
- Keep destructive native tools server-gated on `confirmed: true`.
- Keep public outputs summary-first: state, blocker, next action, safe identifiers, and links.
- Do not expose raw source bundles, raw manifests, telemetry rows, cookies, tokens, refresh grants, secret inventory, Cloudflare admin plumbing, or moderation internals.
- Add visible native tools only when they are durable product primitives, not internal routes.
- Put dense or low-level capability detail behind Code Mode `search` or hidden catalog entries.

## Acceptance Criteria

This minimization work is complete when:

1. A first-run MCP client sees product-level guidance, no-write preparation, confirmed publish, readiness/resume, and post-publish social follow-up.
2. A first-run client defaults to `prepare_publish_package` before package writes when payload detail needs validation and `quick_publish_creation` only after explicit user confirmation.
3. Widget routes and UI resources stay unavailable.
4. Recovery responses are phrased as user-facing explanations instead of raw internal status names.
5. Default `tools/list` excludes operation repair tools while exact-name compatibility calls still work.

## Verification

- `npm run check`
- `npm test`
- `npm run transport:regression`
- `npm run security:regression`
- `npm run mcp:capability-evals`
- `npm run mcp:measure` after any surface change
