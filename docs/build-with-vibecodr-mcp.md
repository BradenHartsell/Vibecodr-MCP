# Build With The Vibecodr MCP Server

Vibecodr's MCP server lets an AI assistant turn code into a live Vibecodr vibe, inspect public vibes, polish launches, explain remix context, and continue publish flows without asking the user to operate an import console.

Canonical endpoint:

```text
https://openai.vibecodr.space/mcp
```

Use the normal endpoint first. The Code Mode endpoint is available for controlled dogfooding only after the Cloudflare Worker Loader is provisioned:

```text
https://openai.vibecodr.space/mcp?codemode=search_and_execute
```

## What This Server Is For

Use this server when you want an agent to:

- explain Vibecodr in product terms
- publish a generated app as a live vibe
- validate a publish package before any write
- inspect drafts or live vibes from the connected account
- read public Vibecodr posts, profiles, homepage-feed discovery, search, and remix lineage
- generate share copy, launch checklists, social-preview feedback, and next steps
- decide when a frontend-only vibe should use pulses for trusted backend work
- recover from a failed publish flow in plain language

Do not use this server as:

- a raw admin API
- a telemetry browser
- a secret manager
- a generic code execution sandbox
- a replacement for the full Vibecodr frontend or private backend source tree

## Connect

Add the server to any remote MCP client that supports Streamable HTTP:

```text
https://openai.vibecodr.space/mcp
```

For Codex:

```powershell
codex mcp add vibecodr-space --url https://openai.vibecodr.space/mcp
```

The server uses an OAuth compatibility flow. The user signs in through Vibecodr/Clerk in the browser, and the MCP client receives gateway-issued tokens. Do not ask the user to paste a bearer token.

Useful first checks:

```text
What is Vibecodr?
What can my Vibecodr account do right now?
List my live vibes.
```

## The Agent's First Minute

A fresh agent should start with product intent:

1. Vibecodr is a social platform where code runs as content.
2. A published app becomes a live vibe that people can open, run, remix, comment on, like, and share.
3. Publishing is guided. The agent should ask only for missing launch details.
4. Public is the default visibility unless the user asks for unlisted or private.
5. Making something live, updating live metadata, publishing a draft, or canceling an operation requires explicit user confirmation.

Recommended first reads:

```text
get_vibecodr_platform_overview
get_upload_capabilities
get_guided_publish_requirements
```

When backend behavior might be needed:

```text
get_pulse_setup_guidance
```

When a `descriptorSetup` projection is available from Vibecodr API validation, pass it into `get_pulse_setup_guidance`. The returned `descriptorEvaluation` is the part that tells you whether this specific Pulse has no backend setup, has declared setup tasks, warnings, or blocking descriptor/source mismatches.

Before promising account-specific features such as private visibility, custom SEO, or pulse capacity:

```text
get_account_capabilities
```

## Publish A Creation

The normal flow is:

1. Understand the app the user wants to publish.
2. Read `get_upload_capabilities`.
3. Read `get_guided_publish_requirements`.
4. Prepare the package with `prepare_publish_package` when the model needs validation before any write.
5. Ask for explicit publish confirmation.
6. Call `quick_publish_creation` with `confirmed: true`.
7. Return the live link, what went live, and one useful next step.

The agent should not make the user think in terms of operation ids, compile stages, capsules, or artifact internals during a normal publish. Those are recovery details.

### Minimal Package Shape

Use `sourceType: "codex_v1"` for Codex-style generated projects and `sourceType: "chatgpt_v1"` for ChatGPT-style creation packages.

The package must include enough files to run the app. Include `entry` explicitly when the runnable file is obvious.

Example:

```json
{
  "sourceType": "codex_v1",
  "payload": {
    "title": "Neon Habit Garden",
    "entry": "src/main.tsx",
    "files": [
      {
        "path": "package.json",
        "content": "{\"scripts\":{\"build\":\"vite build\"},\"dependencies\":{\"@vitejs/plugin-react\":\"latest\",\"vite\":\"latest\",\"react\":\"latest\",\"react-dom\":\"latest\"},\"devDependencies\":{}}"
      },
      {
        "path": "src/main.tsx",
        "content": "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './style.css';\n\nfunction App() {\n  return <main><h1>Neon Habit Garden</h1><p>Track tiny habits as growing light trails.</p></main>;\n}\n\ncreateRoot(document.getElementById('root')!).render(<App />);"
      },
      {
        "path": "index.html",
        "content": "<div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script>"
      },
      {
        "path": "src/style.css",
        "content": "body{margin:0;font-family:system-ui;background:#111;color:white}main{min-height:100vh;display:grid;place-items:center;text-align:center}"
      }
    ]
  }
}
```

Validate without writing:

```text
prepare_publish_package
```

Publish only after confirmation:

```json
{
  "sourceType": "codex_v1",
  "payload": {
    "title": "Neon Habit Garden",
    "entry": "src/main.tsx",
    "files": []
  },
  "visibility": "public",
  "confirmed": true
}
```

In a real publish call, pass the complete package files. The shortened example above shows the control fields, not a complete app.

## Confirmation Rules

The server enforces confirmation for destructive native tools. A model should ask plainly before it passes `confirmed: true`.

Good confirmation language:

```text
Should I publish this as a public Vibecodr vibe now?
```

Do not treat vague momentum as confirmation:

```text
Looks good.
Let's go.
Do it.
```

Use those as a cue to ask one clear confirmation question unless the user has already named the exact action.

Tools that require confirmed writes include:

- `quick_publish_creation`
- `update_live_vibe_metadata`
- `publish_draft_capsule`
- `cancel_import_operation`

## Launch Polish

