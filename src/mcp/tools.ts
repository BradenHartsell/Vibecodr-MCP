import { z } from "zod";
import { randomUUID } from "node:crypto";
import { adaptCodexPayload } from "../adapters/codexAdapter.js";
import { adaptChatGptPayload } from "../adapters/chatgptAdapter.js";
import { PackageResolutionError } from "../adapters/packageSchema.js";
import { resolveRequestSession } from "../auth/requestSession.js";
import { translateDiagnosticForPublic, translateFailure } from "../lib/failureTranslation.js";
import {
  MAX_INLINE_THUMBNAIL_BYTES,
  isAllowedThumbnailMime,
  validateOpenAiDownloadUrl,
  resolveThumbnailInput
} from "../lib/thumbnailInput.js";
import { coverUsageForVisibility } from "../vibecodr/client.js";
import type { ImportService } from "../services/importService.js";
import type { OperationStorePort } from "../storage/operationStorePort.js";
import type { SessionStore } from "../auth/sessionStore.js";
import type { VibecodrClient } from "../vibecodr/client.js";
import type { Telemetry } from "../observability/telemetry.js";
import type {
  ImportOperation,
  OperationStatus,
  PublishThumbnailFile,
  PublishSeoInput,
  PublishThumbnailUpload,
  SourceType,
  PublishVisibility,
  SessionRecord
} from "../types.js";

export type ToolDeps = {
  importService: ImportService;
  operationStore: OperationStorePort;
  sessionStore: SessionStore;
  vibecodr: VibecodrClient;
  telemetry: Telemetry;
  appBaseUrl: string;
  vibecodrApiBase: string;
  vibecodrFetch?: typeof fetch;
  featureFlags: {
    enableCodexImportPath: boolean;
    enableChatGptImportPath: boolean;
    enablePublishFromChatGpt: boolean;
  };
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
};

type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  securitySchemes: Array<{ type: string; scopes?: string[] }>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  };
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type ToolPresentationOptions = {
  supportsUi?: boolean;
};

const NOAUTH_SECURITY_SCHEMES = [{ type: "noauth" }];
const OAUTH_TOOL_SCOPES = ["openid", "profile", "email", "offline_access"];
const OAUTH_SECURITY_SCHEMES = [{ type: "oauth2", scopes: OAUTH_TOOL_SCOPES }];
const DEFAULT_WATCH_TIMEOUT_SECONDS = 90;
const DEFAULT_WATCH_POLL_MS = 1500;
const SOURCE_TYPE_VALUES = ["codex_v1", "chatgpt_v1"] as const;
const ALLOWED_OPERATION_STATUSES = [
  "received",
  "validating",
  "normalized",
  "ingesting",
  "waiting_on_import_job",
  "draft_ready",
  "compile_running",
  "compile_failed",
  "publish_running",
  "published",
  "published_with_warnings",
  "failed",
  "canceled"
] as const satisfies readonly OperationStatus[];
const PUBLISH_VISIBILITY_VALUES = ["public", "unlisted", "private"] as const;

function humanizeOperationStatus(status: OperationStatus): string {
  switch (status) {
    case "received":
    case "validating":
    case "normalized":
    case "ingesting":
    case "waiting_on_import_job":
      return "Vibecodr is preparing the draft.";
    case "draft_ready":
      return "The draft is staged and ready for launch decisions.";
    case "compile_running":
      return "Vibecodr is checking that the app can launch cleanly.";
    case "compile_failed":
      return "The draft needs one repair before it can launch.";
    case "publish_running":
      return "The vibe is being published now.";
    case "published":
      return "The vibe is live on Vibecodr.";
    case "published_with_warnings":
      return "The vibe is live, but launch polish still needs a follow-up update.";
    case "failed":
      return "The launch hit a blocker and needs a guided recovery step.";
    case "canceled":
      return "The launch was canceled before it went live.";
    default:
      return "Vibecodr is updating the launch state.";
  }
}

function safeSessionHandle(session: SessionRecord, fallback?: string): string {
  const candidate = session.userHandle?.trim() || fallback?.trim() || "";
  return candidate || "connected-account";
}

const WIDGET_ENABLED_TOOLS = new Set([
  "start_creation_import",
  "compile_draft_capsule",
  "quick_publish_creation",
  "publish_draft_capsule",
  "get_publish_readiness",
  "list_vibecodr_drafts",
  "get_vibecodr_draft"
]);

const CREATION_FILE_INPUT_SCHEMA = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    contentEncoding: { type: "string", enum: ["utf8", "base64"] }
  },
  additionalProperties: false
} as const;

const CREATION_PAYLOAD_INPUT_SCHEMA = {
  type: "object",
  properties: {
    sourceReference: { type: "string" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    runner: { type: "string", enum: ["client-static", "webcontainer"] },
    entry: { type: "string", minLength: 1 },
    importMode: { type: "string", enum: ["direct_files", "zip_import", "github_import"] },
    files: {
      type: "array",
      items: CREATION_FILE_INPUT_SCHEMA
    },
    metadata: { type: "object", additionalProperties: true },
    idempotencyKey: { type: "string" },
    github: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        branch: { type: "string" },
        rootHint: { type: "string" },
        allowModuleScripts: { type: "boolean" },
        async: { type: "boolean" }
      },
      additionalProperties: false
    },
    zip: {
      type: "object",
      required: ["fileName", "fileBase64"],
      properties: {
        fileName: { type: "string", minLength: 1 },
        fileBase64: { type: "string", minLength: 1 },
        rootHint: { type: "string" },
        allowModuleScripts: { type: "boolean" },
        async: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const;

const CREATION_PAYLOAD_REQUIREMENTS_TEXT =
  "Payload format: use payload.importMode to choose the lane. For direct_files, provide payload.files with { path, content, contentEncoding? }. For github_import, provide payload.github.url. For zip_import, provide payload.zip.fileName and payload.zip.fileBase64. Optional payload fields are title, runner, entry, sourceReference, metadata, and idempotencyKey. Do not invent wrapper keys outside this shape.";

const THUMBNAIL_FILE_INPUT_SCHEMA = {
  type: "object",
  required: ["fileId", "downloadUrl", "contentType"],
  properties: {
    fileId: { type: "string" },
    downloadUrl: { type: "string", format: "uri" },
    contentType: { type: "string" },
    fileName: { type: "string" }
  },
  additionalProperties: false
} as const;

const THUMBNAIL_UPLOAD_INPUT_SCHEMA = {
  type: "object",
  required: ["contentType", "fileBase64"],
  properties: {
    contentType: { type: "string" },
    fileBase64: { type: "string" },
    fileName: { type: "string" }
  },
  additionalProperties: false
} as const;

function buildAuthServerUri(appBaseUrl: string): string {
  return appBaseUrl.replace(/\/$/, "") + "/authorize";
}

function toolMetaBase(
  securitySchemes: Array<{ type: string; scopes?: string[] }>,
  includeWidget = true
): Record<string, unknown> {
  return includeWidget
    ? {
        securitySchemes,
        "openai/outputTemplate": "ui://widget/publisher-v1",
        ui: { resourceUri: "ui://widget/publisher-v1", visibility: ["model", "app"] }
      }
    : { securitySchemes };
}

function stripWidgetMeta<T extends Record<string, unknown> | undefined>(meta: T): T {
  if (!meta) return meta;
  const sanitized = { ...meta };
  delete sanitized["ui"];
  delete sanitized["openai/outputTemplate"];
  delete sanitized["openai/toolInvocation/invoking"];
  delete sanitized["openai/toolInvocation/invoked"];
  return sanitized as T;
}

function sanitizeToolDescriptorForPresentation(descriptor: ToolDescriptor, options?: ToolPresentationOptions): ToolDescriptor {
  if (options?.supportsUi !== false) return descriptor;
  return {
    ...descriptor,
    _meta: stripWidgetMeta(descriptor._meta)
  };
}

function stripOutputSchemaFromDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const { outputSchema: _outputSchema, ...rest } = descriptor;
  return rest;
}

function withWidgetTemplateMeta(result: ToolResult): ToolResult {
  return {
    ...result,
    _meta: {
      "openai/outputTemplate": "ui://widget/publisher-v1",
      ...(result._meta || {})
    }
  };
}

function sanitizeToolResultForPresentation(result: ToolResult, options?: ToolPresentationOptions): ToolResult {
  if (options?.supportsUi !== false) return result;
  return {
    ...result,
    _meta: stripWidgetMeta(result._meta)
  };
}

export function buildToolWwwAuthenticate(
  appBaseUrl: string,
  options?: {
    scope?: string;
    error?: "invalid_token" | "insufficient_scope";
  }
): string {
  const authServerUri = buildAuthServerUri(appBaseUrl);
  const resourceMetadataUri = appBaseUrl.replace(/\/$/, "") + "/.well-known/oauth-protected-resource/mcp";
  const parts = [
    "Bearer realm=\"vibecodr\"",
    `authorization_uri=\"${authServerUri}\"`,
    `resource_metadata=\"${resourceMetadataUri}\"`,
    `scope=\"${(options?.scope || OAUTH_TOOL_SCOPES.join(" ")).replace(/"/g, "")}\"`
  ];
  if (options?.error) {
    parts.push(`error=\"${options.error}\"`);
  }
  return parts.join(", ");
}

function unauthorizedToolResult(appBaseUrl: string): ToolResult {
  const authServerUri = buildAuthServerUri(appBaseUrl);
  const resourceMetadataUri = appBaseUrl.replace(/\/$/, "") + "/.well-known/oauth-protected-resource/mcp";
  const requiredScopes = OAUTH_TOOL_SCOPES;
  const wwwAuthenticate = buildToolWwwAuthenticate(appBaseUrl, { scope: requiredScopes.join(" ") });
  return {
    content: [{
      type: "text",
      text:
        "Connection required before publish actions can write to the user's Vibecodr account. Start the Vibecodr MCP OAuth flow in your MCP client, then continue the same guided publish flow. CLI auth, editor auth, and widget auth are separate."
    }],
    structuredContent: {
      authRequired: true,
      authUri: authServerUri,
      resourceMetadataUri,
      requiredScopes,
      userMessage: "Connect Vibecodr MCP auth to continue the publish flow. CLI auth, editor auth, and widget auth are separate."
    },
    _meta: {
      "mcp/www_authenticate": wwwAuthenticate
    }
  };
}

type ErrorStructuredContent = {
  error: string;
  message?: string;
  errorId: string;
};

function buildErrorStructured(error: string, message?: string): ErrorStructuredContent {
  return { error, ...(message ? { message } : {}), errorId: randomUUID() };
}

function toolErrorResult(text: string, error: string, message?: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: buildErrorStructured(error, message)
  };
}

function packageResolutionToolResult(error: PackageResolutionError): ToolResult {
  const candidates = Array.isArray(error.details?.["candidateEntries"])
    ? (error.details?.["candidateEntries"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const suffix = candidates.length > 0 ? " Candidates: " + candidates.join(", ") + "." : "";
  return toolErrorResult(error.message + suffix, error.code, error.message);
}

export async function getSessionForToolRequest(
  req: Request,
  deps: ToolDeps,
  traceId?: string
): Promise<SessionRecord | null> {
  const resolved = await resolveRequestSession(req, {
    sessionStore: deps.sessionStore,
    telemetry: deps.telemetry,
    vibecodrApiBase: deps.vibecodrApiBase,
    vibecodrFetch: deps.vibecodrFetch
  }, traceId);
  return resolved.session;
}

export function toolRequiresAuth(name: string): boolean {
  const descriptor = getTools().find((tool) => tool.name === name);
  return Boolean(descriptor?.securitySchemes.some((scheme) => scheme.type === "oauth2"));
}

function parseSeoFields(raw: unknown): { title?: string; description?: string; imageKey?: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const fields: { title?: string; description?: string; imageKey?: string } = {};
  if (typeof obj["title"] === "string") fields.title = obj["title"];
  if (typeof obj["description"] === "string") fields.description = obj["description"];
  if (typeof obj["imageKey"] === "string") fields.imageKey = obj["imageKey"];
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function parseSeoArg(raw: unknown): PublishSeoInput | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const seo: PublishSeoInput = {};

  if (typeof source["title"] === "string") seo.title = source["title"];
  if (typeof source["description"] === "string") seo.description = source["description"];
  if (typeof source["imageKey"] === "string") seo.imageKey = source["imageKey"];

  if (Object.prototype.hasOwnProperty.call(source, "og")) {
    seo.og = source["og"] === null ? null : parseSeoFields(source["og"]);
  }

  if (Object.prototype.hasOwnProperty.call(source, "twitter")) {
    seo.twitter = source["twitter"] === null ? null : parseSeoFields(source["twitter"]);
  }

  return Object.keys(seo).length > 0 ? seo : undefined;
}

function parseThumbnailFileArg(raw: unknown): PublishThumbnailFile | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("thumbnailFile must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  const fileId = typeof obj["fileId"] === "string" ? obj["fileId"].trim() : "";
  const downloadUrl = typeof obj["downloadUrl"] === "string" ? obj["downloadUrl"].trim() : "";
  const contentType = typeof obj["contentType"] === "string" ? obj["contentType"].trim().toLowerCase() : "";
  if (!fileId || !downloadUrl || !contentType) {
    throw new Error("thumbnailFile.fileId, thumbnailFile.downloadUrl, and thumbnailFile.contentType are required.");
  }
  validateOpenAiDownloadUrl(downloadUrl);
  if (!isAllowedThumbnailMime(contentType)) {
    throw new Error("thumbnailFile.contentType must be one of: image/png, image/jpeg, image/webp, image/avif, image/gif.");
  }
  const fileName = typeof obj["fileName"] === "string" ? obj["fileName"] : undefined;
  return { fileId, downloadUrl, contentType, ...(fileName ? { fileName } : {}) };
}

function parseThumbnailUploadArg(raw: unknown): PublishThumbnailUpload | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("thumbnailUpload must be an object.");
  }
  const obj = raw as Record<string, unknown>;
  const contentType = typeof obj["contentType"] === "string" ? obj["contentType"].trim().toLowerCase() : "";
  const rawBase64 = typeof obj["fileBase64"] === "string" ? obj["fileBase64"] : "";
  if (!contentType || !rawBase64) {
    throw new Error("thumbnailUpload.contentType and thumbnailUpload.fileBase64 are required.");
  }
  if (!isAllowedThumbnailMime(contentType)) {
    throw new Error("thumbnailUpload.contentType must be one of: image/png, image/jpeg, image/webp, image/avif, image/gif.");
  }

  const fileBase64 = rawBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!fileBase64) {
    throw new Error("thumbnailUpload.fileBase64 is empty after normalization.");
  }
  const estimatedBytes = Math.floor((fileBase64.length * 3) / 4);
  if (estimatedBytes > MAX_INLINE_THUMBNAIL_BYTES) {
    throw new Error("thumbnailUpload exceeds the inline MCP payload limit. Prefer thumbnailFile or keep the raw file under 900 KB.");
  }
  const fileName = typeof obj["fileName"] === "string" ? obj["fileName"] : undefined;
  return { contentType, fileBase64, ...(fileName ? { fileName } : {}) };
}

