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
import type { SessionRevocationStore } from "../auth/sessionRevocationStore.js";
import type { VibecodrClient } from "../vibecodr/client.js";
import type { Telemetry } from "../observability/telemetry.js";
import type { CodeModeRuntimePolicy } from "./codeModeRuntime.js";
import { buildPulseSetupGuidance } from "./pulseDescriptorMetadata.js";
import type {
  ImportOperation,
  LiveVibeSummary,
  NormalizedCreationPackage,
  OperationStatus,
  PublishThumbnailFile,
  PublishSeoInput,
  PublishThumbnailUpload,
  SourceType,
  PublishVisibility,
  SessionRecord,
  VibeEngagementSummary
} from "../types.js";

export type ToolDeps = {
  importService: ImportService;
  operationStore: OperationStorePort;
  sessionStore: SessionStore;
  sessionRevocationStore?: SessionRevocationStore | undefined;
  vibecodr: VibecodrClient;
  telemetry: Telemetry;
  appBaseUrl: string;
  vibecodrApiBase: string;
  vibecodrFetch?: typeof fetch | undefined;
  featureFlags: {
    enableCodexImportPath: boolean;
    enableChatGptImportPath: boolean;
    enablePublishFromChatGpt: boolean;
  };
  codeMode?: CodeModeRuntimePolicy | undefined;
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  _meta?: Record<string, unknown> | undefined;
};

export type ToolDescriptor = {
  name: string;
  title: string;
  description: string;
  securitySchemes: Array<{ type: string; scopes?: string[] }>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean | undefined;
  };
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown> | undefined;
};

type ToolVisibility = "public" | "internal" | "recovery";
type RegisteredToolDescriptor = ToolDescriptor & { visibility: ToolVisibility };

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

const GITHUB_REPOSITORY_URL_PATTERN =
  "^https://(?:www\\.)?github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?/?$";

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
        url: {
          type: "string",
          format: "uri",
          pattern: GITHUB_REPOSITORY_URL_PATTERN,
          description:
            "HTTPS github.com repository URL only, for example https://github.com/owner/repo or https://github.com/owner/repo.git. Do not include branch/tree paths, query strings, fragments, credentials, ports, or raw/file URLs."
        },
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
  "Payload format: use payload.importMode to choose the lane. For direct_files, provide payload.files with { path, content, contentEncoding? }. For github_import, provide payload.github.url as an HTTPS github.com/<owner>/<repo>[.git] repository URL only; do not include branch/tree paths, query strings, fragments, credentials, ports, raw URLs, or file URLs. For zip_import, provide payload.zip.fileName and payload.zip.fileBase64. Optional payload fields are title, runner, entry, sourceReference, metadata, and idempotencyKey. Do not invent wrapper keys outside this shape.";

const CONFIRMED_WRITE_INPUT_SCHEMA = {
  type: "boolean",
  const: true,
  description: "Must be true only after the user explicitly confirms this write action in the conversation."
} as const;

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

function toolMetaBase(securitySchemes: Array<{ type: string; scopes?: string[] }>): Record<string, unknown> {
  return { securitySchemes };
}

function confirmationRequiredResult(toolName: string, action: string): ToolResult {
  return toolErrorResult(
    `Explicit user confirmation is required before ${action}. Call ${toolName} again only after passing confirmed: true.`,
    "CONFIRMATION_REQUIRED",
    `This write is blocked until the user explicitly confirms it. Pass confirmed: true after that confirmation.`,
    {
      confirmationRequired: true,
      requiredArgument: "confirmed",
      toolName,
      action,
      userMessage: `Confirm before ${action}.`
    }
  );
}

function requireConfirmedWrite(toolName: string, action: string, args: Record<string, unknown>): ToolResult | undefined {
  return args["confirmed"] === true ? undefined : confirmationRequiredResult(toolName, action);
}

function stripOutputSchemaFromDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const { outputSchema: _outputSchema, ...rest } = descriptor;
  return rest;
}

function stripInternalToolFields(descriptor: RegisteredToolDescriptor): ToolDescriptor {
  const { visibility: _visibility, ...tool } = descriptor;
  return tool;
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
        "Connection required before publish actions can write to the user's Vibecodr account. Start the Vibecodr MCP OAuth flow in your MCP client, then continue the same guided publish flow. CLI auth and editor auth are separate."
    }],
    structuredContent: {
      authRequired: true,
      authUri: authServerUri,
      resourceMetadataUri,
      requiredScopes,
      userMessage: "Connect Vibecodr MCP auth to continue the publish flow. CLI auth and editor auth are separate."
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
} & Record<string, unknown>;

function buildErrorStructured(
  error: string,
  message?: string,
  extra?: Record<string, unknown>
): ErrorStructuredContent {
  return { error, ...(message ? { message } : {}), ...(extra || {}), errorId: randomUUID() };
}

function toolErrorResult(
  text: string,
  error: string,
  message?: string,
  extra?: Record<string, unknown>
): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: buildErrorStructured(error, message, extra)
  };
}