A good Vibecodr launch is not just "publish succeeded." The agent should help the user ship something shareable.

Use:

```text
get_launch_best_practices
build_share_copy
get_launch_checklist
inspect_social_preview
suggest_post_publish_next_steps
get_engagement_followup_context
```

For a public vibe:

- default to a strong title and concise description
- offer a cover image when no artwork exists
- prefer hosted file references for user-provided images
- use inline base64 only as a small-file fallback
- offer SEO and social preview polish when the account supports it
- close with the live link and what people can do next

Good final response shape:

```text
Your vibe is live: https://vibecodr.space/player/...

People can open it, run it, remix it, comment on it, like it, and share it. I also prepared a short launch blurb you can post alongside the link.
```

## When To Use Pulses

Most vibes should stay frontend-only. Use pulses when the app needs trusted server-side work.

Start with:

```text
get_pulse_setup_guidance
```

That guidance is descriptor-derived only when you pass the actual `descriptorSetup` projection. Without it, the tool returns general Pulse setup rules, not proof that a specific Pulse is frontend-only or backend-backed. Descriptor-backed guidance should teach capability-shaped Pulse APIs only: `env.pulse`, Vibecodr policy-mediated `env.fetch`, structured `env.log`, sanitized `env.request`, safe correlation-only `env.runtime`, and best-effort `env.waitUntil`. It should not teach raw platform bindings, dispatch details, raw authorization headers, physical storage, or owner lifecycle cleanup as runtime authority.

Frontend-only is enough when:

- the app is interactive UI, local state, or deterministic browser logic
- all data can be bundled or fetched from public endpoints
- no secrets, signed requests, privileged mutations, webhooks, schedules, or durable backend side effects are needed

Pulses are appropriate when:

- the app needs API keys or provider credentials
- the app needs webhook handling
- the app needs scheduled or background work
- the app needs trusted mutations
- the app needs backend policy enforcement that cannot live in browser code

Before promising pulse-backed behavior, call:

```text
get_account_capabilities
```

## Inspect Public Vibecodr

The server can read public Vibecodr context without account auth.

Use:

```text
discover_vibes
get_public_post
get_public_profile
search_vibecodr
get_remix_lineage
```

These tools are for public data. They should not imply access to private drafts, private profile data, message-board threads, comments, admin moderation state, or internal telemetry.

Useful asks:

```text
Find recent public vibes about music toys.
Explain this vibe's remix lineage.
Show me what this creator publishes.
```

## Continue Or Recover A Flow

If the user comes back without an operation id, use:

```text
resume_latest_publish_flow
```

For normal status:

```text
get_publish_readiness
get_runtime_readiness
```

Use recovery internals only after the guided path fails or the user explicitly asks for diagnostics:

```text
explain_operation_failure
list_import_operations
get_import_operation
watch_operation
compile_draft_capsule
publish_draft_capsule
cancel_import_operation
```

Recovery should still be humane:

- explain the blocker in plain language
- give one concrete next step
- avoid dumping raw operation states unless the user asks
- ask at most one focused follow-up question

## Optional Workflow Prompts

Clients that support MCP prompts can use:

```text
publish_creation_end_to_end
polish_public_launch
recover_publish_failure
decide_when_to_use_pulses
```

These prompts teach the agent how to run a whole workflow, not just one tool call. They are useful when a client supports prompts explicitly, but the tools also work without them.

## Code Mode

Native `/mcp` is the stable default.

Code Mode is the opt-in compact surface:

```text
https://openai.vibecodr.space/mcp?codemode=search_and_execute
```

In Code Mode:

- `tools/list` returns only `search` and `execute`
- `search` discovers capability details from the server-side catalog
- `execute` calls gateway-owned capability proxies
- catalog-only entries are not callable
- generated code is not allowed to see secrets, raw tokens, raw env vars, or arbitrary network access

Use Code Mode for:

- progressive discovery
- multi-step read flows
- chaining safe capability calls
- reducing default tool-schema load

Do not use Code Mode as the only safety boundary for writes. Confirmation remains server-side.

## What Good Agent Behavior Looks Like

Good:

```text
I can publish this for you. I found the entry file and title. Before I make it live, should I publish it publicly on Vibecodr now?
```

Good:

```text
This app can stay frontend-only. It does not need secrets, webhooks, scheduled jobs, or trusted server-side mutations, so pulses would add complexity without helping the launch.
```

Good:

```text
The publish hit one blocker: Vibecodr could not identify the app entry file. Which file starts the app: src/main.tsx, src/index.tsx, or index.html?
```

Avoid:

```text
Give me an operation id.
The capsule is in compile_failed.
I need you to manually inspect the manifest.
I published it because you said "looks good."
```

## Troubleshooting

If the client cannot authenticate:

- confirm the URL is `https://openai.vibecodr.space/mcp`
- confirm the client supports remote Streamable HTTP MCP
- trigger the client's OAuth flow again
- restart the client if auth metadata was cached

If a protected tool says connection is required:

- complete the browser login
- return to the same MCP client session
- retry a protected read such as `get_account_capabilities`

If a publish fails:

- use `get_publish_readiness` first
- use `get_runtime_readiness` when there is a known operation, draft, or live post
- use `explain_operation_failure` only for failure-specific recovery

If Code Mode is unavailable:

- use the normal `/mcp` endpoint
- Code Mode requires a configured `CODEMODE_WORKER_LOADER` in production

## The Principle

The best Vibecodr MCP experience feels like a launch partner:

- it knows what Vibecodr is
- it asks fewer, sharper questions
- it protects live writes with explicit confirmation
- it keeps internals out of the user's way
- it turns code into a social object people can run, remix, discuss, and share