function parseThumbnailArgs(args: Record<string, unknown>): {
  thumbnailFile?: PublishThumbnailFile;
  thumbnailUpload?: PublishThumbnailUpload;
} {
  return {
    thumbnailFile: parseThumbnailFileArg(args["thumbnailFile"]),
    thumbnailUpload: parseThumbnailUploadArg(args["thumbnailUpload"])
  };
}

function parseCoverKeyArg(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

function parseVisibilityArg(raw: unknown): PublishVisibility | undefined {
  if (raw !== "public" && raw !== "unlisted" && raw !== "private") return undefined;
  return raw;
}

function parseVisibilityWithDefault(raw: unknown): PublishVisibility {
  return parseVisibilityArg(raw) || "public";
}

function parseSourceTypeArg(raw: unknown): SourceType {
  if (raw !== "codex_v1" && raw !== "chatgpt_v1") throw new Error("sourceType must be codex_v1 or chatgpt_v1.");
  return raw;
}

function parseTimeoutSecondsArg(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WATCH_TIMEOUT_SECONDS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("timeoutSeconds must be a number.");
  return Math.min(Math.max(Math.floor(raw), 5), 600);
}

function parsePollIntervalArg(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WATCH_POLL_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("pollIntervalMs must be a number.");
  return Math.min(Math.max(Math.floor(raw), 250), 10000);
}

function parseTargetStatusesArg(raw: unknown): OperationStatus[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("targetStatuses must be an array of operation statuses.");
  const normalized = raw
    .map((item) => (typeof item === "string" ? item : ""))
    .filter((item): item is OperationStatus => (ALLOWED_OPERATION_STATUSES as readonly string[]).includes(item));
  if (normalized.length === 0) throw new Error("targetStatuses did not contain any valid operation statuses.");
  return [...new Set(normalized)];
}

type PublicOperationLink = {
  label: string;
  href: string;
};

type PublicOperationDiagnostic = {
  at: number;
  stage: string;
  code: string;
  message: string;
  retryable?: boolean;
};

type PublicOperationSummary = {
  sourceType: SourceType;
  status: OperationStatus;
  currentStage: string;
  diagnostics: PublicOperationDiagnostic[];
  links?: PublicOperationLink[];
};

type RecoveryOperationSummary = {
  operationId: string;
  sourceType: SourceType;
  status: OperationStatus;
  currentStage: string;
  capsuleId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  diagnostics: PublicOperationDiagnostic[];
  links?: PublicOperationLink[];
};

type PublicDraftSummary = {
  draftId: string;
  title?: string;
  slug?: string;
  status?: string;
  visibility?: string;
  updatedAt?: number | string;
  createdAt?: number | string;
  publishedUrl?: string;
  packageSummary?: {
    runner?: string;
    entry?: string;
    fileCount?: number;
    importMode?: string;
  };
};

function readStringField(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function readNumberOrStringField(source: Record<string, unknown>, keys: string[]): number | string | undefined {
  for (const key of keys) {
    const value = source[key];
    if ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim())) {
      return value;
    }
  }
  return undefined;
}

function collectOperationLinks(operation: ImportOperation): PublicOperationLink[] | undefined {
  const links: PublicOperationLink[] = [];
  for (const diagnostic of operation.diagnostics) {
    const details = diagnostic.details;
    if (!details || typeof details !== "object") continue;
    const artifactUrl = typeof details["artifactUrl"] === "string" ? details["artifactUrl"] : undefined;
    const postUrl = typeof details["postUrl"] === "string" ? details["postUrl"] : undefined;
    if (artifactUrl) links.push({ label: "Artifact", href: artifactUrl });
    if (postUrl) links.push({ label: "Live vibe", href: postUrl });
  }
  const deduped = links.filter((link, index) => links.findIndex((candidate) => candidate.href === link.href) === index);
  return deduped.length ? deduped : undefined;
}

function extractPublishedPostId(operation: ImportOperation): string | undefined {
  for (let index = operation.diagnostics.length - 1; index >= 0; index -= 1) {
    const details = operation.diagnostics[index]?.details;
    if (!details || typeof details !== "object") continue;
    const postId = typeof details["postId"] === "string" ? details["postId"] : undefined;
    if (postId) return postId;
  }
  return undefined;
}

function collectMetadataWarnings(operation: ImportOperation): string[] {
  const warnings: string[] = [];
  for (const diagnostic of operation.diagnostics) {
    if (diagnostic.code === "POST_METADATA_FAILED") {
      warnings.push("The vibe is live, but the cover image or SEO metadata still needs a follow-up update.");
    } else if (diagnostic.code === "POST_METADATA_SKIPPED") {
      warnings.push("The vibe is live, but the requested cover image or SEO update could not be attached automatically.");
    }
  }
  return [...new Set(warnings)];
}

function summarizePublishOutcome(operation: ImportOperation): {
  published: boolean;
  warnings: string[];
  message: string;
} {
  const warnings = collectMetadataWarnings(operation);
  if (operation.status !== "published" && operation.status !== "published_with_warnings") {
    return {
      published: false,
      warnings,
      message: "Quick publish did not complete."
    };
  }
  if (warnings.length > 0 || operation.currentStage === "published_with_warnings") {
    return {
      published: true,
      warnings,
      message: "The vibe is live, but launch polish needs one follow-up step."
    };
  }
  return {
    published: true,
    warnings,
    message: "Quick publish completed successfully."
  };
}

function summarizeOperation(operation: ImportOperation): RecoveryOperationSummary {
  const links = collectOperationLinks(operation);
  return {
    operationId: operation.operationId,
    sourceType: operation.sourceType,
    status: operation.status,
    currentStage: operation.currentStage,
    ...(operation.capsuleId ? { capsuleId: operation.capsuleId } : {}),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
    diagnostics: operation.diagnostics.map((diagnostic) => translateDiagnosticForPublic(diagnostic, operation.status)),
    ...(links ? { links } : {})
  };
}

function summarizePublicOperation(operation: ImportOperation): PublicOperationSummary {
  const links = collectOperationLinks(operation);
  return {
    sourceType: operation.sourceType,
    status: operation.status,
    currentStage: operation.currentStage,
    diagnostics: operation.diagnostics.map((diagnostic) => translateDiagnosticForPublic(diagnostic, operation.status)),
    ...(links ? { links } : {})
  };
}

function extractDraftArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const nested = obj["drafts"];
  if (Array.isArray(nested)) {
    return nested.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  const capsules = obj["capsules"];
  if (Array.isArray(capsules)) {
    return capsules.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  return [];
}

function summarizeDraft(raw: unknown): PublicDraftSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const manifest = obj["manifest"] && typeof obj["manifest"] === "object" && !Array.isArray(obj["manifest"])
    ? obj["manifest"] as Record<string, unknown>
    : obj["draftManifest"] && typeof obj["draftManifest"] === "object" && !Array.isArray(obj["draftManifest"])
      ? obj["draftManifest"] as Record<string, unknown>
      : undefined;
  const draftId = readStringField(obj, ["draftId", "id", "capsuleId", "postId"]);
  if (!draftId) return null;

  const files = Array.isArray(obj["files"]) ? obj["files"] : Array.isArray((obj["package"] as Record<string, unknown> | undefined)?.["files"]) ? ((obj["package"] as Record<string, unknown>)["files"] as unknown[]) : undefined;
  const packageSummary = {
    runner:
      readStringField(obj, ["runner"]) ||
      (obj["package"] && typeof obj["package"] === "object" ? readStringField(obj["package"] as Record<string, unknown>, ["runner"]) : undefined) ||
      (manifest ? readStringField(manifest, ["runner"]) : undefined),
    entry:
      readStringField(obj, ["entry", "entryPoint"]) ||
      (obj["package"] && typeof obj["package"] === "object" ? readStringField(obj["package"] as Record<string, unknown>, ["entry"]) : undefined) ||
      (manifest ? readStringField(manifest, ["entry"]) : undefined),
    fileCount: Array.isArray(files) ? files.length : undefined,
    importMode: readStringField(obj, ["importMode"]) || (obj["package"] && typeof obj["package"] === "object" ? readStringField(obj["package"] as Record<string, unknown>, ["importMode"]) : undefined)
  };

  const summary: PublicDraftSummary = {
    draftId,
    ...(readStringField(obj, ["title", "name"]) || (manifest ? readStringField(manifest, ["title", "name"]) : undefined)
      ? { title: readStringField(obj, ["title", "name"]) || (manifest ? readStringField(manifest, ["title", "name"]) : undefined) }
      : {}),
    ...(readStringField(obj, ["slug"]) ? { slug: readStringField(obj, ["slug"]) } : {}),
    ...(readStringField(obj, ["status", "state", "publishState"]) ? { status: readStringField(obj, ["status", "state", "publishState"]) } : {}),
    ...(readStringField(obj, ["visibility"]) ? { visibility: readStringField(obj, ["visibility"]) } : {}),
    ...(readNumberOrStringField(obj, ["updatedAt", "updated_at"]) !== undefined ? { updatedAt: readNumberOrStringField(obj, ["updatedAt", "updated_at"]) } : {}),
    ...(readNumberOrStringField(obj, ["createdAt", "created_at"]) !== undefined ? { createdAt: readNumberOrStringField(obj, ["createdAt", "created_at"]) } : {}),
    ...(readStringField(obj, ["publishedUrl", "shareUrl", "url"]) || readStringField(obj, ["existingPostId"])
      ? {
          publishedUrl:
            readStringField(obj, ["publishedUrl", "shareUrl", "url"]) ||
            "https://vibecodr.space/post/" + encodeURIComponent(String(readStringField(obj, ["existingPostId"])))
        }
      : {})
  };

  if (packageSummary.runner || packageSummary.entry || packageSummary.fileCount !== undefined || packageSummary.importMode) {
    summary.packageSummary = packageSummary;
  }
  return summary;
}

function summarizeReadinessChecks(checks: Array<{ id: string; level: "pass" | "warning" | "blocking"; message: string } & Record<string, unknown>>) {
  return checks.map((check) => ({
    id: check.id,
    level: check.level,
    message: check.message
  }));
}

