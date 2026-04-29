import { getTools } from "./tools.js";
import { PULSE_DESCRIPTOR_SETUP_METADATA } from "./pulseDescriptorMetadata.js";

export type CapabilityVisibility = "public" | "recovery" | "internal" | "catalog";
export type CapabilityKind = "native_tool" | "prompt" | "catalog_entry" | "not_mcp";
export type CapabilityExecutionStatus = "callable" | "catalog_only";

export type CapabilityExample = {
  title: string;
  arguments: Record<string, unknown>;
};

export type CapabilityCatalogEntry = {
  id: string;
  namespace: "platform" | "publish" | "runtime" | "pulses" | "social" | "ops" | "policy";
  title: string;
  purpose: string;
  visibility: CapabilityVisibility;
  kind: CapabilityKind;
  nativeToolName?: string;
  executionStatus: CapabilityExecutionStatus;
  authRequired: boolean;
  destructive: boolean;
  idempotent: boolean;
  confirmationRequired: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: CapabilityExample[];
  argumentSummary: string[];
  keywords: string[];
  notes: string[];
};

function schemaProperties(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  return Object.keys(properties);
}

function schemaRequired(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.["required"];
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [];
}

function argumentSummaryForSchema(schema: Record<string, unknown> | undefined): string[] {
  const properties = schemaProperties(schema);
  if (properties.length === 0) return ["No arguments."];
  const required = schemaRequired(schema);
  const optional = properties.filter((name) => !required.includes(name));
  return [
    required.length > 0 ? "Required: " + required.join(", ") + "." : "No required arguments.",
    ...(optional.length > 0 ? ["Optional: " + optional.join(", ") + "."] : []),
    ...(properties.includes("confirmed") ? ["confirmed must be true only after explicit user confirmation."] : [])
  ];
}

function visibilityForNativeTool(name: string): CapabilityVisibility {
  const publicNames = new Set(getTools().map((tool) => tool.name));
  if (publicNames.has(name)) return "public";
  return "recovery";
}

function namespaceForNativeTool(name: string): CapabilityCatalogEntry["namespace"] {
  if (
    name === "discover_vibes" ||
    name === "get_public_post" ||
    name === "get_public_profile" ||
    name === "search_vibecodr" ||
    name === "get_remix_lineage" ||
    name === "build_share_copy" ||
    name === "get_launch_checklist" ||
    name === "inspect_social_preview" ||
    name === "suggest_post_publish_next_steps" ||
    name === "get_engagement_followup_context" ||
    name.includes("engagement") ||
    name.includes("share")
  ) {
    return "social";
  }
  if (name.includes("pulse")) return "pulses";
  if (name.includes("runtime")) return "runtime";
  if (name.includes("vibe") || name.includes("draft") || name.includes("publish") || name.includes("import") || name.includes("operation") || name.includes("capsule")) {
    return "publish";
  }
  if (name.includes("platform") || name.includes("upload") || name.includes("account")) return "platform";
  return "platform";
}

function keywordsForNativeTool(name: string, description: string): string[] {
  return [...new Set([
    ...name.split("_"),
    ...description.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3).slice(0, 12)
  ])];
}

function examplesForNativeTool(name: string): CapabilityExample[] | undefined {
  if (name === "prepare_publish_package" || name === "validate_creation_payload") {
    return [{
      title: "Prepare direct files without creating a publish operation",
      arguments: {
        sourceType: "chatgpt_v1",
        payload: {
          importMode: "direct_files",
          title: "Tiny counter",
          entry: "index.html",
          files: [{ path: "index.html", content: "<button>Count</button>" }]
        }
      }
    }];
  }
  if (name === "quick_publish_creation") {
    return [{
      title: "Publish direct files after explicit confirmation",
      arguments: {
        sourceType: "chatgpt_v1",
        confirmed: true,
        payload: {
          importMode: "direct_files",
          entry: "index.html",
          files: [{ path: "index.html", content: "<main>Hello Vibecodr</main>" }]
        }
      }
    }];
  }
  if (name === "get_runtime_readiness") {
    return [{
      title: "Check readiness from the current publish operation",
      arguments: { operationId: "operation-id-from-publish-flow" }
    }];
  }
  if (name === "resume_latest_publish_flow") {
    return [{
      title: "Resume without asking the user for an operation id",
      arguments: { limit: 10 }
    }];
  }
  if (name === "search_vibecodr") {
    return [{
      title: "Search public Vibecodr social context",
      arguments: { query: "shader", limit: 10 }
    }];
  }
  if (name === "get_public_post") {
    return [{
      title: "Read one public vibe",
      arguments: { postId: "post-id" }
    }];
  }
  if (name === "build_share_copy") {
    return [{
      title: "Draft share copy for a live vibe",
      arguments: { postId: "post-id" }
    }];
  }
  if (name === "update_live_vibe_metadata") {
    return [{
      title: "Update live visibility after explicit confirmation",
      arguments: { postId: "post-id", visibility: "public", confirmed: true }
    }];
  }
  return undefined;
}