function packageResolutionToolResult(error: PackageResolutionError): ToolResult {
  const candidates = Array.isArray(error.details?.["candidateEntries"])
    ? (error.details?.["candidateEntries"] as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const suffix = candidates.length > 0 ? " Candidates: " + candidates.join(", ") + "." : "";
  return toolErrorResult(error.message + suffix, error.code, error.message);
}

function normalizeCreationPayloadForTool(args: Record<string, unknown>, deps: ToolDeps): {
  sourceType: SourceType;
  normalized?: NormalizedCreationPackage;
  disabledReason?: string;
} {
  const sourceType = parseSourceTypeArg(args["sourceType"]);
  if (sourceType === "codex_v1" && !deps.featureFlags.enableCodexImportPath) {
    return { sourceType, disabledReason: "Codex import path is disabled." };
  }
  if (sourceType === "chatgpt_v1" && !deps.featureFlags.enableChatGptImportPath) {
    return { sourceType, disabledReason: "ChatGPT import path is disabled." };
  }
  const payload = args["payload"] && typeof args["payload"] === "object" && !Array.isArray(args["payload"])
    ? args["payload"] as Record<string, unknown>
    : {};
  return {
    sourceType,
    normalized: sourceType === "codex_v1" ? adaptCodexPayload(payload) : adaptChatGptPayload(payload)
  };
}

function inferPackageShape(pkg: NormalizedCreationPackage): string {
  if (pkg.importMode !== "direct_files") return "external_import";
  const paths = pkg.files.map((file) => file.path.toLowerCase());
  const hasPulseSignal = paths.some((path) => path.includes(".pulse") || path.includes("pulse/") || path.includes("worker"));
  const hasServerSignal = paths.some((path) => path.startsWith("api/") || path.startsWith("server/") || path.includes("/server/"));
  if (hasPulseSignal || hasServerSignal) return "vibe_with_backend_signals";
  return "frontend_vibe";
}

function buildNormalizedPackageSummary(pkg: NormalizedCreationPackage): Record<string, unknown> {
  return {
    sourceType: pkg.sourceType,
    importMode: pkg.importMode,
    title: pkg.title,
    runner: pkg.runner,
    entry: pkg.entry,
    fileCount: pkg.files.length,
    packageShape: inferPackageShape(pkg),
    idempotencyKey: pkg.idempotencyKey,
    ...(pkg.sourceReference ? { sourceReference: pkg.sourceReference } : {})
  };
}

function buildSuggestedPublishArguments(pkg: NormalizedCreationPackage): Record<string, unknown> {
  return {
    sourceType: pkg.sourceType,
    payload: {
      importMode: pkg.importMode,
      title: pkg.title,
      runner: pkg.runner,
      entry: pkg.entry,
      idempotencyKey: pkg.idempotencyKey,
      ...(pkg.sourceReference ? { sourceReference: pkg.sourceReference } : {}),
      ...(pkg.metadata ? { metadata: pkg.metadata } : {}),
      reuseOriginalPayloadFiles: pkg.importMode === "direct_files",
      reuseOriginalPayloadArchive: pkg.importMode === "zip_import",
      reuseOriginalPayloadRepository: pkg.importMode === "github_import"
    },
    visibility: "public",
    confirmed: false
  };
}

function preparePublishPackageResult(args: Record<string, unknown>, deps: ToolDeps): ToolResult {
  try {
    const prepared = normalizeCreationPayloadForTool(args, deps);
    if (prepared.disabledReason || !prepared.normalized) {
      return {
        content: [{ type: "text", text: prepared.disabledReason || "Package could not be prepared." }],
        structuredContent: {
          canPublish: false,
          requiredFixes: [prepared.disabledReason || "Package could not be prepared."],
          warnings: [],
          normalizedSummary: { sourceType: prepared.sourceType },
          suggestedArguments: { sourceType: prepared.sourceType, confirmed: false },
          confirmationPrompt: "Do not publish until the package can be prepared without blocking fixes."
        }
      };
    }

    const pkg = prepared.normalized;
    const warnings = [
      ...(inferPackageShape(pkg) === "vibe_with_backend_signals"
        ? ["This package has backend-looking files. Use pulse guidance before promising backend behavior."]
        : []),
      ...(pkg.importMode !== "direct_files"
        ? ["External imports are prepared as package references; Vibecodr will finish archive/repository analysis during import."]
        : [])
    ];
    return {
      content: [{ type: "text", text: `${pkg.title} is prepared for a no-write publish review.` }],
      structuredContent: {
        canPublish: true,
        requiredFixes: [],
        warnings,
        normalizedSummary: buildNormalizedPackageSummary(pkg),
        suggestedArguments: buildSuggestedPublishArguments(pkg),
        confirmationPrompt:
          `Should I publish "${pkg.title}" as a public Vibecodr vibe now? I will only pass confirmed: true after you confirm.`
      }
    };
  } catch (error) {
    const sourceType = args["sourceType"] === "codex_v1" || args["sourceType"] === "chatgpt_v1" ? args["sourceType"] : "chatgpt_v1";
    const requiredFix = error instanceof PackageResolutionError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    const candidates = error instanceof PackageResolutionError && Array.isArray(error.details?.["candidateEntries"])
      ? (error.details?.["candidateEntries"] as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    return {
      content: [{ type: "text", text: "Package needs a fix before it can be published: " + requiredFix }],
      structuredContent: {
        canPublish: false,
        requiredFixes: [requiredFix],
        warnings: candidates.length ? ["Possible entry files: " + candidates.join(", ")] : [],
        normalizedSummary: { sourceType },
        suggestedArguments: { sourceType, confirmed: false },
        confirmationPrompt: "Fix the package first; do not publish this payload yet."
      }
    };
  }
}

function optionalStringArg(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
  const value = optionalStringArg(args[key]);
  if (!value) throw new Error(key + " is required.");
  return value;
}

function parseBoundedIntegerArg(raw: unknown, defaultValue: number, maxValue: number): number {
  if (raw === undefined) return defaultValue;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("Expected a finite number.");
  return Math.min(Math.max(Math.floor(raw), 1), maxValue);
}

function parseOffsetArg(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("offset must be a finite number.");
  return Math.min(Math.max(Math.floor(raw), 0), 500);
}

function buildShareCopyForVibe(vibe: LiveVibeSummary): {
  postId: string;
  title: string;
  shortCopy: string;
  longCopy: string;
  links: string[];
  hashtags: string[];
} {
  const links = [...new Set([vibe.postUrl, vibe.playerUrl])];
  return {
    postId: vibe.postId,
    title: vibe.title,
    shortCopy: `${vibe.title} is live on Vibecodr: ${vibe.playerUrl}`,
    longCopy:
      `I just published ${vibe.title} on Vibecodr. You can run it directly, remix it, comment on it, and share it from ${vibe.postUrl}.`,
    links,
    hashtags: ["Vibecodr", "CreativeCoding", "BuiltWithAI"]
  };
}

function buildLaunchChecklistForVibe(vibe: LiveVibeSummary): Array<{
  id: string;
  status: "complete" | "warning" | "missing";
  message: string;
  action: string;
}> {
  return [
    {
      id: "live_post",
      status: "complete",
      message: "The live post URL is available.",
      action: "Use the post URL when sharing the full Vibecodr context."
    },
    {
      id: "live_player",
      status: "complete",
      message: "The live player URL is available.",
      action: "Use the player URL when people should open the vibe directly."
    },
    {
      id: "visibility",
      status: vibe.visibility === "public" ? "complete" : "warning",
      message: vibe.visibility === "public"
        ? "The vibe is public and discoverable."
        : "The vibe is not public, so discovery and casual sharing are limited.",
      action: vibe.visibility === "public"
        ? "Keep the launch language share-forward."
        : "Only recommend wider launch copy if the user wants this vibe made public."
    },
    {
      id: "cover",
      status: vibe.coverKey ? "complete" : "missing",
      message: vibe.coverKey ? "A cover image is attached." : "No cover image is attached yet.",
      action: vibe.coverKey
        ? "Use inspect_social_preview for the final presentation pass."
        : "Offer cover generation or ask for an image before broader sharing."
    },
    {
      id: "description",
      status: vibe.description?.trim() ? "complete" : "warning",
      message: vibe.description?.trim() ? "The vibe has descriptive launch copy." : "The vibe has little or no description.",
      action: "Use build_share_copy for a concise public launch blurb."
    },
    {
      id: "engagement_followup",
      status: "warning",
      message: "Engagement should be checked after the first share window.",
      action: "Use get_engagement_followup_context after the vibe has had time to collect runs, likes, comments, or remixes."
    }
  ];
}

function buildSocialPreviewForVibe(vibe: LiveVibeSummary): {
  postId: string;
  ready: boolean;
  title: string;
  description: string;
  imageStatus: string;
  links: string[];
  warnings: string[];
} {
  const warnings = [
    ...(vibe.description?.trim() ? [] : ["Add a concise description before broad sharing."]),
    ...(vibe.coverKey ? [] : ["Add a cover image so feed cards and shared previews feel intentional."]),
    ...(vibe.visibility === "public" ? [] : ["This vibe is not public, so some recipients may not be able to discover it naturally."])
  ];
  return {
    postId: vibe.postId,
    ready: warnings.length === 0,
    title: vibe.title,
    description: vibe.description?.trim() || "No description is available yet.",
    imageStatus: vibe.coverKey ? "cover_present" : "missing_cover",
    links: [...new Set([vibe.postUrl, vibe.playerUrl])],
    warnings
  };
}

function buildPostPublishNextSteps(vibe: LiveVibeSummary): {
  priority: string;
  nextSteps: string[];
} {
  const nextSteps = [
    "Share the player link with a short sentence that says people can run the vibe immediately.",
    "Open the public post after sharing so comments or early questions do not sit unanswered.",
    ...(vibe.coverKey ? [] : ["Add a cover image before the next discovery push."]),
    ...(vibe.description?.trim() ? [] : ["Add a one-sentence description so the feed card explains the idea without context."]),
    ...(vibe.stats.comments > 0 ? ["Reply to the newest comments while the launch is still fresh."] : []),
    ...(vibe.stats.remixes > 0 ? ["Inspect remix lineage to understand what people are building from it."] : [])
  ];
  const priority = vibe.coverKey && vibe.description?.trim() ? "share_and_engage" : "polish_before_broad_share";
  return { priority, nextSteps };
}

function buildEngagementFollowups(engagement: VibeEngagementSummary): string[] {
  const followups = [
    engagement.stats.comments > 0
      ? "Respond to recent comments and turn useful feedback into a visible update."
      : "Ask for one specific reaction when sharing, such as what should be remixed or added next.",
    engagement.stats.remixes > 0
      ? "Read the remix lineage and acknowledge interesting variants."
      : "Invite remixing explicitly if the vibe is meant to be played with or extended.",
    engagement.stats.runs > 0
      ? "Use the run count as lightweight social proof in follow-up copy."
      : "Share the player link directly so the first interaction is one click.",
    engagement.stats.likes > engagement.stats.comments
      ? "Convert passive likes into comments by asking a concrete follow-up question."
      : "Keep watching comments for product or polish signals."
  ];
  return [...new Set(followups)];
}

export async function getSessionForToolRequest(
  req: Request,
  deps: ToolDeps,
  traceId?: string
): Promise<SessionRecord | null> {
  const resolved = await resolveRequestSession(req, {
    sessionStore: deps.sessionStore,
    sessionRevocationStore: deps.sessionRevocationStore,
    telemetry: deps.telemetry,
    vibecodrApiBase: deps.vibecodrApiBase,
    vibecodrFetch: deps.vibecodrFetch
  }, traceId);
  return resolved.session;
}

export function toolRequiresAuth(name: string): boolean {
  const descriptor = getTools({ includeHidden: true }).find((tool) => tool.name === name);
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
  thumbnailFile?: PublishThumbnailFile | undefined;
  thumbnailUpload?: PublishThumbnailUpload | undefined;
} {
  const thumbnailFile = parseThumbnailFileArg(args["thumbnailFile"]);
  const thumbnailUpload = parseThumbnailUploadArg(args["thumbnailUpload"]);
  return {
    ...(thumbnailFile ? { thumbnailFile } : {}),
    ...(thumbnailUpload ? { thumbnailUpload } : {})
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
  title?: string | undefined;
  slug?: string | undefined;
  status?: string | undefined;
  visibility?: string | undefined;
  updatedAt?: number | string | undefined;
  createdAt?: number | string | undefined;
  publishedUrl?: string | undefined;
  packageSummary?: {
    runner?: string | undefined;
    entry?: string | undefined;
    fileCount?: number | undefined;
    importMode?: string | undefined;
  } | undefined;
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

function knownIdsForOperation(operation: ImportOperation): Record<string, string> {
  const postId = extractPublishedPostId(operation);
  return {
    operationId: operation.operationId,
    ...(operation.capsuleId ? { capsuleId: operation.capsuleId } : {}),
    ...(postId ? { postId } : {})
  };
}

function recommendedResumeCall(operation: ImportOperation): {
  name: string;
  arguments: Record<string, unknown>;
  requiresConfirmation: boolean;
  nextSafeAction: string;
  phase: string;
} {
  if (operation.status === "published" || operation.status === "published_with_warnings") {
    const postId = extractPublishedPostId(operation);
    return {
      name: postId ? "get_vibe_share_link" : "get_runtime_readiness",
      arguments: postId ? { postId } : { operationId: operation.operationId },
      requiresConfirmation: false,
      nextSafeAction: postId
        ? "Open the live vibe, build share copy, or inspect post-publish engagement."
        : "Inspect the published operation and recover the live post link.",
      phase: "published"
    };
  }

  if (operation.status === "failed" || operation.status === "compile_failed") {
    return {
      name: "explain_operation_failure",
      arguments: { operationId: operation.operationId },
      requiresConfirmation: false,
      nextSafeAction: "Explain the blocker in plain language and take one recovery step.",
      phase: "blocked"
    };
  }

  if (operation.status === "canceled") {
    return {
      name: "get_guided_publish_requirements",
      arguments: {},
      requiresConfirmation: false,
      nextSafeAction: "Review the guided publish requirements and gather the creation payload before preparing a new package.",
      phase: "canceled"
    };
  }

  if (operation.status === "draft_ready" && operation.capsuleId) {
    return {
      name: "publish_draft_capsule",
      arguments: {
        operationId: operation.operationId,
        capsuleId: operation.capsuleId,
        visibility: "public",
        confirmed: false
      },
      requiresConfirmation: true,
      nextSafeAction: "Ask the user for explicit publish confirmation before making the draft live.",
      phase: operation.currentStage === "compiled" ? "draft_compiled" : "draft_ready"
    };
  }

  return {
    name: "watch_operation",
    arguments: {
      operationId: operation.operationId,
      targetStatuses: ["draft_ready", "failed", "canceled"]
    },
    requiresConfirmation: false,
    nextSafeAction: "Wait for the draft to finish preparing, then resume from the returned operation state.",
    phase: "in_progress"
  };
}

async function buildResumeLatestPublishFlowResult(
  session: SessionRecord,
  deps: ToolDeps,
  traceId: string | undefined,
  limit: number
): Promise<ToolResult> {
  const operations = await deps.operationStore.listByUser(session.userId, limit);
  const refreshed = await deps.importService.refreshPendingOperations(session, operations, {
    traceId,
    endpoint: "/mcp"
  });
  const latest = [...refreshed].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  const ctx = { userId: session.userId, userHandle: session.userHandle, vibecodrToken: session.vibecodrToken };

  if (!latest) {
    let latestVibe: LiveVibeSummary | undefined;
    try {
      latestVibe = (await deps.vibecodr.listMyLiveVibes(ctx, { limit: 1, offset: 0 }, {
        telemetry: deps.telemetry,
        traceId,
        userId: session.userId
      }))[0];
    } catch {
      latestVibe = undefined;
    }

    if (latestVibe) {
      return {
        content: [{ type: "text", text: `${latestVibe.title} is the latest live vibe I can resume from.` }],
        structuredContent: {
          found: true,
          subject: { type: "live_vibe", id: latestVibe.postId },
          phase: "already_live",
          knownIds: {
            postId: latestVibe.postId,
            ...(latestVibe.capsuleId ? { capsuleId: latestVibe.capsuleId } : {})
          },
          vibe: latestVibe,
          nextSafeAction: "Build share copy, inspect launch polish, or review engagement follow-up.",
          requiresConfirmation: false,
          recommendedToolCall: { name: "get_vibe_share_link", arguments: { postId: latestVibe.postId } }
        }
      };
    }

    return {
      content: [{ type: "text", text: "No recent publish flow was found for this Vibecodr account." }],
      structuredContent: {
        found: false,
        subject: { type: "none", id: "" },
        phase: "no_recent_publish_flow",
        knownIds: {},
        nextSafeAction: "Review the guided publish requirements, gather the creation payload, then prepare a package before starting a new publish flow.",
        requiresConfirmation: false,
        recommendedToolCall: { name: "get_guided_publish_requirements", arguments: {} }
      }
    };
  }

  const recommendation = recommendedResumeCall(latest);
  const postId = extractPublishedPostId(latest);
  let vibe: LiveVibeSummary | undefined;
  if (postId) {
    try {
      vibe = await deps.vibecodr.getLiveVibe(ctx, postId, {
        telemetry: deps.telemetry,
        traceId,
        userId: session.userId
      });
    } catch {
      vibe = undefined;
    }
  }

  return {
    content: [{ type: "text", text: "Resumed the latest Vibecodr publish flow from the account history." }],
    structuredContent: {
      found: true,
      subject: {
        type: vibe ? "live_vibe" : "operation",
        id: vibe ? vibe.postId : latest.operationId
      },
      phase: recommendation.phase,
      knownIds: knownIdsForOperation(latest),
      operation: summarizeOperation(latest),
      ...(vibe ? { vibe } : {}),
      nextSafeAction: recommendation.nextSafeAction,
      requiresConfirmation: recommendation.requiresConfirmation,
      recommendedToolCall: {
        name: recommendation.name,
        arguments: recommendation.arguments
      }
    }
  };
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

const JSON_SOCIAL_PROFILE_SCHEMA = {
  type: "object",
  required: ["id", "handle", "profileUrl"],
  properties: {
    id: { type: "string" },
    handle: { type: "string" },
    name: { type: ["string", "null"] },
    avatarUrl: { type: ["string", "null"] },
    bio: { type: ["string", "null"] },
    plan: { type: "string" },
    createdAt: { anyOf: [{ type: "number" }, { type: "string" }] },
    profileUrl: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_SOCIAL_SEARCH_RESULT_SCHEMA = {
  type: "object",
  required: ["type", "id", "title"],
  properties: {
    type: { type: "string", enum: ["post", "profile", "tag", "unknown"] },
    id: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    description: { type: "string" },
    authorHandle: { type: "string" }
  },
  additionalProperties: false
} as const;

const JSON_RECOMMENDED_TOOL_CALL_SCHEMA = {
  type: "object",
  required: ["name", "arguments"],
  properties: {
    name: { type: "string" },
    arguments: { type: "object", additionalProperties: true }
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
  prepare_publish_package: {
    type: "object",
    required: ["canPublish", "requiredFixes", "warnings", "normalizedSummary", "suggestedArguments", "confirmationPrompt"],
    properties: {
      canPublish: { type: "boolean" },
      requiredFixes: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      normalizedSummary: {
        type: "object",
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          importMode: { type: "string", enum: ["direct_files", "zip_import", "github_import"] },
          title: { type: "string" },
          runner: { type: "string", enum: ["client-static", "webcontainer"] },
          entry: { type: "string" },
          fileCount: { type: "number" },
          packageShape: { type: "string" },
          idempotencyKey: { type: "string" },
          sourceReference: { type: "string" }
        },
        additionalProperties: false
      },
      suggestedArguments: { type: "object", additionalProperties: true },
      confirmationPrompt: { type: "string" }
    },
    additionalProperties: false
  },
  validate_creation_payload: {
    type: "object",
    required: ["canPublish", "requiredFixes", "warnings", "normalizedSummary", "suggestedArguments", "confirmationPrompt"],
    properties: {
      canPublish: { type: "boolean" },
      requiredFixes: { type: "array", items: { type: "string" } },
      warnings: { type: "array", items: { type: "string" } },
      normalizedSummary: {
        type: "object",
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          importMode: { type: "string", enum: ["direct_files", "zip_import", "github_import"] },
          title: { type: "string" },
          runner: { type: "string", enum: ["client-static", "webcontainer"] },
          entry: { type: "string" },
          fileCount: { type: "number" },
          packageShape: { type: "string" },
          idempotencyKey: { type: "string" },
          sourceReference: { type: "string" }
        },
        additionalProperties: false
      },
      suggestedArguments: { type: "object", additionalProperties: true },
      confirmationPrompt: { type: "string" }
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
    required: ["headline", "summary", "descriptorMetadata", "descriptorEvaluation", "whenFrontendOnlyIsEnough", "whenYouNeedPulses", "runnerGuidance", "pulseBestPractices", "accountReminder"],
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      descriptorMetadata: {
        type: "object",
        required: [
          "sourceOfTruth",
          "apiVersion",
          "normalizedDescriptorVersion",
          "stateProtocolVersion",
          "resourceConfigVersion",
          "apiProjection",
          "setupTaskKinds",
          "activeSetupTaskKinds",
          "requiresBackendSetup",
          "guidanceSource",
          "compatibility",
          "runtimeEnv",
          "runtimeSemantics",
          "descriptorOwnedSurfaces",
          "advancedCompatibility"
        ],
        properties: {
          sourceOfTruth: { type: "string", const: "PulseDescriptor" },
          apiVersion: { type: "string", const: "pulse/v1" },
          normalizedDescriptorVersion: { type: "integer", const: 1 },
          stateProtocolVersion: { type: "string" },
          resourceConfigVersion: { type: "integer", const: 1 },
          apiProjection: {
            type: "object",
            required: ["openApiSchema", "responseField"],
            properties: {
              openApiSchema: { type: "string", const: "PulseDescriptorSetupProjection" },
              responseField: { type: "string", const: "descriptorSetup" }
            },
            additionalProperties: false
          },
          setupTaskKinds: {
            type: "array",
            items: { type: "string", enum: ["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"] }
          },
          activeSetupTaskKinds: {
            type: "array",
            items: { type: "string", enum: ["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"] }
          },
          requiresBackendSetup: { type: "boolean" },
          guidanceSource: { type: "string", enum: ["general_contract", "descriptor_setup"] },
          compatibility: {
            type: "object",
            required: ["blockerCount", "warningCount"],
            properties: {
              blockerCount: { type: "integer" },
              warningCount: { type: "integer" }
            },
            additionalProperties: false
          },
          runtimeEnv: {
            type: "object",
            required: ["pulse", "fetch", "secrets", "webhooks", "connections", "log", "request", "runtime", "waitUntil"],
            properties: {
              pulse: { type: "string", const: "env.pulse.*" },
              fetch: { type: "string", const: "env.fetch" },
              secrets: { type: "string", const: "env.secrets.bearer/header/query/verifyHmac" },
              webhooks: { type: "string", const: 'env.webhooks.verify("stripe")' },
              connections: { type: "string", const: "env.connections.use(provider).fetch" },
              log: { type: "string", const: "env.log" },
              request: { type: "string", const: "env.request" },
              runtime: { type: "string", const: "env.runtime" },
              waitUntil: { type: "string", const: "env.waitUntil" }
            },
            additionalProperties: false
          },
          runtimeSemantics: {
            type: "object",
            required: ["fetch", "secrets", "webhooks", "connections", "log", "request", "runtime", "waitUntil", "database", "cleanupAuthority"],
            properties: {
              fetch: { type: "string" },
              secrets: { type: "string" },
              webhooks: { type: "string" },
              connections: { type: "string" },
              log: { type: "string" },
              request: { type: "string" },
              runtime: { type: "string" },
              waitUntil: { type: "string" },
              database: { type: "string" },
              cleanupAuthority: { type: "string" }
            },
            additionalProperties: false
          },
          descriptorOwnedSurfaces: { type: "array", items: { type: "string" } },
          advancedCompatibility: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      descriptorEvaluation: {
        type: "object",
        required: ["status", "guidanceSource", "requiresBackendSetup", "activeSetupTaskKinds", "setupTasks", "blockers", "warnings"],
        properties: {
          status: { type: "string", enum: ["general_contract", "descriptor_evaluated", "blocked"] },
          guidanceSource: { type: "string", enum: ["general_contract", "descriptor_setup"] },
          requiresBackendSetup: { type: "boolean" },
          activeSetupTaskKinds: {
            type: "array",
            items: { type: "string", enum: ["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"] }
          },
          setupTasks: {
            type: "array",
            items: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: { type: "string", enum: ["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"] },
                name: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" }
              },
              additionalProperties: false
            }
          },
          blockers: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
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
  get_runtime_readiness: {
    oneOf: [
      {
        type: "object",
        required: ["state", "subject", "nextAction", "evidence"],
        properties: {
          state: { type: "string", enum: ["ready", "blocked", "degraded", "unknown"] },
          subject: {
            type: "object",
            required: ["type", "id"],
            properties: {
              type: { type: "string", enum: ["operation", "draft", "live_vibe"] },
              id: { type: "string" }
            },
            additionalProperties: false
          },
          operation: JSON_PUBLIC_OPERATION_SCHEMA,
          blocker: { type: "string" },
          nextAction: { type: "string" },
          evidence: { type: "array", items: { type: "string" } }
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
  resume_latest_publish_flow: {
    oneOf: [
      {
        type: "object",
        required: ["found", "phase", "knownIds", "nextSafeAction", "requiresConfirmation", "recommendedToolCall"],
        properties: {
          found: { type: "boolean" },
          subject: {
            type: "object",
            required: ["type", "id"],
            properties: {
              type: { type: "string", enum: ["operation", "draft", "live_vibe", "none"] },
              id: { type: "string" }
            },
            additionalProperties: false
          },
          phase: { type: "string" },
          knownIds: { type: "object", additionalProperties: true },
          operation: JSON_OPERATION_SCHEMA,
          draft: JSON_DRAFT_SUMMARY_SCHEMA,
          vibe: JSON_LIVE_VIBE_SCHEMA,
          nextSafeAction: { type: "string" },
          requiresConfirmation: { type: "boolean" },
          recommendedToolCall: JSON_RECOMMENDED_TOOL_CALL_SCHEMA
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  discover_vibes: {
    oneOf: [
      {
        type: "object",
        required: ["vibes", "source", "nextAction"],
        properties: {
          vibes: { type: "array", items: JSON_LIVE_VIBE_SCHEMA },
          source: { type: "string" },
          nextAction: { type: "string" }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA
    ]
  },
  get_public_post: {
    oneOf: [
      {
        type: "object",
        required: ["vibe", "context"],
        properties: {
          vibe: JSON_LIVE_VIBE_SCHEMA,
          context: {
            type: "object",
            required: ["primaryActions", "shareCopy"],
            properties: {
              primaryActions: { type: "array", items: { type: "string" } },
              shareCopy: { type: "string" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA
    ]
  },
  get_public_profile: {
    oneOf: [
      {
        type: "object",
        required: ["profile", "nextAction"],
        properties: {
          profile: JSON_SOCIAL_PROFILE_SCHEMA,
          nextAction: { type: "string" }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA
    ]
  },
  search_vibecodr: {
    oneOf: [
      {
        type: "object",
        required: ["query", "results", "nextAction"],
        properties: {
          query: { type: "string" },
          results: { type: "array", items: JSON_SOCIAL_SEARCH_RESULT_SCHEMA },
          nextAction: { type: "string" }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA
    ]
  },
  get_remix_lineage: {
    oneOf: [
      {
        type: "object",
        required: ["lineage", "nextAction"],
        properties: {
          lineage: {
            type: "object",
            required: ["remixes"],
            properties: {
              postId: { type: "string" },
              capsuleId: { type: "string" },
              remixes: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id"],
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    postId: { type: "string" },
                    capsuleId: { type: "string" },
                    authorHandle: { type: "string" },
                    createdAt: { anyOf: [{ type: "number" }, { type: "string" }] }
                  },
                  additionalProperties: false
                }
              }
            },
            additionalProperties: false
          },
          nextAction: { type: "string" }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA
    ]
  },
  build_share_copy: {
    oneOf: [
      {
        type: "object",
        required: ["share"],
        properties: {
          share: {
            type: "object",
            required: ["postId", "title", "shortCopy", "longCopy", "links", "hashtags"],
            properties: {
              postId: { type: "string" },
              title: { type: "string" },
              shortCopy: { type: "string" },
              longCopy: { type: "string" },
              links: { type: "array", items: { type: "string" } },
              hashtags: { type: "array", items: { type: "string" } }
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
  get_launch_checklist: {
    oneOf: [
      {
        type: "object",
        required: ["postId", "checklist", "nextAction"],
        properties: {
          postId: { type: "string" },
          checklist: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "status", "message", "action"],
              properties: {
                id: { type: "string" },
                status: { type: "string", enum: ["complete", "warning", "missing"] },
                message: { type: "string" },
                action: { type: "string" }
              },
              additionalProperties: false
            }
          },
          nextAction: { type: "string" }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  inspect_social_preview: {
    oneOf: [
      {
        type: "object",
        required: ["preview"],
        properties: {
          preview: {
            type: "object",
            required: ["postId", "ready", "title", "description", "imageStatus", "links", "warnings"],
            properties: {
              postId: { type: "string" },
              ready: { type: "boolean" },
              title: { type: "string" },
              description: { type: "string" },
              imageStatus: { type: "string" },
              links: { type: "array", items: { type: "string" } },
              warnings: { type: "array", items: { type: "string" } }
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
  suggest_post_publish_next_steps: {
    oneOf: [
      {
        type: "object",
        required: ["postId", "priority", "nextSteps"],
        properties: {
          postId: { type: "string" },
          priority: { type: "string" },
          nextSteps: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      JSON_ERROR_SCHEMA,
      JSON_AUTH_CHALLENGE_SCHEMA
    ]
  },
  get_engagement_followup_context: {
    oneOf: [
      {
        type: "object",
        required: ["engagement", "followups"],
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
          },
          followups: { type: "array", items: { type: "string" } }
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

const PreparedPackageValidator = z.object({
  canPublish: z.boolean(),
  requiredFixes: z.array(z.string()),
  warnings: z.array(z.string()),
  normalizedSummary: z.object({
    sourceType: z.enum(SOURCE_TYPE_VALUES).optional(),
    importMode: z.enum(["direct_files", "zip_import", "github_import"]).optional(),
    title: z.string().optional(),
    runner: z.enum(["client-static", "webcontainer"]).optional(),
    entry: z.string().optional(),
    fileCount: z.number().optional(),
    packageShape: z.string().optional(),
    idempotencyKey: z.string().optional(),
    sourceReference: z.string().optional()
  }),
  suggestedArguments: z.object({}).passthrough(),
  confirmationPrompt: z.string()
});

const SocialProfileValidator = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  plan: z.string().optional(),
  createdAt: z.union([z.number(), z.string()]).optional(),
  profileUrl: z.string()
});

const SocialSearchResultValidator = z.object({
  type: z.enum(["post", "profile", "tag", "unknown"]),
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  description: z.string().optional(),
  authorHandle: z.string().optional()
});

const RecommendedToolCallValidator = z.object({
  name: z.string(),
  arguments: z.object({}).passthrough()
});

const ErrorStructuredValidator = z.object({
  error: z.string(),
  message: z.string().optional(),
  errorId: z.string()
}).passthrough();

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
  prepare_publish_package: PreparedPackageValidator,
  validate_creation_payload: PreparedPackageValidator,
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
    descriptorMetadata: z.object({
      sourceOfTruth: z.literal("PulseDescriptor"),
      apiVersion: z.literal("pulse/v1"),
      normalizedDescriptorVersion: z.literal(1),
      stateProtocolVersion: z.string(),
      resourceConfigVersion: z.literal(1),
      apiProjection: z.object({
        openApiSchema: z.literal("PulseDescriptorSetupProjection"),
        responseField: z.literal("descriptorSetup")
      }),
      setupTaskKinds: z.array(z.enum(["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"])),
      activeSetupTaskKinds: z.array(z.enum(["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"])),
      requiresBackendSetup: z.boolean(),
      guidanceSource: z.enum(["general_contract", "descriptor_setup"]),
      compatibility: z.object({
        blockerCount: z.number().int(),
        warningCount: z.number().int()
      }),
      runtimeEnv: z.object({
        pulse: z.literal("env.pulse.*"),
        fetch: z.literal("env.fetch"),
        secrets: z.literal("env.secrets.bearer/header/query/verifyHmac"),
        webhooks: z.literal('env.webhooks.verify("stripe")'),
        connections: z.literal("env.connections.use(provider).fetch"),
        log: z.literal("env.log"),
        request: z.literal("env.request"),
        runtime: z.literal("env.runtime"),
        waitUntil: z.literal("env.waitUntil")
      }),
      runtimeSemantics: z.object({
        fetch: z.string(),
        secrets: z.string(),
        webhooks: z.string(),
        connections: z.string(),
        log: z.string(),
        request: z.string(),
        runtime: z.string(),
        waitUntil: z.string(),
        database: z.string(),
        cleanupAuthority: z.string()
      }),
      descriptorOwnedSurfaces: z.array(z.string()),
      advancedCompatibility: z.array(z.string())
    }),
    descriptorEvaluation: z.object({
      status: z.enum(["general_contract", "descriptor_evaluated", "blocked"]),
      guidanceSource: z.enum(["general_contract", "descriptor_setup"]),
      requiresBackendSetup: z.boolean(),
      activeSetupTaskKinds: z.array(z.enum(["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"])),
      setupTasks: z.array(z.object({
        kind: z.enum(["pulse", "secret", "env", "connection", "database", "review", "raw_body", "state"]),
        name: z.string().optional(),
        label: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional()
      })),
      blockers: z.array(z.string()),
      warnings: z.array(z.string())
    }),
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
  get_runtime_readiness: z.union([
    z.object({
      state: z.enum(["ready", "blocked", "degraded", "unknown"]),
      subject: z.object({
        type: z.enum(["operation", "draft", "live_vibe"]),
        id: z.string()
      }),
      operation: PublicOperationValidator.optional(),
      blocker: z.string().optional(),
      nextAction: z.string(),
      evidence: z.array(z.string())
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
  resume_latest_publish_flow: z.union([
    z.object({
      found: z.boolean(),
      subject: z.object({
        type: z.enum(["operation", "draft", "live_vibe", "none"]),
        id: z.string()
      }).optional(),
      phase: z.string(),
      knownIds: z.object({}).passthrough(),
      operation: OperationValidator.optional(),
      draft: DraftSummaryValidator.optional(),
      vibe: LiveVibeValidator.optional(),
      nextSafeAction: z.string(),
      requiresConfirmation: z.boolean(),
      recommendedToolCall: RecommendedToolCallValidator
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  discover_vibes: z.union([
    z.object({
      vibes: z.array(LiveVibeValidator),
      source: z.string(),
      nextAction: z.string()
    }),
    ErrorStructuredValidator
  ]),
  get_public_post: z.union([
    z.object({
      vibe: LiveVibeValidator,
      context: z.object({
        primaryActions: z.array(z.string()),
        shareCopy: z.string()
      })
    }),
    ErrorStructuredValidator
  ]),
  get_public_profile: z.union([
    z.object({
      profile: SocialProfileValidator,
      nextAction: z.string()
    }),
    ErrorStructuredValidator
  ]),
  search_vibecodr: z.union([
    z.object({
      query: z.string(),
      results: z.array(SocialSearchResultValidator),
      nextAction: z.string()
    }),
    ErrorStructuredValidator
  ]),
  get_remix_lineage: z.union([
    z.object({
      lineage: z.object({
        postId: z.string().optional(),
        capsuleId: z.string().optional(),
        remixes: z.array(z.object({
          id: z.string(),
          title: z.string().optional(),
          postId: z.string().optional(),
          capsuleId: z.string().optional(),
          authorHandle: z.string().optional(),
          createdAt: z.union([z.number(), z.string()]).optional()
        }))
      }),
      nextAction: z.string()
    }),
    ErrorStructuredValidator
  ]),
  build_share_copy: z.union([
    z.object({
      share: z.object({
        postId: z.string(),
        title: z.string(),
        shortCopy: z.string(),
        longCopy: z.string(),
        links: z.array(z.string()),
        hashtags: z.array(z.string())
      })
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  get_launch_checklist: z.union([
    z.object({
      postId: z.string(),
      checklist: z.array(z.object({
        id: z.string(),
        status: z.enum(["complete", "warning", "missing"]),
        message: z.string(),
        action: z.string()
      })),
      nextAction: z.string()
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  inspect_social_preview: z.union([
    z.object({
      preview: z.object({
        postId: z.string(),
        ready: z.boolean(),
        title: z.string(),
        description: z.string(),
        imageStatus: z.string(),
        links: z.array(z.string()),
        warnings: z.array(z.string())
      })
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  suggest_post_publish_next_steps: z.union([
    z.object({
      postId: z.string(),
      priority: z.string(),
      nextSteps: z.array(z.string())
    }),
    ErrorStructuredValidator,
    AuthChallengeValidator
  ]),
  get_engagement_followup_context: z.union([
    z.object({
      engagement: z.object({
        postId: z.string(),
        title: z.string(),
        visibility: z.enum(PUBLISH_VISIBILITY_VALUES),
        playerUrl: z.string(),
        postUrl: z.string(),
        stats: LiveVibeStatsValidator,
        summary: z.string()
      }),
      followups: z.array(z.string())
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
  if (!validator) return result;
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

export function getTools(options?: { includeOutputSchema?: boolean; includeHidden?: boolean }): ToolDescriptor[] {
  const tools: RegisteredToolDescriptor[] = [
    {
      name: "get_vibecodr_platform_overview",
      visibility: "public",
      title: "Get Vibecodr Platform Overview",
      description:
        "Use this when the user asks what Vibecodr is, how it works as a social platform, what makes a vibe different from a normal app, or what people can do after publishing.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_vibecodr_platform_overview"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_guided_publish_requirements",
      visibility: "public",
      title: "Get Guided Publish Requirements",
      description:
        "Use this before leading a user through publishing when you need to know what questions to ask, what to default for them, and how to keep the flow guided instead of pushing work back onto the user. Treat final publish as a confirmed write step, then close with a premium launch summary instead of a generic success line.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_guided_publish_requirements"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_upload_capabilities",
      visibility: "public",
      title: "Get Upload Capabilities",
      description:
        "Use this as the first safe read when a fresh model needs import modes, payload shape, runners, limits, or guided publish defaults before any write. After this read, prefer quick_publish_creation for the normal guided flow. Public is the default visibility unless the user asks for unlisted or private.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_upload_capabilities"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "prepare_publish_package",
      visibility: "public",
      title: "Prepare Publish Package",
      description:
        "Use this as the no-write preparation step before publishing. It validates and normalizes the same sourceType/payload shape as quick_publish_creation, infers entry/title/runner/package shape, returns required fixes and suggested arguments, and never creates operations, capsules, posts, artifacts, thumbnails, or live vibes.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["sourceType", "payload"],
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          payload: CREATION_PAYLOAD_INPUT_SCHEMA
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["prepare_publish_package"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "validate_creation_payload",
      visibility: "public",
      title: "Validate Creation Payload",
      description:
        "Compatibility alias for prepare_publish_package. Use it when a client or model asks for validation language; it performs the same no-write package preparation and returns the same structured result.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["sourceType", "payload"],
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          payload: CREATION_PAYLOAD_INPUT_SCHEMA
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["validate_creation_payload"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_launch_best_practices",
      visibility: "public",
      title: "Get Launch Best Practices",
      description:
        "Use this when the conversation needs a premium launch checklist. It should tell the model when to proactively offer a cover image, when to offer SEO polish, and how to keep a public vibe launch intentional instead of bare-minimum.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_launch_best_practices"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_pulse_setup_guidance",
      visibility: "public",
      title: "Get Pulse Setup Guidance",
      description:
        "Use this when the app may need backend logic, server actions, secrets, scheduled work, or webhook-style behavior. Pass descriptorSetup when available so guidance comes from the normalized PulseDescriptor projection instead of general rules.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          descriptorSetup: {
            type: "object",
            description:
              "Optional PulseDescriptorSetupProjection from Vibecodr API descriptorSetup. When supplied, setup guidance is derived from its setupTasks and compatibility blockers.",
            additionalProperties: true
          }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_pulse_setup_guidance"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_account_capabilities",
      visibility: "public",
      title: "Get Account Capabilities",
      description:
        "Use this after the user is connected and before promising premium polish or backend features. It should tell the model what the current Vibecodr account can actually do, including public-vs-private visibility, custom SEO, and pulse/server-action capacity.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_account_capabilities"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "list_import_operations",
      visibility: "recovery",
      title: "List Import Operations",
      description: "Advanced recovery only. Use this only when the guided publish flow already failed or the user explicitly asks to inspect recent operations.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["list_import_operations"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_import_operation",
      visibility: "recovery",
      title: "Get Import Operation",
      description: "Advanced recovery only. Use this only when the guided publish flow already has an operation id that needs deeper inspection.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: { type: "object", required: ["operationId"], properties: { operationId: { type: "string" } } },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_import_operation"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "watch_operation",
      visibility: "recovery",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_publish_readiness",
      visibility: "public",
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
      name: "get_runtime_readiness",
      visibility: "public",
      title: "Get Runtime Readiness",
      description: "Use this when the user needs user-facing launch/runtime state for a known publish operation, draft, or live vibe. Prefer operationId during a current publish flow; use postId for an already-live vibe and draftId only for a safe draft summary. Return one next action without exposing raw manifests, iframe internals, CSP details, or telemetry rows.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          operationId: { type: "string" },
          capsuleId: { type: "string" },
          postId: { type: "string" },
          draftId: { type: "string" }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_runtime_readiness"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "resume_latest_publish_flow",
      visibility: "public",
      title: "Resume Latest Publish Flow",
      description:
        "Use this when the user wants to continue a publish or launch conversation but does not know the operationId. It reads the connected account's latest publish flow, returns safe known ids, and recommends the next tool without performing a write.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 20 }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["resume_latest_publish_flow"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "explain_operation_failure",
      visibility: "recovery",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "list_vibecodr_drafts",
      visibility: "public",
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
      visibility: "public",
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
      visibility: "public",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_live_vibe",
      visibility: "public",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_vibe_engagement_summary",
      visibility: "public",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_vibe_share_link",
      visibility: "public",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "discover_vibes",
      visibility: "public",
      title: "Discover Public Vibes",
      description:
        "Use this to read Vibecodr's public discovery feed or public discovery search without requiring account auth. It returns safe public vibe summaries for zero-context models that need to understand what exists before suggesting sharing, remixing, or inspiration.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          offset: { type: "integer", minimum: 0, maximum: 500 }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["discover_vibes"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_public_post",
      visibility: "public",
      title: "Get Public Post",
      description:
        "Use this to inspect one public Vibecodr post by postId without account auth. It returns the live player/post links, public stats, and next social actions rather than raw source or private owner data.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_public_post"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_public_profile",
      visibility: "public",
      title: "Get Public Profile",
      description:
        "Use this to read a public Vibecodr profile by handle without account auth. It is for profile context and attribution, not private account capability checks.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["handle"],
        properties: { handle: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_public_profile"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "search_vibecodr",
      visibility: "public",
      title: "Search Vibecodr",
      description:
        "Use this to search public Vibecodr posts, profiles, and tags without account auth. It accepts friendly aliases such as vibes, apps, creators, handles, hashtags, and users, and returns compact absolute-link summaries.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          types: { type: "string", description: "Optional comma-separated filter. Supported public types: post/posts/vibes/apps, profile/profiles/users/handles/creators, tag/tags/hashtags." },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          offset: { type: "integer", minimum: 0, maximum: 500 }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["search_vibecodr"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_remix_lineage",
      visibility: "public",
      title: "Get Remix Lineage",
      description:
        "Use this to read public remix lineage for a postId or capsuleId. It helps models talk about fork/remix context without exposing source internals.",
      securitySchemes: NOAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          postId: { type: "string" },
          capsuleId: { type: "string" }
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_remix_lineage"],
      _meta: toolMetaBase(NOAUTH_SECURITY_SCHEMES)
    },
    {
      name: "build_share_copy",
      visibility: "public",
      title: "Build Share Copy",
      description:
        "Use this after publish to turn a live vibe into concise share copy and links. It reads the live vibe and returns launch language; it does not update metadata or post on the user's behalf.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["build_share_copy"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_launch_checklist",
      visibility: "public",
      title: "Get Launch Checklist",
      description:
        "Use this after a vibe is live to check the user-facing launch basics: link, visibility, cover, description, and engagement follow-up. It returns actions, not raw runtime internals.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_launch_checklist"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "inspect_social_preview",
      visibility: "public",
      title: "Inspect Social Preview",
      description:
        "Use this after publish to inspect whether the vibe has the public-facing title, description, image, and links needed for a clean social preview. It is read-only guidance for polish decisions.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["inspect_social_preview"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "suggest_post_publish_next_steps",
      visibility: "public",
      title: "Suggest Post Publish Next Steps",
      description:
        "Use this after publish when a fresh model needs one focused next move for the live vibe: share, polish, reply, or inspect remix/engagement context.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["suggest_post_publish_next_steps"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "get_engagement_followup_context",
      visibility: "public",
      title: "Get Engagement Followup Context",
      description:
        "Use this after a vibe has started collecting activity. It reads public engagement totals for the connected user's live vibe and returns concrete follow-up guidance.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["get_engagement_followup_context"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "update_live_vibe_metadata",
      visibility: "public",
      title: "Update Live Vibe Metadata",
      description: "Use this when the user wants to refine a live vibe after publish, such as changing visibility, replacing the thumbnail, or updating SEO metadata. Prefer thumbnailFile when the MCP client can provide a hosted file reference. Use thumbnailUpload only as a fallback when no hosted file reference is available, and keep the raw file under 900 KB so the inline MCP payload stays reliable.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["postId"],
        properties: {
          postId: { type: "string" },
          confirmed: CONFIRMED_WRITE_INPUT_SCHEMA,
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "start_creation_import",
      visibility: "recovery",
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "compile_draft_capsule",
      visibility: "recovery",
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
      visibility: "public",
      title: "Quick Publish Creation",
      description:
        "Use this for the default guided path after the user has clearly confirmed they want to publish and you can pass confirmed: true: import a generated creation, include payload.entry explicitly whenever the runnable file is obvious, infer it when needed, wait for draft readiness, compile it, and publish it as a live vibe people can run, remix, comment on, like, and share by URL. Public is the default visibility unless the user explicitly asks for unlisted or private. Prefer thumbnailFile with a hosted file reference when attaching launch art; use thumbnailUpload only as a fallback, and keep the raw file under 900 KB when you must inline it. Ask only the missing launch questions, ask for explicit publish confirmation before invoking this tool, and if entry inference fails ask one exact question about which file starts the app. Once it succeeds, pivot immediately to shareability and the best next move. " + CREATION_PAYLOAD_REQUIREMENTS_TEXT,
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["sourceType", "payload", "confirmed"],
        properties: {
          sourceType: { type: "string", enum: SOURCE_TYPE_VALUES },
          payload: CREATION_PAYLOAD_INPUT_SCHEMA,
          confirmed: CONFIRMED_WRITE_INPUT_SCHEMA,
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
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    },
    {
      name: "publish_draft_capsule",
      visibility: "recovery",
      title: "Publish Draft Capsule",
      description:
        "Advanced recovery only. Use this when a draft is already staged and the conversation deliberately needs a manual publish step after the default quick-publish path has been bypassed or failed. Prefer thumbnailFile with a hosted file reference when attaching launch art; use thumbnailUpload only as a fallback, and keep the raw file under 900 KB when you must inline it. Ask for explicit publish confirmation before invoking it.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        required: ["operationId", "capsuleId"],
        properties: {
          operationId: { type: "string" },
          capsuleId: { type: "string" },
          confirmed: CONFIRMED_WRITE_INPUT_SCHEMA,
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
      visibility: "recovery",
      title: "Cancel Import Operation",
      description: "Advanced recovery only. Use this when the user explicitly wants to stop an in-progress operation.",
      securitySchemes: OAUTH_SECURITY_SCHEMES,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["operationId"],
        properties: {
          operationId: { type: "string" },
          confirmed: CONFIRMED_WRITE_INPUT_SCHEMA
        },
        additionalProperties: false
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["cancel_import_operation"],
      _meta: toolMetaBase(OAUTH_SECURITY_SCHEMES)
    }
  ];

  const visibleTools = options?.includeHidden ? tools : tools.filter((tool) => tool.visibility === "public");
  const descriptors = visibleTools.map(stripInternalToolFields);
  return options?.includeOutputSchema ? descriptors : descriptors.map(stripOutputSchemaFromDescriptor);
}

async function callToolImpl(
  req: Request,
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  sessionOverride?: SessionRecord | null
): Promise<ToolResult> {
  const traceId = req.headers.get("x-trace-id") || undefined;
  if (!getTools({ includeHidden: true }).some((tool) => tool.name === name)) {
    return toolErrorResult("Unknown tool: " + name, "UNKNOWN_TOOL");
  }

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
          "get_pulse_setup_guidance",
          "prepare_publish_package",
          "get_account_capabilities",
          "quick_publish_creation",
          "get_publish_readiness",
          "get_runtime_readiness",
          "resume_latest_publish_flow",
          "list_vibecodr_drafts",
          "get_vibecodr_draft",
          "list_my_live_vibes",
          "get_live_vibe",
          "discover_vibes",
          "get_public_post",
          "get_public_profile",
          "search_vibecodr",
          "get_remix_lineage",
          "get_vibe_engagement_summary",
          "get_vibe_share_link",
          "build_share_copy",
          "get_launch_checklist",
          "inspect_social_preview",
          "suggest_post_publish_next_steps",
          "get_engagement_followup_context",
          "update_live_vibe_metadata"
        ],
        recoveryTools: [
          "get_publish_readiness",
          "get_runtime_readiness",
          "resume_latest_publish_flow",
          "explain_operation_failure"
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
    const guidance = buildPulseSetupGuidance({ descriptorSetup: args["descriptorSetup"] });
    return {
      content: [{
        type: "text",
        text: guidance.summary
      }],
      structuredContent: guidance
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
          "get_pulse_setup_guidance",
          "prepare_publish_package",
          "get_account_capabilities",
          "quick_publish_creation",
          "get_publish_readiness",
          "get_runtime_readiness",
          "resume_latest_publish_flow",
          "list_vibecodr_drafts",
          "get_vibecodr_draft",
          "list_my_live_vibes",
          "get_live_vibe",
          "discover_vibes",
          "get_public_post",
          "get_public_profile",
          "search_vibecodr",
          "get_remix_lineage",
          "get_vibe_engagement_summary",
          "get_vibe_share_link",
          "build_share_copy",
          "get_launch_checklist",
          "inspect_social_preview",
          "suggest_post_publish_next_steps",
          "get_engagement_followup_context",
          "update_live_vibe_metadata"
        ],
        recoveryTools: [
          "get_publish_readiness",
          "get_runtime_readiness",
          "resume_latest_publish_flow",
          "explain_operation_failure"
        ]
      }
    };
  }

  if (name === "prepare_publish_package" || name === "validate_creation_payload") {
    return preparePublishPackageResult(args, deps);
  }

  if (name === "discover_vibes") {
    try {
      const limit = parseBoundedIntegerArg(args["limit"], 10, 50);
      const offset = parseOffsetArg(args["offset"]);
      const query = optionalStringArg(args["query"]);
      const vibes = await deps.vibecodr.discoverVibes(
        { limit, offset, ...(query ? { query } : {}) },
        { telemetry: deps.telemetry, traceId }
      );
      return {
        content: [{ type: "text", text: `Retrieved ${vibes.length} public Vibecodr vibes.` }],
        structuredContent: {
          vibes,
          source: query ? "public_discovery_search" : "public_discovery_feed",
          nextAction: vibes.length
            ? "Inspect a public post, profile, or remix lineage before making social recommendations."
            : "Try a more specific search query or inspect a known public post."
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("discover_vibes failed: " + message, "DISCOVER_VIBES_FAILED", message);
    }
  }

  if (name === "get_public_post") {
    try {
      const postId = requiredStringArg(args, "postId");
      const vibe = await deps.vibecodr.getPublicPost(postId, { telemetry: deps.telemetry, traceId });
      const share = buildShareCopyForVibe(vibe);
      return {
        content: [{ type: "text", text: `${vibe.title} is public on Vibecodr.` }],
        structuredContent: {
          vibe,
          context: {
            primaryActions: [
              "Open the live player link.",
              "Inspect remix lineage before describing fork/remix activity."
            ],
            shareCopy: share.shortCopy
          }
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_public_post failed: " + message, "GET_PUBLIC_POST_FAILED", message);
    }
  }

  if (name === "get_public_profile") {
    try {
      const handle = requiredStringArg(args, "handle");
      const profile = await deps.vibecodr.getPublicProfile(handle, { telemetry: deps.telemetry, traceId });
      return {
        content: [{ type: "text", text: `Retrieved public Vibecodr profile @${profile.handle}.` }],
        structuredContent: {
          profile,
          nextAction: "Use search_vibecodr or discover_vibes when you need public post context for this creator."
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_public_profile failed: " + message, "GET_PUBLIC_PROFILE_FAILED", message);
    }
  }

  if (name === "search_vibecodr") {
    try {
      const query = requiredStringArg(args, "query");
      const types = optionalStringArg(args["types"]);
      const limit = parseBoundedIntegerArg(args["limit"], 10, 50);
      const offset = parseOffsetArg(args["offset"]);
      const results = await deps.vibecodr.searchVibecodr(
        { query, ...(types ? { types } : {}), limit, offset },
        { telemetry: deps.telemetry, traceId }
      );
      return {
        content: [{ type: "text", text: `Found ${results.length} public Vibecodr result${results.length === 1 ? "" : "s"}.` }],
        structuredContent: {
          query,
          results,
          nextAction: "Open the most relevant public post, profile, or remix context before making a specific recommendation."
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("search_vibecodr failed: " + message, "SEARCH_VIBECDR_FAILED", message);
    }
  }

  if (name === "get_remix_lineage") {
    try {
      const postId = optionalStringArg(args["postId"]);
      const capsuleId = optionalStringArg(args["capsuleId"]);
      if (!postId && !capsuleId) {
        return toolErrorResult("postId or capsuleId is required.", "MISSING_REMIX_TARGET");
      }
      const lineage = await deps.vibecodr.getRemixLineage(
        { ...(postId ? { postId } : {}), ...(capsuleId ? { capsuleId } : {}) },
        { telemetry: deps.telemetry, traceId }
      );
      return {
        content: [{ type: "text", text: `Retrieved ${lineage.remixes.length} public remix${lineage.remixes.length === 1 ? "" : "es"}.` }],
        structuredContent: {
          lineage,
          nextAction: lineage.remixes.length
            ? "Use the lineage to discuss remix/fork context without exposing source internals."
            : "Mention that no public remixes were found yet."
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_remix_lineage failed: " + message, "GET_REMIX_LINEAGE_FAILED", message);
    }
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

  if (name === "resume_latest_publish_flow") {
    try {
      const limit = parseBoundedIntegerArg(args["limit"], 10, 20);
      return await buildResumeLatestPublishFlowResult(session, deps, traceId, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("resume_latest_publish_flow failed: " + message, "RESUME_LATEST_PUBLISH_FLOW_FAILED", message);
    }
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
        ...(targetStatuses ? { targetStatuses } : {})
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

  if (name === "get_runtime_readiness") {
    try {
      const operationId = String(args["operationId"] || "");
      const postId = String(args["postId"] || "");
      const draftId = String(args["draftId"] || "");
      const capsuleId = typeof args["capsuleId"] === "string" ? args["capsuleId"] : undefined;
      if (!operationId && !postId && !draftId && !capsuleId) {
        return toolErrorResult(
          "Provide operationId, postId, draftId, or capsuleId for runtime readiness. If the user does not know the id, call resume_latest_publish_flow first.",
          "MISSING_RUNTIME_TARGET"
        );
      }

      if (postId) {
        const vibe = await deps.vibecodr.getLiveVibe(
          { userId: session.userId, vibecodrToken: session.vibecodrToken },
          postId,
          { telemetry: deps.telemetry, traceId, userId: session.userId }
        );
        const evidence = [
          "live vibe: " + vibe.title,
          "visibility: " + vibe.visibility,
          "player URL: " + vibe.playerUrl,
          ...(vibe.packageSummary?.runner ? ["runner: " + vibe.packageSummary.runner] : []),
          ...(vibe.packageSummary?.entry ? ["entry: " + vibe.packageSummary.entry] : [])
        ];
        return {
          content: [{ type: "text", text: `${vibe.title} is already live and ready to share.` }],
          structuredContent: {
            state: "ready",
            subject: { type: "live_vibe", id: postId },
            nextAction: "Open or share the live vibe.",
            evidence
          }
        };
      }

      const draftTargetId = draftId || (!operationId && capsuleId ? capsuleId : "");
      if (draftTargetId && !operationId) {
        const draft = await deps.vibecodr.getDraft(
          { userId: session.userId, vibecodrToken: session.vibecodrToken },
          draftTargetId,
          { telemetry: deps.telemetry, traceId, userId: session.userId }
        );
        const summarizedDraft = summarizeDraft(draft);
        if (!summarizedDraft) {
          return toolErrorResult("Draft response could not be summarized safely.", "INVALID_DRAFT_RESPONSE");
        }
        const evidence = [
          "draft: " + (summarizedDraft.title || summarizedDraft.draftId),
          ...(summarizedDraft.status ? ["draft status: " + summarizedDraft.status] : []),
          ...(summarizedDraft.packageSummary?.runner ? ["runner: " + summarizedDraft.packageSummary.runner] : []),
          ...(summarizedDraft.packageSummary?.entry ? ["entry: " + summarizedDraft.packageSummary.entry] : [])
        ];
        return {
          content: [{ type: "text", text: "This draft needs a publish operation before runtime readiness can be proven." }],
          structuredContent: {
            state: "unknown",
            subject: { type: "draft", id: draftTargetId },
            nextAction: "Start or resume a publish flow, then check runtime readiness with the resulting operationId.",
            evidence
          }
        };
      }

      const readiness = await deps.importService.getPublishReadiness(session, operationId, capsuleId, { traceId, endpoint: "/mcp" });
      const latest = readiness.operation.diagnostics.at(-1);
      const failure = translateFailure(latest?.code, readiness.operation.status, latest?.details);
      const failed = readiness.operation.status === "failed" || readiness.operation.status === "compile_failed";
      const published = readiness.operation.status === "published" || readiness.operation.status === "published_with_warnings";
      const state = failed
        ? "blocked"
        : readiness.operation.status === "published_with_warnings"
          ? "degraded"
          : published || readiness.readyToPublish
            ? "ready"
            : "unknown";
      const nextAction = state === "ready"
        ? published
          ? "Open or share the live vibe."
          : "Ask for explicit publish confirmation before making the vibe live."
        : state === "blocked"
          ? failure.nextActions[0] || "Repair the package or retry the guided publish flow."
          : state === "degraded"
            ? "Open the live vibe, then follow up on launch polish or metadata warnings."
            : readiness.recommendedActions[0] || "Wait for the current operation to finish, then check readiness again.";
      const evidence = [
        "operation status: " + readiness.operation.status,
        "current stage: " + readiness.operation.currentStage,
        ...summarizeReadinessChecks(readiness.checks).map((check) => check.level + ": " + check.message)
      ];
      return {
        content: [{ type: "text", text: state === "blocked" ? failure.userMessage : nextAction }],
        structuredContent: {
          state,
          subject: { type: "operation", id: operationId },
          operation: summarizePublicOperation(readiness.operation),
          ...(state === "blocked" ? { blocker: failure.userMessage } : {}),
          nextAction,
          evidence
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_runtime_readiness failed: " + message, "RUNTIME_READINESS_FAILED", message);
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

  if (name === "build_share_copy") {
    try {
      const postId = requiredStringArg(args, "postId");
      const vibe = await deps.vibecodr.getLiveVibe(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      const share = buildShareCopyForVibe(vibe);
      return {
        content: [{ type: "text", text: "Built share copy for the live Vibecodr vibe." }],
        structuredContent: { share }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("build_share_copy failed: " + message, "BUILD_SHARE_COPY_FAILED", message);
    }
  }

  if (name === "get_launch_checklist") {
    try {
      const postId = requiredStringArg(args, "postId");
      const vibe = await deps.vibecodr.getLiveVibe(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      const checklist = buildLaunchChecklistForVibe(vibe);
      return {
        content: [{ type: "text", text: "Built the post-publish launch checklist." }],
        structuredContent: {
          postId: vibe.postId,
          checklist,
          nextAction: checklist.some((item) => item.status === "missing")
            ? "Fix the missing launch polish before broad sharing."
            : "Share the vibe and monitor engagement follow-up."
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_launch_checklist failed: " + message, "GET_LAUNCH_CHECKLIST_FAILED", message);
    }
  }

  if (name === "inspect_social_preview") {
    try {
      const postId = requiredStringArg(args, "postId");
      const vibe = await deps.vibecodr.getLiveVibe(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      const preview = buildSocialPreviewForVibe(vibe);
      return {
        content: [{ type: "text", text: preview.ready ? "The social preview is ready." : "The social preview needs polish." }],
        structuredContent: { preview }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("inspect_social_preview failed: " + message, "INSPECT_SOCIAL_PREVIEW_FAILED", message);
    }
  }

  if (name === "suggest_post_publish_next_steps") {
    try {
      const postId = requiredStringArg(args, "postId");
      const vibe = await deps.vibecodr.getLiveVibe(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      const suggestions = buildPostPublishNextSteps(vibe);
      return {
        content: [{ type: "text", text: "Suggested the next post-publish move for the live vibe." }],
        structuredContent: {
          postId: vibe.postId,
          priority: suggestions.priority,
          nextSteps: suggestions.nextSteps
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("suggest_post_publish_next_steps failed: " + message, "SUGGEST_POST_PUBLISH_NEXT_STEPS_FAILED", message);
    }
  }

  if (name === "get_engagement_followup_context") {
    try {
      const postId = requiredStringArg(args, "postId");
      const engagement = await deps.vibecodr.getVibeEngagementSummary(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        { telemetry: deps.telemetry, traceId, userId: session.userId }
      );
      const followups = buildEngagementFollowups(engagement);
      return {
        content: [{ type: "text", text: engagement.summary }],
        structuredContent: { engagement, followups }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult("get_engagement_followup_context failed: " + message, "GET_ENGAGEMENT_FOLLOWUP_FAILED", message);
    }
  }

  if (name === "update_live_vibe_metadata") {
    try {
      const confirmationRequired = requireConfirmedWrite(name, "updating live vibe metadata", args);
      if (confirmationRequired) return confirmationRequired;
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
      const metadataInput = {
        ...(requestedVisibility ? { visibility: requestedVisibility } : {}),
        ...(coverKey ? { coverKey } : {}),
        ...(parseSeoArg(args["seo"]) ? { seo: parseSeoArg(args["seo"]) } : {})
      };
      const vibe = await deps.vibecodr.updateLiveVibeMetadata(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        postId,
        metadataInput,
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
        structuredContent: { operation: summarizePublicOperation(operation) }
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
      const confirmationRequired = requireConfirmedWrite(name, "publishing this creation as a live vibe", args);
      if (confirmationRequired) return confirmationRequired;
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
    const confirmationRequired = requireConfirmedWrite(name, "publishing this draft capsule as a live vibe", args);
    if (confirmationRequired) return confirmationRequired;
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
    const confirmationRequired = requireConfirmedWrite(name, "canceling this import operation", args);
    if (confirmationRequired) return confirmationRequired;
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
  sessionOverride?: SessionRecord | null
): Promise<ToolResult> {
  return withValidatedStructuredContent(name, await callToolImpl(req, deps, name, args, sessionOverride));
}