function summarizeQuickPublishSteps(
  steps: Array<{ step: "import" | "wait_for_draft" | "compile" | "publish"; status: "completed" | "skipped" | "failed" | "timed_out"; message: string; at: number } & Record<string, unknown>>
) {
  return steps.map((step) => ({
    step: step.step,
    status: step.status,
    message: step.message,
    at: step.at
  }));
}

const JSON_ERROR_SCHEMA = {
  type: "object",
  required: ["error", "errorId"],
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    errorId: { type: "string" }
  },
  additionalProperties: true
} as const;

const JSON_AUTH_CHALLENGE_SCHEMA = {
  type: "object",
  required: ["authRequired", "authUri", "resourceMetadataUri", "requiredScopes", "userMessage"],
  properties: {
    authRequired: { type: "boolean", const: true },
    authUri: { type: "string" },
    resourceMetadataUri: { type: "string" },
    requiredScopes: {
      type: "array",
      items: { type: "string" }
    },
    userMessage: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_FEATURE_DISABLED_SCHEMA = {
  type: "object",
  required: ["enabled"],
  properties: {
    enabled: { type: "boolean", const: false },
    sourceType: { type: "string", enum: SOURCE_TYPE_VALUES }
  },
  additionalProperties: false
} as const;

const JSON_DIAGNOSTIC_SCHEMA = {
  type: "object",
  required: ["at", "stage", "code", "message"],
  properties: {
    at: { type: "number" },
    stage: { type: "string" },
    code: { type: "string" },
    message: { type: "string" },
    retryable: { type: "boolean" }
  },
  additionalProperties: false
} as const;

const JSON_OPERATION_LINK_SCHEMA = {
  type: "object",
  required: ["label", "href"],
  properties: {
    label: { type: "string" },
    href: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_PUBLIC_OPERATION_SCHEMA = {
  type: "object",
  required: ["sourceType", "status", "currentStage", "diagnostics"],
  properties: {
    sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
    status: { type: "string", enum: ALLOWED_OPERATION_STATUSES },
    currentStage: { type: "string" },
    diagnostics: { type: "array", items: JSON_DIAGNOSTIC_SCHEMA },
    links: { type: "array", items: JSON_OPERATION_LINK_SCHEMA }
  },
  additionalProperties: false
} as const;

const JSON_OPERATION_SCHEMA = {
  type: "object",
  required: ["operationId", "sourceType", "status", "currentStage", "diagnostics", "createdAt", "updatedAt"],
  properties: {
    operationId: { type: "string" },
    sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
    status: { type: "string", enum: ALLOWED_OPERATION_STATUSES },
    currentStage: { type: "string" },
    capsuleId: { type: "string" },
    diagnostics: { type: "array", items: JSON_DIAGNOSTIC_SCHEMA },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    completedAt: { type: "number" },
    links: { type: "array", items: JSON_OPERATION_LINK_SCHEMA }
  },
  additionalProperties: false
} as const;

const JSON_DRAFT_PACKAGE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    runner: { type: "string" },
    entry: { type: "string" },
    fileCount: { type: "number" },
    importMode: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_DRAFT_SUMMARY_SCHEMA = {
  type: "object",
  required: ["draftId"],
  properties: {
    draftId: { type: "string" },
    title: { type: "string" },
    slug: { type: "string" },
    status: { type: "string" },
    visibility: { type: "string" },
    updatedAt: { anyOf: [{ type: "number" }, { type: "string" }] },
    createdAt: { anyOf: [{ type: "number" }, { type: "string" }] },
    publishedUrl: { type: "string" },
    packageSummary: JSON_DRAFT_PACKAGE_SUMMARY_SCHEMA
  },
  additionalProperties: false
} as const;

const JSON_LIVE_VIBE_STATS_SCHEMA = {
  type: "object",
  required: ["runs", "likes", "comments", "remixes"],
  properties: {
    runs: { type: "number" },
    likes: { type: "number" },
    comments: { type: "number" },
    remixes: { type: "number" },
    views: { type: "number" },
    embedViews: { type: "number" }
  },
  additionalProperties: false
} as const;

const JSON_LIVE_VIBE_PACKAGE_SCHEMA = {
  type: "object",
  properties: {
    runner: { type: "string" },
    entry: { type: "string" },
    artifactId: { type: ["string", "null"] }
  },
  additionalProperties: false
} as const;

const JSON_LIVE_VIBE_SCHEMA = {
  type: "object",
  required: ["postId", "title", "visibility", "playerUrl", "postUrl", "stats"],
  properties: {
    postId: { type: "string" },
    title: { type: "string" },
    description: { type: ["string", "null"] },
    visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
    authorHandle: { type: "string" },
    authorName: { type: ["string", "null"] },
    coverKey: { type: ["string", "null"] },
    createdAt: { anyOf: [{ type: "number" }, { type: "string" }] },
    updatedAt: { anyOf: [{ type: "number" }, { type: "string" }] },
    playerUrl: { type: "string" },
    postUrl: { type: "string" },
    capsuleId: { type: ["string", "null"] },
    stats: JSON_LIVE_VIBE_STATS_SCHEMA,
    packageSummary: JSON_LIVE_VIBE_PACKAGE_SCHEMA
  },
  additionalProperties: false
} as const;

const JSON_PUBLISH_READINESS_CHECK_SCHEMA = {
  type: "object",
  required: ["id", "level", "message"],
  properties: {
    id: { type: "string" },
    level: { type: "string", enum: ["pass", "warning", "blocking"] },
    message: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_QUICK_PUBLISH_STEP_SCHEMA = {
  type: "object",
  required: ["step", "status", "message", "at"],
  properties: {
    step: { type: "string", enum: ["import", "wait_for_draft", "compile", "publish"] },
    status: { type: "string", enum: ["completed", "skipped", "failed", "timed_out"] },
    message: { type: "string" },
    at: { type: "number" }
  },
  additionalProperties: false
} as const;

const TOOL_OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  get_vibecodr_platform_overview: {
    type: "object",
    required: ["name", "tagline", "summary", "assistantAnswer", "coreConcepts", "socialFeatures", "creationFlow", "urls"],
    properties: {
      name: { type: "string" },
      tagline: { type: "string" },
      summary: { type: "string" },
      assistantAnswer: { type: "string" },
      coreConcepts: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "description"],
          properties: {
            name: { type: "string" },
            description: { type: "string" }
          },
          additionalProperties: false
        }
      },
      socialFeatures: { type: "array", items: { type: "string" } },
      creationFlow: { type: "array", items: { type: "string" } },
      urls: {
        type: "object",
        required: ["home", "signUp"],
        properties: {
          home: { type: "string" },
          signUp: { type: "string" }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  },
  get_guided_publish_requirements: {
    type: "object",
    required: ["goal", "assistantBehavior", "failureBehavior", "requiredQuestions", "optionalQuestions", "defaultFlow", "entryConventions", "primaryTools", "recoveryTools"],
    properties: {
      goal: { type: "string" },
      assistantBehavior: { type: "array", items: { type: "string" } },
      failureBehavior: { type: "array", items: { type: "string" } },
      requiredQuestions: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "question", "whyItMatters"],
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            whyItMatters: { type: "string" }
          },
          additionalProperties: false
        }
      },
      optionalQuestions: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "question", "whyItMatters"],
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            whyItMatters: { type: "string" }
          },
          additionalProperties: false
        }
      },
      defaultFlow: { type: "array", items: { type: "string" } },
      entryConventions: {
        type: "object",
        required: ["mustBeExplicitWhenKnown", "preferredOrder", "clarificationQuestion"],
        properties: {
          mustBeExplicitWhenKnown: { type: "boolean" },
          preferredOrder: { type: "array", items: { type: "string" } },
          clarificationQuestion: { type: "string" }
        },
        additionalProperties: false
      },
      primaryTools: { type: "array", items: { type: "string" } },
      recoveryTools: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  },
  get_upload_capabilities: {
    type: "object",
    required: ["sourceTypes", "importModes", "defaultVisibility", "limits", "runners", "recommendedFirstRunFlow", "entryConventions", "publicPrimaryTools", "recoveryTools"],
    properties: {
      sourceTypes: { type: "array", items: { type: "string", enum: SOURCE_TYPE_VALUES } },
      importModes: { type: "array", items: { type: "string", enum: ["direct_files", "zip_import", "github_import"] } },
      defaultVisibility: { type: "string", const: "public" },
      limits: {
        type: "object",
        required: ["maxFiles", "maxPayloadChars"],
        properties: { maxFiles: { type: "number" }, maxPayloadChars: { type: "number" } },
        additionalProperties: false
      },
      runners: { type: "array", items: { type: "string", enum: ["client-static", "webcontainer"] } },
      recommendedFirstRunFlow: { type: "string", enum: ["quick_publish_creation"] },
      entryConventions: {
        type: "object",
        required: ["preferredOrder", "mustBeExplicitWhenKnown"],
        properties: {
          preferredOrder: { type: "array", items: { type: "string" } },
          mustBeExplicitWhenKnown: { type: "boolean" }
        },
        additionalProperties: false
      },
      publicPrimaryTools: { type: "array", items: { type: "string" } },
      recoveryTools: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  },
  get_launch_best_practices: {
    type: "object",
    required: ["headline", "summary", "premiumLaunchChecklist", "assistantBehavior", "coverGuidance", "seoGuidance", "polishMoments"],
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      premiumLaunchChecklist: { type: "array", items: { type: "string" } },
      assistantBehavior: { type: "array", items: { type: "string" } },
      coverGuidance: {
        type: "object",
        required: ["shouldOfferGeneration", "whenToOffer", "whyItMatters", "generationSpec"],
        properties: {
          shouldOfferGeneration: { type: "boolean" },
          whenToOffer: { type: "string" },
          whyItMatters: { type: "string" },
          generationSpec: {
            type: "object",
            required: ["preferredAspectRatio", "preferredSize", "minimumSize", "avoid", "fileGuidance"],
            properties: {
              preferredAspectRatio: { type: "string" },
              preferredSize: { type: "string" },
              minimumSize: { type: "string" },
              avoid: { type: "array", items: { type: "string" } },
              fileGuidance: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      seoGuidance: {
        type: "object",
        required: ["shouldOfferForPublicLaunch", "whyItMatters", "requiresCapabilityCheck"],
        properties: {
          shouldOfferForPublicLaunch: { type: "boolean" },
          whyItMatters: { type: "string" },
          requiresCapabilityCheck: { type: "boolean" }
        },
        additionalProperties: false
      },
      polishMoments: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  },
  get_pulse_setup_guidance: {
    type: "object",
    required: ["headline", "summary", "whenFrontendOnlyIsEnough", "whenYouNeedPulses", "runnerGuidance", "pulseBestPractices", "accountReminder"],
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      whenFrontendOnlyIsEnough: { type: "array", items: { type: "string" } },
      whenYouNeedPulses: { type: "array", items: { type: "string" } },
      runnerGuidance: { type: "array", items: { type: "string" } },
      pulseBestPractices: { type: "array", items: { type: "string" } },
      accountReminder: { type: "string" }
    },
    additionalProperties: false
  },
  get_account_capabilities: {
    oneOf: [
      {
        type: "object",
        required: ["account"],
        properties: {
          account: {
            type: "object",
            required: ["profile", "quota", "launchDefaults", "features", "remaining", "recommendations"],
            properties: {
              profile: {
                type: "object",
                required: ["id", "handle"],
                properties: {
                  id: { type: "string" },
                  handle: { type: "string" },
                  name: { type: ["string", "null"] },
                  avatarUrl: { type: ["string", "null"] },
                  bio: { type: ["string", "null"] },
                  plan: { type: "string" }
                },
                additionalProperties: true
              },
              quota: { type: "object", additionalProperties: true },
              launchDefaults: {
                type: "object",
                required: ["visibility", "shouldOfferCoverGeneration", "shouldOfferCustomSeo", "shouldOfferPulseGuidance"],
                properties: {
                  visibility: { type: "string", const: "public" },
                  shouldOfferCoverGeneration: { type: "boolean" },
                  shouldOfferCustomSeo: { type: "boolean" },
                  shouldOfferPulseGuidance: { type: "boolean" }
                },
                additionalProperties: false
              },
              features: {
                type: "object",
                required: ["customSeo", "canUsePrivateOrUnlisted", "pulsesEnabled", "serverActionsEnabled", "webhookActionsEnabled"],
                properties: {
                  customSeo: { type: "boolean" },
                  canUsePrivateOrUnlisted: { type: "boolean" },
                  pulsesEnabled: { type: "boolean" },
                  serverActionsEnabled: { type: "boolean" },
                  webhookActionsEnabled: { type: "boolean" }
                },
                additionalProperties: false
              },
              remaining: {
                type: "object",
                required: ["pulseSlots", "pulseRunsThisMonth", "webhookCalls"],
                properties: {
                  pulseSlots: { type: "number" },
                  pulseRunsThisMonth: { anyOf: [{ type: "number" }, { type: "string", const: "unlimited" }] },
                  webhookCalls: { type: "number" },
                  privateVibes: { anyOf: [{ type: "number" }, { type: "string", const: "unlimited" }] },
                  privatePulses: { anyOf: [{ type: "number" }, { type: "string", const: "unlimited" }] }
                },
                additionalProperties: false
              },
              recommendations: { type: "array", items: { type: "string" } }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  list_import_operations: {
    oneOf: [
      {
        type: "object",
        required: ["operations"],
        properties: {
          operations: { type: "array", items: JSON_OPERATION_SCHEMA }
        },
        additionalProperties: false
      },
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_import_operation: {
    oneOf: [
      {
        type: "object",
        required: ["found"],
        properties: { found: { type: "boolean", const: false } },
        additionalProperties: false
      },
      {
        type: "object",
        required: ["found", "operation"],
        properties: { found: { type: "boolean", const: true }, operation: JSON_OPERATION_SCHEMA },
        additionalProperties: false
      },
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  watch_operation: {
    oneOf: [
      {
        type: "object",
        required: ["operation", "reachedTarget", "timedOut", "elapsedMs", "pollCount", "targetStatuses"],
        properties: {
          operation: JSON_OPERATION_SCHEMA,
          reachedTarget: { type: "boolean" },
          timedOut: { type: "boolean" },
          elapsedMs: { type: "number" },
          pollCount: { type: "number" },
          targetStatuses: { type: "array", items: { type: "string", enum: ALLOWED_OPERATION_STATUSES } }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_publish_readiness: {
    oneOf: [
      {
        type: "object",
        required: ["readyToPublish", "operation", "checks", "recommendedActions"],
        properties: {
          readyToPublish: { type: "boolean" },
          operation: JSON_PUBLIC_OPERATION_SCHEMA,
          checks: { type: "array", items: JSON_PUBLISH_READINESS_CHECK_SCHEMA },
          recommendedActions: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  explain_operation_failure: {
    oneOf: [
      {
        type: "object",
        required: ["status", "failed", "retryable", "userMessage", "nextActions", "latestDiagnostics"],
        properties: {
          status: { type: "string", enum: ALLOWED_OPERATION_STATUSES },
          failed: { type: "boolean" },
          rootCauseCode: { type: "string" },
          rootCauseMessage: { type: "string" },
          retryable: { type: "boolean" },
          userMessage: { type: "string" },
          nextActions: { type: "array", items: { type: "string" } },
          latestDiagnostics: {
            type: "array",
            items: {
              type: "object",
              required: ["at", "stage", "code", "message"],
              properties: {
                at: { type: "number" },
                stage: { type: "string" },
                code: { type: "string" },
                message: { type: "string" },
                retryable: { type: "boolean" }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  list_vibecodr_drafts: {
    oneOf: [
      {
        type: "object",
        required: ["drafts"],
        properties: { drafts: { type: "array", items: JSON_DRAFT_SUMMARY_SCHEMA } },
        additionalProperties: false
      },
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_vibecodr_draft: {
    oneOf: [
      {
        type: "object",
        required: ["draft"],
        properties: { draft: JSON_DRAFT_SUMMARY_SCHEMA },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  list_my_live_vibes: {
    oneOf: [
      {
        type: "object",
        required: ["profile", "vibes"],
        properties: {
          profile: {
            type: "object",
            required: ["id", "handle"],
            properties: {
              id: { type: "string" },
              handle: { type: "string" },
              name: { type: ["string", "null"] },
              avatarUrl: { type: ["string", "null"] },
              bio: { type: ["string", "null"] },
              plan: { type: "string" }
            },
            additionalProperties: true
          },
          vibes: { type: "array", items: JSON_LIVE_VIBE_SCHEMA }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_live_vibe: {
    oneOf: [
      {
        type: "object",
        required: ["vibe"],
        properties: { vibe: JSON_LIVE_VIBE_SCHEMA },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_vibe_engagement_summary: {
    oneOf: [
      {
        type: "object",
        required: ["engagement"],
        properties: {
          engagement: {
            type: "object",
            required: ["postId", "title", "visibility", "playerUrl", "postUrl", "stats", "summary"],
            properties: {
              postId: { type: "string" },
              title: { type: "string" },
              visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
              playerUrl: { type: "string" },
              postUrl: { type: "string" },
              stats: JSON_LIVE_VIBE_STATS_SCHEMA,
              summary: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_vibe_share_link: {
    oneOf: [
      {
        type: "object",
        required: ["share"],
        properties: {
          share: {
            type: "object",
            required: ["postId", "title", "visibility", "postUrl", "playerUrl", "shareCta"],
            properties: {
              postId: { type: "string" },
              title: { type: "string" },
              visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
              postUrl: { type: "string" },
              playerUrl: { type: "string" },
              shareCta: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  update_live_vibe_metadata: {
    oneOf: [
      {
        type: "object",
        required: ["vibe"],
        properties: { vibe: JSON_LIVE_VIBE_SCHEMA },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  start_creation_import: {
    oneOf: [
      {
        type: "object",
        required: ["operation"],
        properties: { operation: JSON_PUBLIC_OPERATION_SCHEMA },
        additionalProperties: false
      },
      JSON_FEATURE_DISABLED_SCHEMA,
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  compile_draft_capsule: {
    oneOf: [
      {
        type: "object",
        required: ["operation"],
        properties: { operation: JSON_OPERATION_SCHEMA },
        additionalProperties: false
      },
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  quick_publish_creation: {
    oneOf: [
      {
        type: "object",
        required: ["operation", "published", "timedOut", "steps", "recommendedActions"],
        properties: {
          operation: JSON_PUBLIC_OPERATION_SCHEMA,
          published: { type: "boolean" },
          timedOut: { type: "boolean" },
          steps: { type: "array", items: JSON_QUICK_PUBLISH_STEP_SCHEMA },
          recommendedActions: { type: "array", items: { type: "string" } },
          vibe: JSON_LIVE_VIBE_SCHEMA,
          share: {
            type: "object",
            required: ["postId", "title", "visibility", "postUrl", "playerUrl", "shareCta"],
            properties: {
              postId: { type: "string" },
              title: { type: "string" },
              visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
              postUrl: { type: "string" },
              playerUrl: { type: "string" },
              shareCta: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      JSON_FEATURE_DISABLED_SCHEMA,
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  publish_draft_capsule: {
    oneOf: [
      {
        type: "object",
        required: ["operation"],
        properties: { operation: JSON_OPERATION_SCHEMA, vibe: JSON_LIVE_VIBE_SCHEMA },
        additionalProperties: false
      },
      JSON_FEATURE_DISABLED_SCHEMA,
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  cancel_import_operation: {
    oneOf: [
      {
        type: "object",
        required: ["operation"],
        properties: { operation: JSON_OPERATION_SCHEMA },
        additionalProperties: false
      },
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  unknown_tool: JSON_ERROR_SCHEMA
};

const DiagnosticValidator = z.object({
  at: z.number(),
  stage: z.string(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional()
});

const OperationLinkValidator = z.object({
  label: z.string(),
  href: z.string()
});

const PublicOperationValidator = z.object({
  sourceType: z.enum(SOURCE_TYPE_VALUES),
  status: z.enum(ALLOWED_OPERATION_STATUSES),
  currentStage: z.string(),
  diagnostics: z.array(DiagnosticValidator),
  links: z.array(OperationLinkValidator).optional()
});

const OperationValidator = z.object({
  operationId: z.string(),
  sourceType: z.enum(SOURCE_TYPE_VALUES),
  status: z.enum(ALLOWED_OPERATION_STATUSES),
  currentStage: z.string(),
  capsuleId: z.string().optional(),
  diagnostics: z.array(DiagnosticValidator),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
  links: z.array(OperationLinkValidator).optional()
});

const DraftPackageSummaryValidator = z.object({
  runner: z.string().optional(),
  entry: z.string().optional(),
  fileCount: z.number().optional(),
  importMode: z.string().optional()
});

const DraftSummaryValidator = z.object({
  draftId: z.string(),
  title: z.string().optional(),
  slug: z.string().optional(),
  status: z.string().optional(),
  visibility: z.string().optional(),
  updatedAt: z.union([z.number(), z.string()]).optional(),
  createdAt: z.union([z.number(), z.string()]).optional(),
  publishedUrl: z.string().optional(),
  packageSummary: DraftPackageSummaryValidator.optional()
});

const LiveVibeStatsValidator = z.object({
  runs: z.number(),
  likes: z.number(),
  comments: z.number(),
  remixes: z.number(),
  views: z.number().optional(),
  embedViews: z.number().optional()
});

const LiveVibePackageValidator = z.object({
  runner: z.string().optional(),
  entry: z.string().optional(),
  artifactId: z.string().nullable().optional()
});

const LiveVibeValidator = z.object({
  postId: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  visibility: z.enum(PUBLISH_VISIBILITY_VALUES),
  authorHandle: z.string().optional(),
  authorName: z.string().nullable().optional(),
  coverKey: z.string().nullable().optional(),
  createdAt: z.union([z.number(), z.string()]).optional(),
  updatedAt: z.union([z.number(), z.string()]).optional(),
  playerUrl: z.string(),
  postUrl: z.string(),
  capsuleId: z.string().nullable().optional(),
  stats: LiveVibeStatsValidator,
  packageSummary: LiveVibePackageValidator.optional()
});

const ErrorStructuredValidator = z.object({
  error: z.string(),
  message: z.string().optional(),
  errorId: z.string()
});

const AuthChallengeValidator = z.object({
  authRequired: z.literal(true),
  authUri: z.string(),
  userMessage: z.string()
});

const FeatureDisabledValidator = z.object({
  enabled: z.literal(false),
  sourceType: z.enum(SOURCE_TYPE_VALUES).optional()
});

const ToolOutputValidators: Record<string, z.ZodTypeAny> = {
  get_vibecodr_platform_overview: z.object({
    name: z.string(),
    tagline: z.string(),
    summary: z.string(),
    assistantAnswer: z.string(),
    coreConcepts: z.array(z.object({ name: z.string(), description: z.string() })),
    socialFeatures: z.array(z.string()),
    creationFlow: z.array(z.string()),
    urls: z.object({ home: z.string(), signUp: z.string() })
  }),
  get_guided_publish_requirements: z.object({
    goal: z.string(),
    assistantBehavior: z.array(z.string()),
    failureBehavior: z.array(z.string()),
    requiredQuestions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      whyItMatters: z.string()
    })),
    optionalQuestions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      whyItMatters: z.string()
    })),
    defaultFlow: z.array(z.string()),
    entryConventions: z.object({
      mustBeExplicitWhenKnown: z.boolean(),
      preferredOrder: z.array(z.string()),
      clarificationQuestion: z.string()
    }),
    primaryTools: z.array(z.string()),
    recoveryTools: z.array(z.string())
  }),
  get_upload_capabilities: z.object({
    sourceTypes: z.array(z.enum(SOURCE_TYPE_VALUES)),
    importModes: z.array(z.enum(["direct_files", "zip_import", "github_import"])),
    defaultVisibility: z.literal("public"),
    limits: z.object({ maxFiles: z.number(), maxPayloadChars: z.number() }),
    runners: z.array(z.enum(["client-static", "webcontainer"])),
    recommendedFirstRunFlow: z.literal("quick_publish_creation"),
    entryConventions: z.object({
      preferredOrder: z.array(z.string()),
      mustBeExplicitWhenKnown: z.boolean()
    }),
    publicPrimaryTools: z.array(z.string()),
    recoveryTools: z.array(z.string())
  }),
  get_launch_best_practices: z.object({
    headline: z.string(),
    summary: z.string(),
    premiumLaunchChecklist: z.array(z.string()),
    assistantBehavior: z.array(z.string()),
    coverGuidance: z.object({
      shouldOfferGeneration: z.boolean(),
      whenToOffer: z.string(),
      whyItMatters: z.string(),
      generationSpec: z.object({
        preferredAspectRatio: z.string(),
        preferredSize: z.string(),
        minimumSize: z.string(),
        avoid: z.array(z.string()),
        fileGuidance: z.string()
      })
    }),
    seoGuidance: z.object({
      shouldOfferForPublicLaunch: z.boolean(),
      whyItMatters: z.string(),
      requiresCapabilityCheck: z.boolean()
    }),
    polishMoments: z.array(z.string())
  }),
  get_pulse_setup_guidance: z.object({
    headline: z.string(),
    summary: z.string(),
    whenFrontendOnlyIsEnough: z.array(z.string()),
    whenYouNeedPulses: z.array(z.string()),
    runnerGuidance: z.array(z.string()),
    pulseBestPractices: z.array(z.string()),
    accountReminder: z.string()
  }),
  get_account_capabilities: z.union([
    z.object({
      account: z.object({
        profile: z.object({
          id: z.string(),
          handle: z.string(),
          name: z.string().nullable().optional(),
          avatarUrl: z.string().nullable().optional(),
          bio: z.string().nullable().optional(),
          plan: z.string().optional()
        }).passthrough(),
        quota: z.object({}).passthrough(),
        launchDefaults: z.object({
          visibility: z.literal("public"),
          shouldOfferCoverGeneration: z.boolean(),
          shouldOfferCustomSeo: z.boolean(),
          shouldOfferPulseGuidance: z.boolean()
        }),
        features: z.object({
          customSeo: z.boolean(),
          canUsePrivateOrUnlisted: z.boolean(),
          pulsesEnabled: z.boolean(),
          serverActionsEnabled: z.boolean(),
          webhookActionsEnabled: z.boolean()
        }),
        remaining: z.object({
          pulseSlots: z.number(),
          pulseRunsThisMonth: z.union([z.number(), z.literal("unlimited")]),
          webhookCalls: z.number(),
          privateVibes: z.union([z.number(), z.literal("unlimited")]).optional(),
          privatePulses: z.union([z.number(), z.literal("unlimited")]).optional()
        }),
        recommendations: z.array(z.string())
      })
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  list_import_operations: z.union([z.object({ operations: z.array(OperationValidator) }), AuthChallengeValidator]),
  get_import_operation: z.union([
    z.object({ found: z.literal(false) }),
    z.object({ found: z.literal(true), operation: OperationValidator }),
    AuthChallengeValidator
  ]),
  watch_operation: z.union([
    z.object({
      operation: OperationValidator,
      reachedTarget: z.boolean(),
      timedOut: z.boolean(),
      elapsedMs: z.number(),
      pollCount: z.number(),
      targetStatuses: z.array(z.enum(ALLOWED_OPERATION_STATUSES))
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  get_publish_readiness: z.union([
    z.object({
      readyToPublish: z.boolean(),
      operation: PublicOperationValidator,
      checks: z.array(
        z.object({
          id: z.string(),
          level: z.enum(["pass", "warning", "blocking"]),
          message: z.string()
        })
      ),
      recommendedActions: z.array(z.string())
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  explain_operation_failure: z.union([
    z.object({
      status: z.enum(ALLOWED_OPERATION_STATUSES),
      failed: z.boolean(),
      rootCauseCode: z.string().optional(),
      rootCauseMessage: z.string().optional(),
      retryable: z.boolean(),
      userMessage: z.string(),
      nextActions: z.array(z.string()),
      latestDiagnostics: z.array(
        z.object({
          at: z.number(),
          stage: z.string(),
          code: z.string(),
          message: z.string(),
          retryable: z.boolean().optional()
        })
      )
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  list_vibecodr_drafts: z.union([z.object({ drafts: z.array(DraftSummaryValidator) }), AuthChallengeValidator]),
  get_vibecodr_draft: z.union([z.object({ draft: DraftSummaryValidator }), ErrorStructuredValidator, AuthChallengeValidator]),
  list_my_live_vibes: z.union([
    z.object({
      profile: z.object({
        id: z.string(),
        handle: z.string(),
        name: z.string().nullable().optional(),
        avatarUrl: z.string().nullable().optional(),
        bio: z.string().nullable().optional(),
        plan: z.string().optional()
      }),
      vibes: z.array(LiveVibeValidator)
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  get_live_vibe: z.union([z.object({ vibe: LiveVibeValidator }), ErrorStructuredValidator, AuthChallengeValidator]),
  get_vibe_engagement_summary: z.union([
    z.object({
      engagement: z.object({
        postId: z.string(),
        title: z.string(),
        visibility: z.enum(PUBLISH_VISIBILITY_VALUES),
        playerUrl: z.string(),
        postUrl: z.string(),
        stats: LiveVibeStatsValidator,
        summary: z.string()
      })
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  get_vibe_share_link: z.union([
    z.object({
      share: z.object({
        postId: z.string(),
        title: z.string(),
        visibility: z.enum(PUBLISH_VISIBILITY_VALUES),
        postUrl: z.string(),
        playerUrl: z.string(),
        shareCta: z.string()
      })
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  update_live_vibe_metadata: z.union([z.object({ vibe: LiveVibeValidator }), ErrorStructuredValidator, AuthChallengeValidator]),
  start_creation_import: z.union([
    z.object({ operation: PublicOperationValidator }),
    FeatureDisabledValidator,
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  compile_draft_capsule: z.union([z.object({ operation: OperationValidator }), AuthChallengeValidator]),
  quick_publish_creation: z.union([
    z.object({
      operation: PublicOperationValidator,
      published: z.boolean(),
      timedOut: z.boolean(),
      steps: z.array(
        z.object({
          step: z.enum(["import", "wait_for_draft", "compile", "publish"]),
          status: z.enum(["completed", "skipped", "failed", "timed_out"]),
          message: z.string(),
          at: z.number()
        })
      ),
      recommendedActions: z.array(z.string()),
      vibe: LiveVibeValidator.optional(),
      share: z.object({
        postId: z.string(),
        title: z.string(),
        visibility: z.enum(PUBLISH_VISIBILITY_VALUES),
        postUrl: z.string(),
        playerUrl: z.string(),
        shareCta: z.string()
      }).optional()
    }),
    FeatureDisabledValidator,
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  publish_draft_capsule: z.union([
    z.object({ operation: OperationValidator, vibe: LiveVibeValidator.optional() }),
    FeatureDisabledValidator,
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  cancel_import_operation: z.union([z.object({ operation: OperationValidator }), AuthChallengeValidator]),
  unknown_tool: ErrorStructuredValidator
};

function withValidatedStructuredContent(toolName: string, result: ToolResult): ToolResult {
  if (result.structuredContent === undefined) return result;
  const validator = ToolOutputValidators[toolName] || ToolOutputValidators["unknown_tool"];
  const parsed = validator.safeParse(result.structuredContent);
  if (parsed.success) {
    return { ...result, structuredContent: parsed.data };
  }
  return {
    content: [{ type: "text", text: "Tool response failed internal output validation." }],
    structuredContent: buildErrorStructured(
      "TOOL_OUTPUT_SCHEMA_ERROR",
      parsed.error.issues.map((issue) => issue.message).join("; ")
    )
  };
}

export function getTools(options?: { includeOutputSchema?: boolean; supportsUi?: boolean }): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [
    {
      name: "get_vibecodr_platform_overview",
      title: "Get Vibecodr Platform Overview",
      description:
        "Use this when the user asks what Vibecodr is, how it works as a social platform, what makes a vibe different from a normal app, or what people can do after publishing.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_vibecodr_platform_overview"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_guided_publish_requirements",
      title: "Get Guided Publish Requirements",
      description:
        "Use this before leading a user through publishing when you need to know what questions to ask, what to default for them, and how to keep the flow guided instead of pushing work back onto the user. Treat final publish as a confirmed write step, then close with a premium launch summary instead of a generic success line.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_guided_publish_requirements"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_upload_capabilities",
      title: "Get Upload Capabilities",
      description:
        "Use this when the user explicitly asks what import modes, runners, or limits Vibecodr supports. Do not use it as the default publish step; prefer quick_publish_creation for the normal guided flow. Public is the default visibility unless the user asks for unlisted or private.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_upload_capabilities"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_launch_best_practices",
      title: "Get Launch Best Practices",
      description:
        "Use this when the conversation needs a premium launch checklist. It should tell the model when to proactively offer a cover image, when to offer SEO polish, and how to keep a public vibe launch intentional instead of bare-minimum.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_launch_best_practices"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_pulse_setup_guidance",
      title: "Get Pulse Setup Guidance",
      description:
        "Use this when the app may need backend logic, server actions, secrets, scheduled work, or webhook-style behavior. It should help the model decide when frontend-only is enough and when Vibecodr pulses are the right architecture.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_pulse_setup_guidance"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_account_capabilities",
      title: "Get Account Capabilities",
      description:
        "Use this after the user is connected and before promising premium polish or backend features. It should tell the model what the current Vibecodr account can actually do, including public-vs-private visibility, custom SEO, and pulse/server-action capacity.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_account_capabilities"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "list_import_operations",
      title: "List Import Operations",
      description: "Advanced recovery only. Use this only when the guided publish flow already failed or the user explicitly asks to inspect recent operations.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["list_import_operations"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_import_operation",
      title: "Get Import Operation",
      description: "Advanced recovery only. Use this only when the guided publish flow already has an operation id that needs deeper inspection.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", required: ["operationId"], properties: { operationId: { type: "string" } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_import_operation"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "watch_operation",
      title: "Watch Operation",
      description: "Advanced recovery only. Use this after a draft or publish run already exists and the conversation specifically needs monitored status updates.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["operationId"],
        properties: {
          operationId: { type: "string" },
          timeoutSeconds: { type: "number", minimum: 5, maximum: 600 },
          pollIntervalMs: { type: "integer", minimum: 250, maximum: 10000 },
          targetStatuses: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "received",
                "validating",
                "normalized",
                "ingesting",
                "waiting_on_import_job",
                "draft_ready",
                "compile_running",
                "compile_failed",
                "publish_running",
                "published",
                "published_with_warnings",
                "failed",
                "canceled"
              ]
            }
          }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["watch_operation"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_publish_readiness",
      title: "Get Publish Readiness",
      description: "Use this as the default readiness check before reaching for operation internals. It should answer whether anything still blocks launch and what the next user-facing step is.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["operationId"],
        properties: {
          operationId: { type: "string" },
          capsuleId: { type: "string" }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_publish_readiness"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "explain_operation_failure",
      title: "Explain Operation Failure",
      description: "Use this only after the guided publish flow fails and the user needs a plain-language explanation plus a single concrete recovery step.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["operationId"],
        properties: {
          operationId: { type: "string" }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["explain_operation_failure"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "list_vibecodr_drafts",
      title: "List Vibecodr Drafts",
      description: "Use this when the user explicitly wants to browse existing drafts. Otherwise prefer quick_publish_creation or get_vibecodr_draft for the current publish decision.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["list_vibecodr_drafts"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_vibecodr_draft",
      title: "Get Vibecodr Draft",
      description: "Use this when you need a safe summary of one draft from Vibecodr for the next publishing decision.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", required: ["draftId"], properties: { draftId: { type: "string" } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_vibecodr_draft"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "list_my_live_vibes",
      title: "List My Live Vibes",
      description: "Use this when the user wants to inspect what is already live on Vibecodr, continue from a recent publish, or manage an existing vibe instead of creating a brand-new one.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 },
          offset: { type: "integer", minimum: 0, maximum: 200 }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["list_my_live_vibes"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_live_vibe",
      title: "Get Live Vibe",
      description: "Use this when the conversation is about one already-published vibe and the model needs its live state, share links, or package summary.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_live_vibe"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_vibe_engagement_summary",
      title: "Get Vibe Engagement Summary",
      description: "Use this when the user wants to know how a published vibe is performing or what people can do with it now that it is live.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_vibe_engagement_summary"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "get_vibe_share_link",
      title: "Get Vibe Share Link",
      description: "Use this when the user wants the best link to share a live vibe or wants to understand how the vibe will open for other people.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_vibe_share_link"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "update_live_vibe_metadata",
      title: "Update Live Vibe Metadata",
      description: "Use this when the user wants to refine a live vibe after publish, such as changing visibility, replacing the thumbnail, or updating SEO metadata. Prefer thumbnailFile with an OpenAI-hosted file reference from the ChatGPT widget upload APIs. Use thumbnailUpload only as a fallback when no hosted file reference is available, and keep the raw file under 900 KB so the inline MCP payload stays reliable.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: {
          postId: { type: "string" },
          visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
          coverKey: { type: "string" },
          thumbnailFile: THUMBNAIL_FILE_INPUT_SCHEMA,
          thumbnailUpload: THUMBNAIL_UPLOAD_INPUT_SCHEMA,
          seo: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              imageKey: { type: "string" },
              og: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              },
              twitter: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["update_live_vibe_metadata"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES, false)
    },
    {
      name: "start_creation_import",
      title: "Start Creation Import",
      description:
        "Use this only when the user explicitly wants a draft-first flow or quick publish is not appropriate. Gather the minimum missing details, set payload.entry explicitly whenever the runnable file is obvious, infer entry/title when needed, and only ask one precise follow-up if the package still lacks a runnable entry. Do not turn a draft-first step into an implicit publish. " + CREATION_PAYLOAD_REQUIREMENTS_TEXT,
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["sourceType"],
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          payload: CREATION_PAYLOAD_INPUT_SCHEMA
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["start_creation_import"],
      _meta: {
        ...toolMetaBase(OAUTH_SECURITY_SCHEMES),
        ui: { resourceUri: "ui://widget/publisher-v1", visibility: ["model", "app"] },
        "openai/outputTemplate": "ui://widget/publisher-v1",
        "openai/toolInvocation/invoking": "Importing creation",
        "openai/toolInvocation/invoked": "Import operation updated"
      }
    },
    {
      name: "compile_draft_capsule",
      title: "Compile Draft Capsule",
      description: "Advanced recovery only. Use this when a manual compile retry is needed after a draft already exists and the guided publish flow cannot continue cleanly on its own.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        required: ["operationId", "capsuleId"],
        properties: { operationId: { type: "string" }, capsuleId: { type: "string" } }
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["compile_draft_capsule"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "quick_publish_creation",
      title: "Quick Publish Creation",
      description:
        "Use this for the default guided path after the user has clearly confirmed they want to publish: import a generated creation, include payload.entry explicitly whenever the runnable file is obvious, infer it when needed, wait for draft readiness, compile it, and publish it as a live vibe people can run, remix, comment on, like, and share by URL. Public is the default visibility unless the user explicitly asks for unlisted or private. Prefer thumbnailFile with an OpenAI-hosted file reference from the ChatGPT widget upload APIs when attaching launch art; use thumbnailUpload only as a fallback, and keep the raw file under 900 KB when you must inline it. Ask only the missing launch questions, ask for explicit publish confirmation before invoking this tool, and if entry inference fails ask one exact question about which file starts the app. Once it succeeds, pivot immediately to shareability and the best next move. " + CREATION_PAYLOAD_REQUIREMENTS_TEXT,
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["sourceType", "payload"],
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          payload: CREATION_PAYLOAD_INPUT_SCHEMA,
          autoCompile: { type: "boolean" },
          timeoutSeconds: { type: "number", minimum: 5, maximum: 600 },
          pollIntervalMs: { type: "integer", minimum: 250, maximum: 10000 },
          visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
          coverKey: { type: "string" },
          thumbnailFile: THUMBNAIL_FILE_INPUT_SCHEMA,
          thumbnailUpload: THUMBNAIL_UPLOAD_INPUT_SCHEMA,
          seo: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              imageKey: { type: "string" },
              og: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              },
              twitter: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["quick_publish_creation"],
      _meta: {
        ...toolMetaBase(OAUTH_SECURITY_SCHEMES),
        ui: { resourceUri: "ui://widget/publisher-v1", visibility: ["model", "app"] },
        "openai/outputTemplate": "ui://widget/publisher-v1",
        "openai/toolInvocation/invoking": "Importing and publishing creation",
        "openai/toolInvocation/invoked": "Quick publish flow completed"
      }
    },
    {
      name: "publish_draft_capsule",
      title: "Publish Draft Capsule",
      description:
        "Advanced recovery only. Use this when a draft is already staged and the conversation deliberately needs a manual publish step after the default quick-publish path has been bypassed or failed. Prefer thumbnailFile with an OpenAI-hosted file reference from the ChatGPT widget upload APIs when attaching launch art; use thumbnailUpload only as a fallback, and keep the raw file under 900 KB when you must inline it. Ask for explicit publish confirmation before invoking it.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        required: ["operationId", "capsuleId"],
        properties: {
          operationId: { type: "string" },
          capsuleId: { type: "string" },
          visibility: { type: "string", enum: PUBLISH_VISIBILITY_VALUES },
          coverKey: { type: "string" },
          thumbnailFile: THUMBNAIL_FILE_INPUT_SCHEMA,
          thumbnailUpload: THUMBNAIL_UPLOAD_INPUT_SCHEMA,
          seo: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              imageKey: { type: "string" },
              og: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              },
              twitter: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  imageKey: { type: "string" }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["publish_draft_capsule"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "cancel_import_operation",
      title: "Cancel Import Operation",
      description: "Advanced recovery only. Use this when the user explicitly wants to stop an in-progress operation.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", required: ["operationId"], properties: { operationId: { type: "string" } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["cancel_import_operation"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    }
  ];

  const presented = tools.map((tool) => sanitizeToolDescriptorForPresentation(tool, options));
  return options?.includeOutputSchema ? presented : presented.map(stripOutputSchemaFromDescriptor);
}

async function callToolImpl(
  req: Request,
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  sessionOverride?: SessionRecord | null
): Promise<ToolResult> {
  const traceId = req.headers.get("x-trace-id") || undefined;

  if (name === "get_upload_capabilities") {
    return {
      content: [{ type: "text", text: "Upload capability profile retrieved." }],
      structuredContent: {
        sourceTypes: [
          deps.featureFlags.enableCodexImportPath ? "codex_v1" : null,
          deps.featureFlags.enableChatGptImportPath ? "chatgpt_v1" : null
        ].filter(Boolean),
        importModes: ["direct_files", "zip_import", "github_import"],
        defaultVisibility: "public",
        limits: { maxFiles: 500, maxPayloadChars: 15000000 },
        runners: ["client-static", "webcontainer"],
        recommendedFirstRunFlow: "quick_publish_creation",
        entryConventions: {
          preferredOrder: ["src/main.tsx", "src/index.tsx", "main.tsx", "index.tsx", "index.html"],
          mustBeExplicitWhenKnown: true
        },
        publicPrimaryTools: [
          "get_vibecodr_platform_overview",
          "get_guided_publish_requirements",
          "get_launch_best_practices",
          "get_pulse_setup_guidance",
          "quick_publish_creation",
          "get_publish_readiness",
          "get_vibecodr_draft",
          "list_my_live_vibes",
          "get_live_vibe",
          "get_vibe_engagement_summary",
          "get_vibe_share_link"
        ],
        recoveryTools: [
          "watch_operation",
          "get_import_operation",
          "list_import_operations",
          "compile_draft_capsule",
          "publish_draft_capsule",
          "explain_operation_failure",
          "cancel_import_operation"
        ]
      }
    };
  }

  if (name === "get_launch_best_practices") {
    return {
      content: [{
        type: "text",
        text:
          "A premium Vibecodr launch should proactively cover the art direction, the share preview, and the social outcome instead of stopping at publish succeeded."
      }],
      structuredContent: {
        headline: "Launch like a product, not a file upload.",
        summary:
          "For a public vibe, the model should default to a polished launch: strong title, an optional generated cover image, clean description, and SEO/social preview text when the account allows it.",
        premiumLaunchChecklist: [
          "Confirm the vibe title and runnable entry.",
          "Default visibility to public unless the user explicitly wants otherwise.",
          "If no cover image exists, offer to generate one before publish or immediately after publish.",
          "When generating cover art, default to a wide image that reads well in feed cards and shared previews instead of a tiny square thumbnail.",
          "If the user provides an image inside ChatGPT, prefer the hosted file reference path instead of inlining the file as base64.",
          "If custom SEO is available, offer a title, description, and social preview pass for public launches.",
          "After launch, surface the live link and explain that people can run, remix, comment on, like, and share the vibe."
        ],
        assistantBehavior: [
          "Treat cover image and launch copy as normal polish for a public vibe, not niche extras.",
          "Offer to generate a cover image when the launch has no obvious artwork yet.",
          "If the model is generating launch art, explicitly ask for a large landscape image rather than relying on a tiny default size.",
          "When a user-provided image is available inside ChatGPT, prefer the OpenAI-hosted file reference path and keep base64 only as a fallback for small files under 900 KB.",
          "Offer SEO and social preview polish only after checking account capabilities.",
          "Keep the launch checklist concise and ask only for the missing decisions."
        ],
        coverGuidance: {
          shouldOfferGeneration: true,
          whenToOffer: "Offer cover generation once the core app is understood and before the final publish confirmation, or immediately after publish if the user wants to ship first.",
          whyItMatters: "A cover image improves first impression, feed discovery, and shared-link previews.",
          generationSpec: {
            preferredAspectRatio: "Use a wide landscape composition that survives 16:9 and social-preview crops.",
            preferredSize: "Prefer 1536x1024 when the image model supports it. If not, use at least 1200x675 or another similarly large landscape size.",
            minimumSize: "Never generate tiny covers. Stay at or above 1024x576 for launch art unless the user explicitly wants a small icon.",
            avoid: [
              "Do not generate 64x64, 128x128, or other favicon-sized images for a vibe cover.",
              "Do not default to a square image unless the user explicitly wants square artwork.",
              "Do not put critical text or logos hard against the edges where social crops can cut them off."
            ],
            fileGuidance: "Keep the final upload under 5 MB and prefer PNG, JPEG, WebP, or AVIF. If you must inline the image as base64, keep the raw file under 900 KB."
          }
        },
        seoGuidance: {
          shouldOfferForPublicLaunch: true,
          whyItMatters: "SEO polish controls how the vibe looks when it is shared outside Vibecodr and makes the launch feel intentional.",
          requiresCapabilityCheck: true
        },
        polishMoments: [
          "Right before publish confirmation for the cleanest public launch.",
          "Immediately after publish if the user wants to launch first and refine second.",
          "Any time the user asks for a stronger share preview or more discoverable presentation."
        ]
      }
    };
  }

  if (name === "get_pulse_setup_guidance") {
    return {
      content: [{
        type: "text",
        text:
          "Use pulses when the app needs trusted server-side work. Keep frontend-only vibes frontend-only when the logic can safely run on the client."
      }],
      structuredContent: {
        headline: "Choose frontend-only by default, then escalate to pulses when the app truly needs server logic.",
        summary:
          "A zero-context agent should not guess about backend architecture. It should recognize when the app needs secrets, external APIs, scheduled work, or trusted mutations, then use Vibecodr pulses as the backend path.",
        whenFrontendOnlyIsEnough: [
          "The app is purely interactive UI, local state, or deterministic client-side logic.",
          "All required data can be bundled with the app or fetched from public endpoints safely in the browser.",
          "There are no secrets, signed requests, or privileged mutations."
        ],
        whenYouNeedPulses: [
          "The app needs secrets, API keys, signed requests, or privileged server-side access.",
          "The app needs webhooks, scheduled jobs, background tasks, or durable side effects.",
          "The app needs to protect provider credentials or enforce trusted business logic."
        ],
        runnerGuidance: [
          "Use client-static for normal feed apps that only need frontend code.",
          "Use webcontainer when the package needs a richer browser-based runtime or server-like dev tooling on the client side.",
          "Use pulses for true backend/server actions instead of trying to hide secrets in frontend code."
        ],
        pulseBestPractices: [
          "Keep the pulse surface narrow and name exactly what the backend action does.",
          "Pass only the minimum data from the vibe into the pulse.",
          "Check account capabilities before proposing additional pulses or private pulses.",
          "Explain to the user why a pulse is needed in product language, not infrastructure jargon."
        ],
        accountReminder:
          "Before promising pulse-backed behavior, call get_account_capabilities so the model knows the user's plan, pulse slot availability, and whether premium backend features are actually available."
      }
    };
  }

  if (name === "get_vibecodr_platform_overview") {
    return {
      content: [
        {
          type: "text",
          text:
            "Vibecodr is a social platform where code is the content: users publish apps as vibes that run directly on the timeline, can be remixed like forks, liked, commented on, and shared with a URL."
        }
      ],
      structuredContent: {
        name: "Vibecodr.Space",
        tagline: "A social platform where code runs as content.",
        summary:
          "Vibecodr is a social coding network. Users publish apps as vibes, and those vibes run directly in the feed so people can interact with them immediately instead of just looking at screenshots or code snippets.",
        assistantAnswer:
          "Vibecodr is a social platform where AI-made apps become live vibes. They run on the timeline, can be remixed like forks, commented on, liked, and shared with a URL.",
        coreConcepts: [
          {
            name: "Vibes",
            description:
              "Vibes are live posts made of code. A published vibe is runnable on the timeline and can be opened and shared like any other post."
          },
          {
            name: "Remix",
            description:
              "Remixing is Vibecodr's fork model. A user can take an existing vibe, branch from it, modify the code, and publish their own version."
          },
          {
            name: "Pulses",
            description:
              "Pulses add backend behavior so creators can pair timeline apps with server-side logic."
          }
        ],
        socialFeatures: [
          "Run code directly on the timeline",
          "Remix published vibes like forking a project",
          "Comment on vibes",
          "Like vibes",
          "Share vibes with a URL"
        ],
        creationFlow: [
          "Create or generate an app",
          "Import it into Vibecodr",
          "Compile and publish it as a vibe",
          "Share it on the timeline where others can run it, react to it, and remix it"
        ],
        urls: {
          home: "https://vibecodr.space",
          signUp: "https://vibecodr.space/sign-up"
        }
      }
    };
  }

  if (name === "get_guided_publish_requirements") {
    return {
      content: [
        {
          type: "text",
          text:
            "Guide the user in short steps: connect Vibecodr once, confirm only the missing publish details, then execute the publish flow on their behalf."
        }
      ],
      structuredContent: {
        goal: "Turn a generated app into a published Vibecodr vibe with the fewest possible user-side steps.",
        assistantBehavior: [
          "Treat the workflow as guided publishing, not a handoff.",
          "If connection is missing, ask the user to connect Vibecodr once in ChatGPT and then continue the same flow.",
          "Do not ask the user to manually reason about import operations, compile stages, or infrastructure unless recovery is required.",
          "Ask only for information that is actually missing from the package or publish request.",
          "Use short, confident product language. Sound like a launch partner, not an API operator.",
          "Before any write action that makes the vibe live, ask for explicit confirmation in plain language, such as 'Should I publish this now?'",
          "Do not invoke quick_publish_creation or publish_draft_capsule until the user has clearly confirmed the publish step.",
          "Default visibility to public unless the user explicitly asks for unlisted or private.",
          "For a public vibe with no obvious artwork, proactively offer to generate or add a cover image.",
          "When proposing generated cover art, specify a large landscape output size and never leave size unspecified.",
          "When the user provides an image inside ChatGPT, prefer the OpenAI-hosted file reference path instead of base64 unless no hosted reference is available.",
          "For a public vibe, offer SEO and social preview polish when account capabilities say custom SEO is available.",
          "Before proposing pulses, private visibility, or other premium features, check account capabilities instead of guessing from the plan name alone.",
          "Once a vibe is published, pivot from deployment language to social outcomes like shareability, remixing, and engagement.",
          "After publish, celebrate briefly, surface the best live link, explain what people can now do with the vibe, and suggest one high-value next step.",
          "Prefer a premium closing sequence: what went live, where it opens, how it can be shared, and whether the user wants polish or engagement follow-up.",
          "If the creation package omits entry or title, infer them from the files before asking the user anything.",
          "When you know the runnable entry file, include payload.entry explicitly instead of relying on server inference.",
          "Prefer src/main.tsx, then src/index.tsx, then main.tsx, then index.tsx, then index.html when those files exist.",
          "Only ask a targeted entry-file question when the package still has no clear runnable entry after inference.",
          "Default to quick publish when the package is already present and the user has not requested a slower step-by-step flow.",
          "Prefer get_publish_readiness over operation-inspection tools when checking whether launch can continue.",
          "Do not call watch_operation, compile_draft_capsule, publish_draft_capsule, or list_import_operations during a normal first-run flow unless the publish path has already failed."
        ],
        failureBehavior: [
          "When something fails, explain the blocker in plain language before mentioning any internal status or identifier.",
          "Name one concrete next step the user or model should take; do not dump a menu of recovery tooling.",
          "Do not lead with words like operation, capsule, compile_failed, or upstream API error unless the user explicitly asks for internals.",
          "Keep the model in charge of the recovery flow and ask at most one focused follow-up question when a detail is genuinely missing.",
          "Even in failure, keep the tone intentional and premium: explain what happened, what it means, and the best next move."
        ],
        requiredQuestions: [
          {
            id: "creation_payload",
            question: "Which generated app or package should be published?",
            whyItMatters: "Publishing cannot begin without the creation payload or a referenced draft."
          }
        ],
        optionalQuestions: [
          {
            id: "visibility",
            question: "Do you want something other than the default public visibility?",
            whyItMatters: "Public is the default launch path. Ask only when the user wants unlisted or private instead."
          },
          {
            id: "thumbnail",
            question: "Do you want me to generate or add a cover image for the vibe?",
            whyItMatters: "A cover image is part of a premium public launch and improves first impression plus shared-link previews."
          },
          {
            id: "seo",
            question: "Do you want custom SEO and social preview text for the launch?",
            whyItMatters: "SEO metadata controls how the vibe appears when shared outside Vibecodr and should be offered proactively when the account allows it."
          }
        ],
        defaultFlow: [
          "Confirm the creation package or draft to publish.",
          "Prompt for connection only if the user is not already authenticated.",
          "After the user is connected, check account capabilities before promising premium polish, private visibility, or pulse-backed behavior.",
          "Set payload.entry explicitly when the package already makes the runnable entry obvious.",
          "Default visibility to public unless the user asks for unlisted or private.",
          "For a public launch, proactively offer a cover image if one is missing.",
          "For a public launch, proactively offer SEO and social preview polish if account capabilities say custom SEO is available.",
          "If the app needs secrets, scheduled work, webhooks, or trusted server-side mutations, use pulse setup guidance before promising backend behavior.",
          "Ask for explicit publish confirmation before invoking the final publish action.",
          "Run quick publish by default.",
          "Return the published result with the live vibe URL and a short explanation of what users can now do with it on Vibecodr.",
          "After a successful publish, offer one premium follow-up path: share the live vibe, refine launch polish, or inspect engagement.",
          "If the user wants to continue from something already live, list recent live vibes and inspect the chosen one instead of restarting the flow."
        ],
        entryConventions: {
          mustBeExplicitWhenKnown: true,
          preferredOrder: ["src/main.tsx", "src/index.tsx", "main.tsx", "index.tsx", "index.html"],
          clarificationQuestion: "Which file starts the app?"
        },
        primaryTools: [
          "get_vibecodr_platform_overview",
          "get_guided_publish_requirements",
          "get_launch_best_practices",
          "get_pulse_setup_guidance",
          "get_account_capabilities",
          "quick_publish_creation",
          "get_publish_readiness",
          "get_vibecodr_draft",
          "list_my_live_vibes",
          "get_live_vibe",
          "get_vibe_engagement_summary",
          "get_vibe_share_link"
        ],
        recoveryTools: [
          "watch_operation",
          "get_import_operation",
          "list_import_operations",
          "compile_draft_capsule",
          "publish_draft_capsule",
          "explain_operation_failure",
          "cancel_import_operation"
        ]
      }
    };
  }

  const session = sessionOverride === undefined
    ? await getSessionForToolRequest(req, deps, traceId)
    : sessionOverride;

  if (!session) {
    deps.telemetry.auth({
      traceId,
      event: "tool_auth_challenge",
      outcome: "challenge",
      provider: "vibecodr",
      endpoint: "/mcp",
      details: { toolName: name }
    });
    return unauthorizedToolResult(deps.appBaseUrl);
  }

  if (name === "get_account_capabilities") {
    try {
      const account = await deps.vibecodr.getAccountCapabilities(
        { userId: session.userId, userHandle: session.userHandle, vibecodrToken: session.vibecodrToken },
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      return {
        content: [{
          type: "text",
          text:
            `The current Vibecodr account is on ${account.profile.plan || account.quota.plan}. Public launch is the default, ${account.features.customSeo ? "custom SEO is available" : "custom SEO is not available on this plan"}, and ${account.remaining.pulseSlots} pulse slot${account.remaining.pulseSlots === 1 ? "" : "s"} remain.`
        }],
        structuredContent: { account }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_account_capabilities failed: " + message, "GET_ACCOUNT_CAPABILITIES_FAILED", message);
    }
  }

  if (name === "list_import_operations") {
    const limit = typeof args["limit"] === "number" ? args["limit"] : 25;
    const operations = await deps.operationStore.listByUser(session.userId, limit);
    const refreshed = await deps.importService.refreshPendingOperations(session, operations);
    return {
      content: [{ type: "text", text: "Retrieved " + refreshed.length + " recent Vibecodr launch attempts." }],
      structuredContent: { operations: refreshed.map(summarizeOperation) }
    };
  }

  if (name === "get_import_operation") {
    const operationId = String(args["operationId"] || "");
    const operation = operationId ? await deps.importService.refreshImportJobStatus(session, operationId, { traceId, endpoint: "/mcp" }) : undefined;
    if (!operation || operation.userId !== session.userId) {
      return { content: [{ type: "text", text: "Operation not found." }], structuredContent: { found: false } };
    }
    const latest = operation.diagnostics.at(-1);
    const message = operation.status === "failed" || operation.status === "compile_failed"
      ? translateFailure(latest?.code, operation.status, latest?.details).userMessage
      : humanizeOperationStatus(operation.status);
    return {
      content: [{ type: "text", text: message }],
      structuredContent: { found: true, operation: summarizeOperation(operation) }
    };
  }

  if (name === "watch_operation") {
    try {
      const operationId = String(args["operationId"] || "");
      if (!operationId) {
        return toolErrorResult("operationId is required.", "MISSING_OPERATION_ID");
      }
      const timeoutSeconds = parseTimeoutSecondsArg(args["timeoutSeconds"]);
      const pollIntervalMs = parsePollIntervalArg(args["pollIntervalMs"]);
      const targetStatuses = parseTargetStatusesArg(args["targetStatuses"]);
      const watch = await deps.importService.watchOperation(session, operationId, {
        timeoutMs: timeoutSeconds * 1000,
        pollIntervalMs,
        targetStatuses
      }, { traceId, endpoint: "/mcp" });
      return {
        content: [{ type: "text", text: watch.timedOut ? "Watch timed out before target status." : "Watch reached target status." }],
        structuredContent: { ...watch, operation: summarizeOperation(watch.operation) }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("watch_operation failed: " + message, "WATCH_OPERATION_FAILED", message);
    }
  }

  if (name === "get_publish_readiness") {
    try {
      const operationId = String(args["operationId"] || "");
      if (!operationId) {
        return toolErrorResult("operationId is required.", "MISSING_OPERATION_ID");
      }
      const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"] : undefined;
      const readiness = await deps.importService.getPublishReadiness(session, operationId, capsuleId, { traceId, endpoint: "/mcp" });
      const latest = readiness.operation.diagnostics.at(-1);
      const message = readiness.readyToPublish
        ? "This draft is ready to publish."
        : readiness.operation.status === "failed" || readiness.operation.status === "compile_failed"
          ? translateFailure(latest?.code, readiness.operation.status, latest?.details).userMessage
          : "This draft is not ready to publish yet.";
      return {
        content: [{ type: "text", text: message }],
        structuredContent: {
          readyToPublish: readiness.readyToPublish,
          operation: summarizePublicOperation(readiness.operation),
          checks: summarizeReadinessChecks(readiness.checks),
          recommendedActions: readiness.recommendedActions
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_publish_readiness failed: " + message, "PUBLISH_READINESS_FAILED", message);
    }
  }

  if (name === "explain_operation_failure") {
    try {
      const operationId = String(args["operationId"] || "");
      if (!operationId) {
        return toolErrorResult("operationId is required.", "MISSING_OPERATION_ID");
      }
      const explanation = await deps.importService.explainOperationFailure(session, operationId, { traceId, endpoint: "/mcp" });
      return {
        content: [{ type: "text", text: explanation.userMessage }],
        structuredContent: {
          status: explanation.status,
          failed: explanation.failed,
          rootCauseCode: explanation.rootCauseCode,
          rootCauseMessage: explanation.rootCauseMessage,
          retryable: explanation.retryable,
          userMessage: explanation.userMessage,
          nextActions: explanation.nextActions,
          latestDiagnostics: explanation.latestDiagnostics
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("explain_operation_failure failed: " + message, "EXPLAIN_FAILURE_FAILED", message);
    }
  }

  if (name === "list_vibecodr_drafts") {
    const drafts = await deps.vibecodr.listDrafts(
      { userId: session.userId, vibecodrToken: session.vibecodrToken },
      { telemetry: deps.telemetry, traceId, userId: session.userId }
    );
    return {
      content: [{ type: "text", text: "Retrieved drafts from Vibecodr." }],
      structuredContent: { drafts: extractDraftArray(drafts).map(summarizeDraft).filter((draft): draft is PublicDraftSummary => Boolean(draft)) }
    };
  }

  if (name === "get_vibecodr_draft") {
    const draftId = String(args["draftId"] || "");
    if (!draftId) {
      return toolErrorResult("draftId is required.", "MISSING_DRAFT_ID");
    }
    const draft = await deps.vibecodr.getDraft(
      { userId: session.userId, vibecodrToken: session.vibecodrToken },
      draftId,
      { telemetry: deps.telemetry, traceId, userId: session.userId }
    );
    const summarizedDraft = summarizeDraft(draft);
    if (!summarizedDraft) {
      return toolErrorResult("Draft response could not be summarized safely.", "INVALID_DRAFT_RESPONSE");
    }
    return { content: [{ type: "text", text: "Retrieved the draft summary from Vibecodr." }], structuredContent: { draft: summarizedDraft } };
  }

  if (name === "list_my_live_vibes") {
    try {
      const limit = typeof args["limit"] === "number" ? Math.min(Math.max(Math.floor(args["limit"]), 1), 20) : 10;
      const offset = typeof args["offset"] === "number" ? Math.max(Math.floor(args["offset"]), 0) : 0;
      const ctx = { userId: session.userId, userHandle: session.userHandle, vibecodrToken: session.vibecodrToken };
      const vibes = await deps.vibecodr.listMyLiveVibes(ctx, { limit, offset }, { telemetry: deps.telemetry, traceId, userId: session.userId });
      const firstVibe = vibes[0];
      const publicHandle = safeSessionHandle(session, firstVibe?.authorHandle);
      const hasExplicitHandle = publicHandle !== "connected-account";
      const profile = {
        id: session.userId,
        handle: publicHandle,
        ...(firstVibe?.authorName !== undefined ? { name: firstVibe.authorName } : {})
      };
      return {
        content: [{
          type: "text",
          text: vibes.length
            ? hasExplicitHandle
              ? `Retrieved ${vibes.length} live vibes from ${profile.handle}'s Vibecodr profile.`
              : `Retrieved ${vibes.length} live vibes from the connected Vibecodr profile.`
            : hasExplicitHandle
              ? `No live vibes are visible on ${profile.handle}'s profile yet.`
              : "No live vibes are visible on the connected Vibecodr profile yet."
        }],
        structuredContent: {
          profile,
          vibes
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("list_my_live_vibes failed: " + message, "LIST_LIVE_VIBES_FAILED", message);
    }
  }

  if (name === "get_live_vibe") {
    try {
      const postId = String(args["postId"] || "");
      if (!postId) {
        return toolErrorResult("postId is required.", "MISSING_POST_ID");
      }
      const vibe = await deps.vibecodr.getLiveVibe(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      return {
        content: [{ type: "text", text: `${vibe.title} is live on Vibecodr.` }],
        structuredContent: { vibe }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_live_vibe failed: " + message, "GET_LIVE_VIBE_FAILED", message);
    }
  }

  if (name === "get_vibe_engagement_summary") {
    try {
      const postId = String(args["postId"] || "");
      if (!postId) {
        return toolErrorResult("postId is required.", "MISSING_POST_ID");
      }
      const engagement = await deps.vibecodr.getVibeEngagementSummary(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      return {
        content: [{ type: "text", text: engagement.summary }],
        structuredContent: { engagement }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_vibe_engagement_summary failed: " + message, "GET_VIBE_ENGAGEMENT_FAILED", message);
    }
  }

  if (name === "get_vibe_share_link") {
    try {
      const postId = String(args["postId"] || "");
      if (!postId) {
        return toolErrorResult("postId is required.", "MISSING_POST_ID");
      }
      const share = await deps.vibecodr.getVibeShareSummary(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      return {
        content: [{ type: "text", text: share.shareCta }],
        structuredContent: { share }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_vibe_share_link failed: " + message, "GET_VIBE_SHARE_FAILED", message);
    }
  }

  if (name === "update_live_vibe_metadata") {
    try {
      const postId = String(args["postId"] || "");
      if (!postId) {
        return toolErrorResult("postId is required.", "MISSING_POST_ID");
      }
      const thumbnailInput = parseThumbnailArgs(args);
      let coverKey = parseCoverKeyArg(args["coverKey"]);
      const requestedVisibility = parseVisibilityArg(args["visibility"]);
      const resolvedThumbnail = await resolveThumbnailInput(thumbnailInput, deps.vibecodrFetch || fetch);
      if (resolvedThumbnail) {
        const targetVisibility = requestedVisibility || (
          await deps.vibecodr.getLiveVibe(
            { userId: session.userId, vibecodrToken: session.vibecodrToken },
            postId,
            { telemetry: deps.telemetry, traceId, userId: session.userId }
          )
        ).visibility;
        const upload = await deps.vibecodr.uploadCover(
          { userId: session.userId, vibecodrToken: session.vibecodrToken },
          {
            contentType: resolvedThumbnail.contentType,
            fileBytes: resolvedThumbnail.fileBytes,
            usage: coverUsageForVisibility(targetVisibility)
          },
          { telemetry: deps.telemetry, traceId, userId: session.userId }
        );
        coverKey = upload.key;
      }
      const vibe = await deps.vibecodr.updateLiveVibeMetadata(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        {
          visibility: requestedVisibility,
          coverKey,
          seo: parseSeoArg(args["seo"])
        },
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      return {
        content: [{ type: "text", text: `${vibe.title} has updated live metadata on Vibecodr.` }],
        structuredContent: { vibe }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("update_live_vibe_metadata failed: " + message, "UPDATE_LIVE_VIBE_FAILED", message);
    }
  }

  if (name === "start_creation_import") {
    try {
      const sourceType = String(args["sourceType"] || "");
      if (sourceType === "codex_v1" && !deps.featureFlags.enableCodexImportPath) {
        return { content: [{ type: "text", text: "Codex import path is disabled." }], structuredContent: { enabled: false, sourceType } };
      }
      if (sourceType === "chatgpt_v1" && !deps.featureFlags.enableChatGptImportPath) {
        return { content: [{ type: "text", text: "ChatGPT import path is disabled." }], structuredContent: { enabled: false, sourceType } };
      }
      const payload = args["payload"] && typeof args["payload"] === "object" ? (args["payload"] as Record<string, unknown>) : {};
      const normalized = sourceType === "codex_v1"
        ? adaptCodexPayload(payload)
        : sourceType === "chatgpt_v1"
          ? adaptChatGptPayload(payload)
          : (() => { throw new Error("Unsupported sourceType"); })();
      const operation = await deps.importService.startImport(session, normalized, { traceId, endpoint: "/mcp" });
      return {
        content: [{ type: "text", text: "Import started. Vibecodr is preparing the draft." }],
        structuredContent: { operation: summarizePublicOperation(operation) },
        _meta: {
          "openai/outputTemplate": "ui://widget/publisher-v1",
          "openai/toolInvocation/invoking": "Importing creation",
          "openai/toolInvocation/invoked": "Import operation updated"
        }
      };
    } catch (error) {
      if (error instanceof PackageResolutionError) {
        return packageResolutionToolResult(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("start_creation_import failed: " + message, "START_IMPORT_FAILED", message);
    }
  }

  if (name === "compile_draft_capsule") {
    const operationId = String(args["operationId"] || "");
    const capsuleId = String(args["capsuleId"] || "");
    const operation = await deps.importService.compileDraft(session, operationId, capsuleId, { traceId, endpoint: "/mcp" });
    return {
      content: [{ type: "text", text: "Compile status: " + operation.status + "." }],
      structuredContent: { operation: summarizeOperation(operation) }
    };
  }

  if (name === "quick_publish_creation") {
    if (!deps.featureFlags.enablePublishFromChatGpt) {
      return { content: [{ type: "text", text: "Publish from ChatGPT is currently disabled." }], structuredContent: { enabled: false } };
    }
    try {
      const sourceType = parseSourceTypeArg(args["sourceType"]);
      if (sourceType === "codex_v1" && !deps.featureFlags.enableCodexImportPath) {
        return { content: [{ type: "text", text: "Codex import path is disabled." }], structuredContent: { enabled: false, sourceType } };
      }
      if (sourceType === "chatgpt_v1" && !deps.featureFlags.enableChatGptImportPath) {
        return { content: [{ type: "text", text: "ChatGPT import path is disabled." }], structuredContent: { enabled: false, sourceType } };
      }
      const payload = args["payload"] && typeof args["payload"] === "object" ? (args["payload"] as Record<string, unknown>) : {};
      const normalized = sourceType === "codex_v1" ? adaptCodexPayload(payload) : adaptChatGptPayload(payload);
      const timeoutSeconds = parseTimeoutSecondsArg(args["timeoutSeconds"]);
      const pollIntervalMs = parsePollIntervalArg(args["pollIntervalMs"]);
      const autoCompile = args["autoCompile"] === undefined
        ? true
        : typeof args["autoCompile"] === "boolean"
          ? args["autoCompile"]
          : (() => { throw new Error("autoCompile must be a boolean."); })();
      const quick = await deps.importService.quickPublishCreation(session, normalized, {
        autoCompile,
        timeoutMs: timeoutSeconds * 1000,
        pollIntervalMs,
        publish: {
          visibility: parseVisibilityWithDefault(args["visibility"]),
          coverKey: parseCoverKeyArg(args["coverKey"]),
          ...parseThumbnailArgs(args),
          seo: parseSeoArg(args["seo"])
        }
      }, { traceId, endpoint: "/mcp" });
      const publishedPostId = quick.published ? extractPublishedPostId(quick.operation) : undefined;
      const vibe = publishedPostId
        ? await deps.vibecodr.getLiveVibe(
            { userId: session.userId, vibecodrToken: session.vibecodrToken },
            publishedPostId,
            { telemetry: deps.telemetry, traceId, userId: session.userId }
          )
        : undefined;
      const share = publishedPostId
        ? await deps.vibecodr.getVibeShareSummary(
            { userId: session.userId, vibecodrToken: session.vibecodrToken },
            publishedPostId,
            { telemetry: deps.telemetry, traceId, userId: session.userId }
          )
        : undefined;
      const publishOutcome = summarizePublishOutcome(quick.operation);
      return {
        content: [{ type: "text", text: publishOutcome.message }],
        structuredContent: {
          published: quick.published,
          timedOut: quick.timedOut,
          operation: summarizePublicOperation(quick.operation),
          steps: summarizeQuickPublishSteps(quick.steps),
          recommendedActions: quick.recommendedActions,
          warnings: publishOutcome.warnings,
          ...(vibe ? { vibe } : {}),
          ...(share ? { share } : {})
        },
        _meta: {
          "openai/outputTemplate": "ui://widget/publisher-v1",
          "openai/toolInvocation/invoking": "Importing and publishing creation",
          "openai/toolInvocation/invoked": "Quick publish flow completed"
        }
      };
    } catch (error) {
      if (error instanceof PackageResolutionError) {
        return packageResolutionToolResult(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("quick_publish_creation failed: " + message, "QUICK_PUBLISH_FAILED", message);
    }
  }

  if (name === "publish_draft_capsule") {
    if (!deps.featureFlags.enablePublishFromChatGpt) {
      return { content: [{ type: "text", text: "Publish from ChatGPT is currently disabled." }], structuredContent: { enabled: false } };
    }
    const operationId = String(args["operationId"] || "");
    const capsuleId = String(args["capsuleId"] || "");
    let operation;
    try {
      operation = await deps.importService.publishDraft(session, operationId, capsuleId, {
        visibility: parseVisibilityWithDefault(args["visibility"]),
        coverKey: parseCoverKeyArg(args["coverKey"]),
        ...parseThumbnailArgs(args),
        seo: parseSeoArg(args["seo"])
      }, { traceId, endpoint: "/mcp" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("Publish failed validation: " + message, "INVALID_PUBLISH_INPUT", message);
    }
    const publishedPostId =
      operation.status === "published" || operation.status === "published_with_warnings"
        ? extractPublishedPostId(operation)
        : undefined;
    const vibe = publishedPostId
      ? await deps.vibecodr.getLiveVibe(
          { userId: session.userId, vibecodrToken: session.vibecodrToken },
          publishedPostId,
          { telemetry: deps.telemetry, traceId, userId: session.userId }
        )
      : undefined;
    const publishOutcome = summarizePublishOutcome(operation);
    return {
      content: [{ type: "text", text: publishOutcome.message }],
      structuredContent: {
        operation: summarizeOperation(operation),
        warnings: publishOutcome.warnings,
        ...(vibe ? { vibe } : {})
      }
    };
  }

  if (name === "cancel_import_operation") {
    const operationId = String(args["operationId"] || "");
    const operation = await deps.importService.cancelImport(session, operationId, { traceId, endpoint: "/mcp" });
    return {
      content: [{ type: "text", text: "Operation canceled: " + operation.operationId + "." }],
      structuredContent: { operation: summarizeOperation(operation) }
    };
  }

  return toolErrorResult("Unknown tool: " + name, "UNKNOWN_TOOL");
}

export async function callTool(
  req: Request,
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  sessionOverride?: SessionRecord | null,
  presentation?: ToolPresentationOptions
): Promise<ToolResult> {
  const result = withValidatedStructuredContent(name, await callToolImpl(req, deps, name, args, sessionOverride));
  const widgetWrapped = WIDGET_ENABLED_TOOLS.has(name) ? withWidgetTemplateMeta(result) : result;
  return sanitizeToolResultForPresentation(widgetWrapped, presentation);
}