function inputSchemaForNativeTool(name: string): Record<string, unknown> {
  return getTools({ includeHidden: true, includeOutputSchema: true })
    .find((tool) => tool.name === name)?.inputSchema ?? {
    type: "object",
    additionalProperties: false
  };
}

function outputSchemaForNativeTool(name: string): Record<string, unknown> | undefined {
  return getTools({ includeHidden: true, includeOutputSchema: true })
    .find((tool) => tool.name === name)?.outputSchema;
}

function requiredOutputSchemaForNativeTool(name: string): Record<string, unknown> {
  const schema = outputSchemaForNativeTool(name);
  if (!schema) throw new Error("Missing output schema for native tool " + name);
  return schema;
}

function nativeEntries(): CapabilityCatalogEntry[] {
  return getTools({ includeHidden: true, includeOutputSchema: true }).map((tool) => {
    const authRequired = tool.securitySchemes.some((scheme) => scheme.type === "oauth2");
    const visibility = visibilityForNativeTool(tool.name);
    const examples = examplesForNativeTool(tool.name);
    return {
      id: "native." + tool.name,
      namespace: namespaceForNativeTool(tool.name),
      title: tool.title,
      purpose: tool.description,
      visibility,
      kind: "native_tool",
      nativeToolName: tool.name,
      executionStatus: "callable",
      authRequired,
      destructive: Boolean(tool.annotations.destructiveHint),
      idempotent: Boolean(tool.annotations.idempotentHint),
      confirmationRequired: Boolean(tool.annotations.destructiveHint),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(examples ? { examples } : {}),
      argumentSummary: argumentSummaryForSchema(tool.inputSchema),
      keywords: keywordsForNativeTool(tool.name, tool.description),
      notes: visibility === "public"
        ? ["Advertised in default native MCP discovery."]
        : ["Hidden from default native discovery but callable by exact name for compatibility and recovery."]
    };
  });
}

const manualEntries: CapabilityCatalogEntry[] = [
  {
    id: "publish.import_package",
    namespace: "publish",
    title: "Import Package",
    purpose: "Bootstrap a generated app package into Vibecodr without conflating package ingest with canonical live publish.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      required: ["sourceType", "payload"],
      properties: {
        sourceType: { type: "string", enum: ["chatgpt_v1", "codex_v1"] },
        payload: { type: "object", additionalProperties: true },
        dryRun: { type: "boolean", const: true }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: sourceType, payload.",
      "Optional: dryRun.",
      "This is a no-write package bootstrap/validation lane."
    ],
    keywords: ["import", "bootstrap", "package", "zip", "github", "draft", "capsule"],
    notes: ["Target lane name for the user-facing package ingest path. Do not name this lane publish."]
  },
  {
    id: "publish.compile_draft",
    namespace: "publish",
    title: "Compile Draft",
    purpose: "Run the preview/compile lane that validates a draft before canonical publish.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      required: ["capsuleId"],
      properties: {
        capsuleId: { type: "string" },
        operationId: { type: "string" }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: capsuleId.",
      "Optional: operationId.",
      "Use after a package exists and before canonical live publish."
    ],
    keywords: ["compile", "preview", "draft", "artifact", "bundle"],
    notes: ["Keep separate from import and publish so agents can reason about launch blockers."]
  },
  {
    id: "publish.publish_capsule",
    namespace: "publish",
    title: "Publish Capsule",
    purpose: "Canonical live publish or republish lane for a compiled capsule.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: true,
    idempotent: true,
    confirmationRequired: true,
    inputSchema: {
      type: "object",
      required: ["capsuleId", "confirmed"],
      properties: {
        capsuleId: { type: "string" },
        operationId: { type: "string" },
        visibility: { type: "string", enum: ["public", "unlisted", "private"] },
        confirmed: { type: "boolean", const: true }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: capsuleId, confirmed.",
      "Optional: operationId, visibility.",
      "confirmed must be true only after explicit user confirmation."
    ],
    keywords: ["publish", "capsule", "live", "republish", "visibility"],
    notes: ["Requires explicit user confirmation before making a vibe live."]
  },
  {
    id: "publish.get_capsule_state",
    namespace: "publish",
    title: "Get Capsule State",
    purpose: "Read normalized capsule, source analysis, runtime analysis, and draft state for planning or resume flows.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      properties: {
        capsuleId: { type: "string" },
        postId: { type: "string" },
        draftId: { type: "string" }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Provide one of capsuleId, postId, or draftId.",
      "Returns normalized state summaries, not raw source or runtime internals."
    ],
    keywords: ["capsule", "state", "analysis", "draft", "runtime"],
    notes: ["Prefer normalized sourceAnalysis/runtimeAnalysis summaries over raw internal aliases."]
  },
  {
    id: "runtime.readiness",
    namespace: "runtime",
    title: "Runtime Readiness",
    purpose: "Summarize whether a vibe can launch, what blocks it, and the single best next action without exposing runtime internals.",
    visibility: "public",
    kind: "native_tool",
    nativeToolName: "get_runtime_readiness",
    executionStatus: "callable",
    authRequired: true,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: inputSchemaForNativeTool("get_runtime_readiness"),
    outputSchema: requiredOutputSchemaForNativeTool("get_runtime_readiness"),
    argumentSummary: [
      "Provide operationId, postId, draftId, or capsuleId.",
      "Returns ready, blocked, degraded, or unknown plus one next action."
    ],
    keywords: ["runtime", "readiness", "launch", "manifest", "bundle", "player"],
    notes: ["Public output should be blocker plus next step, not raw manifests, iframe state, CSP details, or telemetry rows."]
  },
  {
    id: "pulses.lifecycle",
    namespace: "pulses",
    title: "Pulse Lifecycle",
    purpose: "Owner-facing pulse lifecycle capability for list/get/create/update/run/archive/restore/status.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: true,
    idempotent: false,
    confirmationRequired: true,
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "run", "archive", "restore", "status"]
        },
        pulseId: { type: "string" },
        payload: { type: "object", additionalProperties: true },
        confirmed: { type: "boolean", const: true }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: action.",
      "Optional: pulseId, payload, confirmed.",
      "Mutating actions require confirmed: true and owner auth."
    ],
    keywords: ["pulse", "backend", "server", "worker", "lifecycle", "run"],
    notes: [
      `${PULSE_DESCRIPTOR_SETUP_METADATA.sourceOfTruth} ${PULSE_DESCRIPTOR_SETUP_METADATA.apiVersion} owns setup metadata before lifecycle guidance is shown.`,
      "Expose interface and lifecycle, not implementation, dispatch tokens, secrets, or source projection."
    ]
  },
  {
    id: "social.read",
    namespace: "social",
    title: "Social Read Suite",
    purpose: "Read public social surfaces such as the homepage feed, posts, profiles, search, and remix lineage.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: false,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: {
          type: "string",
          enum: ["feed", "post", "profile", "search", "remix_lineage"]
        },
        query: { type: "string" },
        postId: { type: "string" },
        handle: { type: "string" },
        capsuleId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: target.",
      "Optional: query, postId, handle, capsuleId, limit.",
      "Read public social context only; no social mutations."
    ],
    keywords: ["feed", "post", "profile", "search", "remix", "share"],
    notes: [
      "Native public tools now implement each read path: discover_vibes, get_public_post, get_public_profile, search_vibecodr, and get_remix_lineage.",
      "Keep read-first. Subjective share/profile/title polish belongs in prompts or skills."
    ]
  },
  {
    id: "ops.error_triage",
    namespace: "ops",
    title: "Error Triage",
    purpose: "Trusted recovery namespace for error catalog lookup, runtime telemetry summaries, and Cloudflare/D1 investigation.",
    visibility: "recovery",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: true,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      required: ["error"],
      properties: {
        error: { type: "string" },
        operationId: { type: "string" },
        traceId: { type: "string" }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Required: error.",
      "Optional: operationId, traceId.",
      "Returns summarized recovery guidance, not raw logs or telemetry dumps."
    ],
    keywords: ["error", "triage", "telemetry", "cloudflare", "d1", "analytics"],
    notes: ["Hidden operator lane. Never expose raw logs, tokens, D1 dumps, or internal API plumbing to default users."]
  },
  {
    id: "policy.private_backend_projection",
    namespace: "policy",
    title: "Private Backend Projection Policy",
    purpose: "Catalog rule that pulses are execution surfaces, not public source or discovery projection.",
    visibility: "catalog",
    kind: "catalog_entry",
    executionStatus: "catalog_only",
    authRequired: false,
    destructive: false,
    idempotent: true,
    confirmationRequired: false,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string" },
        capsuleId: { type: "string" }
      },
      additionalProperties: false
    },
    argumentSummary: [
      "Optional: postId, capsuleId.",
      "Policy lookup only; public outputs expose hasPrivateBackend, never pulse internals."
    ],
    keywords: ["pulse", "private", "backend", "projection", "source", "discovery"],
    notes: ["Show the interface, not the implementation."]
  }
];

export function getCapabilityCatalog(): CapabilityCatalogEntry[] {
  const byId = new Map<string, CapabilityCatalogEntry>();
  for (const entry of [...nativeEntries(), ...manualEntries]) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function findCapabilityById(id: string): CapabilityCatalogEntry | undefined {
  return getCapabilityCatalog().find((entry) => entry.id === id);
}
