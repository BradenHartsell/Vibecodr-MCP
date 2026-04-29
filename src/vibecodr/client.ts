import type {
  AccountCapabilitiesSummary,
  CoverUsage,
  CurrentUserProfileSummary,
  LiveVibeSummary,
  PublishSeoInput,
  PublishVisibility,
  RemixLineageSummary,
  RunnerType,
  SocialProfileSummary,
  SocialSearchResult,
  VibecodrQuotaSummary,
  VibeEngagementSummary,
  VibeShareSummary,
  VibeClientUserContext
} from "../types.js";
import type { Telemetry } from "../observability/telemetry.js";

export type ImportGithubInput = {
  url: string;
  branch?: string | undefined;
  allowModuleScripts?: boolean | undefined;
  rootHint?: string | undefined;
  async?: boolean | undefined;
};

export type ImportZipInput = {
  fileName: string;
  fileBytes: Uint8Array;
  allowModuleScripts?: boolean | undefined;
  rootHint?: string | undefined;
  async?: boolean | undefined;
};

export type PublishDraftInput = {
  visibility?: PublishVisibility | undefined;
  parentCapsuleId?: string | undefined;
  parentArtifactId?: string | undefined;
};

export type UploadAppCoverInput = {
  contentType: string;
  fileBytes: Uint8Array;
  usage: CoverUsage;
};

export type UpdatePostMetadataInput = {
  coverKey?: string | undefined;
  seo?: PublishSeoInput | undefined;
};

type OwnedCapsuleSummary = {
  id: string;
  title?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  publishedAt?: number | string | null;
  publishState?: string | null;
};

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function fallbackPublicHandle(candidate?: string): string | undefined {
  const normalized = typeof candidate === "string" ? candidate.trim() : "";
  if (!normalized) return undefined;
  return normalized.startsWith("user_") ? undefined : normalized;
}

export function coverUsageForVisibility(visibility?: PublishVisibility): CoverUsage {
  return visibility === "private" ? "standalone" : "app_cover";
}

export type UpstreamRequestMeta = {
  telemetry?: Telemetry | undefined;
  traceId?: string | undefined;
  operationId?: string | undefined;
  sourceType?: string | undefined;
  userId?: string | undefined;
};

export class VibecodrClient {
  private readonly webBase: string;

  constructor(
    private readonly apiBase: string,
    private readonly httpFetch: HttpFetch = fetch
  ) {
    this.webBase = deriveWebBase(apiBase);
  }

  private async req(
    method: string,
    path: string,
    ctx: VibeClientUserContext,
    init?: { headers?: Record<string, string>; body?: BodyInit },
    meta?: UpstreamRequestMeta
  ): Promise<unknown> {
    const startedAt = Date.now();
    const requestInit: RequestInit = {
      method,
      headers: {
        authorization: "Bearer " + ctx.vibecodrToken,
        accept: "application/json",
        ...(meta?.traceId ? { "x-trace-id": meta.traceId } : {}),
        ...(init?.headers || {})
      },
      ...(init?.body !== undefined ? { body: init.body } : {})
    };
    const res = await this.httpFetch(this.apiBase + path, requestInit);
    const text = await res.text();
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    meta?.telemetry?.upstream({
      traceId: meta.traceId,
      operationId: meta.operationId,
      userId: meta.userId || ctx.userId,
      sourceType: meta.sourceType,
      endpoint: path,
      method,
      statusCode: res.status,
      latencyMs: Date.now() - startedAt,
      errorCode: res.ok ? undefined : "UPSTREAM_API_ERROR"
    });

    if (!res.ok) {
      throw Object.assign(new Error("Upstream API error " + res.status), {
        code: "UPSTREAM_API_ERROR",
        status: res.status,
        path,
        data
      });
    }
    return data;
  }

  private async publicReq(method: string, path: string, meta?: UpstreamRequestMeta): Promise<unknown> {
    const startedAt = Date.now();
    const res = await this.httpFetch(this.apiBase + path, {
      method,
      headers: {
        accept: "application/json",
        ...(meta?.traceId ? { "x-trace-id": meta.traceId } : {})
      }
    });
    const text = await res.text();
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    meta?.telemetry?.upstream({
      traceId: meta.traceId,
      endpoint: path,
      method,
      statusCode: res.status,
      latencyMs: Date.now() - startedAt,
      errorCode: res.ok ? undefined : "UPSTREAM_API_ERROR"
    });
    if (!res.ok) {
      throw Object.assign(new Error("Upstream API error " + res.status), {
        code: "UPSTREAM_API_ERROR",
        status: res.status,
        path,
        data
      });
    }
    return data;
  }

  async createEmptyCapsule(
    ctx: VibeClientUserContext,
    input: { title: string; entry: string; runner: RunnerType; idempotencyKey: string },
    meta?: UpstreamRequestMeta
  ): Promise<{ capsuleId: string }> {
    const data = await this.req("POST", "/capsules/empty", ctx, {
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ title: input.title, entry: input.entry, runner: input.runner })
    }, meta) as Record<string, unknown>;
    const capsuleId = typeof data["capsuleId"] === "string" ? data["capsuleId"] : "";
    if (!capsuleId) throw new Error("Missing capsuleId from createEmpty");
    return { capsuleId };
  }

  async putCapsuleFile(
    ctx: VibeClientUserContext,
    capsuleId: string,
    filePath: string,
    content: string,
    meta?: UpstreamRequestMeta
  ): Promise<void> {
    await this.req("PUT", "/capsules/" + encodeURIComponent(capsuleId) + "/files/" + encodeURIComponent(filePath), ctx, {
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: content
    }, meta);
  }

  async compileDraft(ctx: VibeClientUserContext, capsuleId: string, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("POST", "/capsules/" + encodeURIComponent(capsuleId) + "/compile-draft", ctx, {
      headers: { "content-type": "application/json" },
      body: "{}"
    }, meta);
  }

  async publishDraft(
    ctx: VibeClientUserContext,
    capsuleId: string,
    input: PublishDraftInput = {},
    meta?: UpstreamRequestMeta
  ): Promise<unknown> {
    const bodyPayload: Record<string, unknown> = {};
    if (input.visibility) bodyPayload["visibility"] = input.visibility;
    if (input.parentCapsuleId) bodyPayload["parentCapsuleId"] = input.parentCapsuleId;
    if (input.parentArtifactId) bodyPayload["parentArtifactId"] = input.parentArtifactId;
    return this.req("POST", "/capsules/" + encodeURIComponent(capsuleId) + "/publish", ctx, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyPayload)
    }, meta);
  }

  async uploadCover(
    ctx: VibeClientUserContext,
    input: UploadAppCoverInput,
    meta?: UpstreamRequestMeta
  ): Promise<{ key: string; usage?: string }> {
    const bytes = input.fileBytes;
    const normalized = new Uint8Array(bytes.byteLength);
    normalized.set(bytes);
    const data = await this.req("POST", "/covers?usage=" + encodeURIComponent(input.usage), ctx, {
      headers: { "content-type": input.contentType || "application/octet-stream" },
      body: normalized
    }, meta) as Record<string, unknown>;
    const key = typeof data["key"] === "string" ? data["key"] : "";
    if (!key) throw new Error("Missing key from app cover upload");
    const usage = typeof data["usage"] === "string" ? data["usage"] : undefined;
    return { key, ...(usage ? { usage } : {}) };
  }

  async updatePostMetadata(
    ctx: VibeClientUserContext,
    postId: string,
    input: UpdatePostMetadataInput,
    meta?: UpstreamRequestMeta
  ): Promise<unknown> {
    return this.req("PATCH", "/posts/" + encodeURIComponent(postId), ctx, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }, meta);
  }

  async importGithub(ctx: VibeClientUserContext, input: ImportGithubInput, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("POST", "/import/github", ctx, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }, meta);
  }

  async importZip(ctx: VibeClientUserContext, input: ImportZipInput, meta?: UpstreamRequestMeta): Promise<unknown> {
    const form = new FormData();
    const bytes = input.fileBytes;
    const normalized = new Uint8Array(bytes.byteLength);
    normalized.set(bytes);
    const blob = new Blob([normalized], { type: "application/zip" });
    form.append("file", blob, input.fileName);
    if (input.allowModuleScripts) form.append("allowModuleScripts", "true");
    if (input.rootHint) form.append("rootHint", input.rootHint);
    if (input.async) form.append("async", "true");
    return this.req("POST", "/import/zip", ctx, { body: form }, meta);
  }

  async getImportJob(ctx: VibeClientUserContext, jobId: string, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("GET", "/import/jobs/" + encodeURIComponent(jobId), ctx, undefined, meta);
  }

  async cancelImportJob(ctx: VibeClientUserContext, jobId: string, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("POST", "/import/jobs/" + encodeURIComponent(jobId) + "/cancel", ctx, {
      headers: { "content-type": "application/json" },
      body: "{}"
    }, meta);
  }

  async listDrafts(ctx: VibeClientUserContext, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("GET", "/capsules/mine?state=draft", ctx, undefined, meta);
  }

  async getDraft(ctx: VibeClientUserContext, draftId: string, meta?: UpstreamRequestMeta): Promise<unknown> {
    return this.req("GET", "/capsules/" + encodeURIComponent(draftId) + "/files-summary", ctx, undefined, meta);
  }

  async getUserQuota(
    ctx: VibeClientUserContext,
    meta?: UpstreamRequestMeta
  ): Promise<VibecodrQuotaSummary> {
    const data = await this.req("GET", "/user/quota", ctx, undefined, meta) as Record<string, unknown>;
    const limits = readRecord(data["limits"]);
    const features = readRecord(limits["features"]);
    const serverActions = readRecord(limits["serverActions"]);
    const pulses = readRecord(limits["pulses"]);
    const webhookActions = readRecord(limits["webhookActions"]);
    const usage = readRecord(data["usage"]);
    const percentUsed = readRecord(data["percentUsed"]);
    const plan = typeof data["plan"] === "string" ? data["plan"] : "";
    if (!plan) {
      throw Object.assign(new Error("Quota response missing plan"), {
        code: "INVALID_USER_QUOTA_RESPONSE"
      });
    }
    return {
      plan,
      usage: {
        storage: toNumber(usage["storage"]),
        runs: toNumber(usage["runs"]),
        bundleSize: toNumber(usage["bundleSize"]),
        ...(usage["serverActionRuns"] !== undefined ? { serverActionRuns: toNumber(usage["serverActionRuns"]) } : {}),
        ...(usage["serverActionCount"] !== undefined ? { serverActionCount: toNumber(usage["serverActionCount"]) } : {}),
        ...(usage["webhookCalls"] !== undefined ? { webhookCalls: toNumber(usage["webhookCalls"]) } : {}),
        ...(usage["privateVibesUsed"] !== undefined ? { privateVibesUsed: toNumber(usage["privateVibesUsed"]) } : {}),
        ...(usage["privatePulsesUsed"] !== undefined ? { privatePulsesUsed: toNumber(usage["privatePulsesUsed"]) } : {})
      },
      limits: {
        maxStorage: toNumber(limits["maxStorage"]),
        maxRuns: toUnlimitedNumber(limits["maxRuns"]),
        maxPrivateVibes: toUnlimitedNumber(limits["maxPrivateVibes"]),
        maxConnections: toUnlimitedNumber(limits["maxConnections"]),
        serverActions: {
          maxActions: toNumber(serverActions["maxActions"]),
          maxRunsPerMonth: toNumber(serverActions["maxRunsPerMonth"]),
          maxRuntimeMs: toNumber(serverActions["maxRuntimeMs"])
        },
        pulses: {
          maxActions: toNumber(pulses["maxActions"]),
          maxRunsPerMonth: toNumber(pulses["maxRunsPerMonth"]),
          maxRuntimeMs: toNumber(pulses["maxRuntimeMs"]),
          maxPrivatePulses: toUnlimitedNumber(pulses["maxPrivatePulses"]),
          maxSubrequests: toNumber(pulses["maxSubrequests"]),
          maxVanitySubdomains: toNumber(pulses["maxVanitySubdomains"]),
          proxyRateLimit: toNumber(pulses["proxyRateLimit"]),
          secretsProxyOwnerRateLimit: toNumber(pulses["secretsProxyOwnerRateLimit"]),
          secretsProxyPulseRateLimit: toNumber(pulses["secretsProxyPulseRateLimit"])
        },
        webhookActions: {
          maxActions: toNumber(webhookActions["maxActions"]),
          maxCallsPerMonth: toNumber(webhookActions["maxCallsPerMonth"])
        },
        features: {
          customSeo: Boolean(features["customSeo"]),
          serverActionsEnabled: Boolean(features["serverActionsEnabled"]),
          pulsesEnabled: Boolean(features["pulsesEnabled"]),
          webhookActionsEnabled: Boolean(features["webhookActionsEnabled"]),
          embedsUnbranded: Boolean(features["embedsUnbranded"]),
          customDomains: toNumber(features["customDomains"]),
          d1SqlEnabled: Boolean(features["d1SqlEnabled"]),
          secretsStoreEnabled: Boolean(features["secretsStoreEnabled"]),
          canPublishLibraryVibes: Boolean(features["canPublishLibraryVibes"]),
          advancedZipAnalysis: Boolean(features["advancedZipAnalysis"]),
          studioParamsTab: Boolean(features["studioParamsTab"]),
          studioFilesTab: Boolean(features["studioFilesTab"])
        }
      },
      ...(Object.keys(percentUsed).length
        ? {
            percentUsed: {
              storage: toNumber(percentUsed["storage"]),
              runs: toNumber(percentUsed["runs"]),
              ...(percentUsed["bundleSize"] !== undefined ? { bundleSize: toNumber(percentUsed["bundleSize"]) } : {}),
              ...(percentUsed["serverActionRuns"] !== undefined
                ? { serverActionRuns: toNumber(percentUsed["serverActionRuns"]) }
                : {}),
              ...(percentUsed["webhookCalls"] !== undefined ? { webhookCalls: toNumber(percentUsed["webhookCalls"]) } : {})
            }
          }
        : {})
    };
  }

  async getAccountCapabilities(
    ctx: VibeClientUserContext,
    meta?: UpstreamRequestMeta
  ): Promise<AccountCapabilitiesSummary> {
    const quota = await this.getUserQuota(ctx, meta);
    const profile: CurrentUserProfileSummary = {
      id: ctx.userId,
      handle: fallbackPublicHandle(ctx.userHandle) || "connected-account",
      plan: quota.plan,
    };
    const privateOrUnlistedAllowed =
      quota.limits.maxPrivateVibes === "unlimited" || quota.limits.maxPrivateVibes > 0;
    const pulseRunsRemaining =
      quota.limits.pulses.maxRunsPerMonth > 0
        ? Math.max(quota.limits.pulses.maxRunsPerMonth - (quota.usage.serverActionRuns || 0), 0)
        : "unlimited";
    const remainingPulseSlots = Math.max(
      quota.limits.pulses.maxActions - (quota.usage.serverActionCount || 0),
      0
    );
    const remainingWebhookCalls = Math.max(
      quota.limits.webhookActions.maxCallsPerMonth - (quota.usage.webhookCalls || 0),
      0
    );
    const recommendations: string[] = [];
    if (quota.limits.features.customSeo) {
      recommendations.push("Custom SEO is available for polished public launches.");
    } else {
      recommendations.push("Keep launch copy simple unless the user upgrades to unlock custom SEO.");
    }
    if (quota.limits.features.pulsesEnabled) {
      recommendations.push(
        remainingPulseSlots > 0
          ? `Pulses are available. ${remainingPulseSlots} pulse slot${remainingPulseSlots === 1 ? "" : "s"} remain on this plan.`
          : "Pulse slots are full on this plan. Reuse an existing pulse or upgrade before proposing another backend action."
      );
    } else {
      recommendations.push("Do not propose pulse-backed behavior unless the user upgrades to a pulse-enabled plan.");
    }
    return {
      profile,
      quota,
      launchDefaults: {
        visibility: "public",
        shouldOfferCoverGeneration: true,
        shouldOfferCustomSeo: quota.limits.features.customSeo,
        shouldOfferPulseGuidance: quota.limits.features.pulsesEnabled
      },
      features: {
        customSeo: quota.limits.features.customSeo,
        canUsePrivateOrUnlisted: privateOrUnlistedAllowed,
        pulsesEnabled: quota.limits.features.pulsesEnabled,
        serverActionsEnabled: quota.limits.features.serverActionsEnabled,
        webhookActionsEnabled: quota.limits.features.webhookActionsEnabled
      },
      remaining: {
        pulseSlots: remainingPulseSlots,
        pulseRunsThisMonth: pulseRunsRemaining,
        webhookCalls: remainingWebhookCalls,
        ...(quota.limits.maxPrivateVibes !== undefined ? { privateVibes: quota.limits.maxPrivateVibes } : {}),
        ...(quota.limits.pulses.maxPrivatePulses !== undefined
          ? { privatePulses: quota.limits.pulses.maxPrivatePulses }
          : {})
      },
      recommendations
    };
  }

  async listLiveVibes(
    ctx: VibeClientUserContext,
    input: { handle: string; limit?: number; offset?: number },
    meta?: UpstreamRequestMeta
  ): Promise<LiveVibeSummary[]> {
    const params = new URLSearchParams();
    if (typeof input.limit === "number") params.set("limit", String(input.limit));
    if (typeof input.offset === "number") params.set("offset", String(input.offset));
    const query = params.toString();
    const path = "/users/" + encodeURIComponent(input.handle) + "/posts" + (query ? "?" + query : "");
    const data = await this.req("GET", path, ctx, undefined, meta) as { posts?: unknown[] };
    const posts = Array.isArray(data.posts) ? data.posts : [];
    return posts
      .map((post) => this.toLiveVibeSummary(post))
      .filter((post): post is LiveVibeSummary => Boolean(post && post.capsuleId));
  }

  async listMyLiveVibes(
    ctx: VibeClientUserContext,
    input: { limit?: number; offset?: number },
    meta?: UpstreamRequestMeta
  ): Promise<LiveVibeSummary[]> {
    const data = await this.req("GET", "/capsules/mine?state=posted", ctx, undefined, meta) as { capsules?: unknown[] };
    const capsules = Array.isArray(data.capsules)
      ? data.capsules
          .map((item) => this.toOwnedCapsuleSummary(item))
          .filter((item): item is OwnedCapsuleSummary => Boolean(item))
      : [];
    const offset = typeof input.offset === "number" ? Math.max(Math.floor(input.offset), 0) : 0;
    const limit = typeof input.limit === "number" ? Math.min(Math.max(Math.floor(input.limit), 1), 20) : 10;
    const selected = capsules.slice(offset, offset + limit);
    const vibes = await Promise.all(
      selected.map(async (capsule) => {
        const detail = await this.req(
          "GET",
          "/capsules/" + encodeURIComponent(capsule.id) + "/files-summary",
          ctx,
          undefined,
          meta
        ) as Record<string, unknown>;
        const existingPostId = typeof detail["existingPostId"] === "string" ? detail["existingPostId"] : "";
        if (!existingPostId) return this.toFallbackLiveVibeSummary(capsule);
        try {
          return await this.getLiveVibe(ctx, existingPostId, meta);
        } catch {
          return this.toFallbackLiveVibeSummary(capsule, existingPostId);
        }
      })
    );
    return vibes.filter((item): item is LiveVibeSummary => Boolean(item));
  }

  async getLiveVibe(
    ctx: VibeClientUserContext,
    postId: string,
    meta?: UpstreamRequestMeta
  ): Promise<LiveVibeSummary> {
    const data = await this.req("GET", "/posts/" + encodeURIComponent(postId), ctx, undefined, meta) as { post?: unknown };
    const summary = this.toLiveVibeSummary(data.post);
    if (!summary) {
      throw Object.assign(new Error("Live vibe response could not be summarized"), {
        code: "INVALID_LIVE_VIBE_RESPONSE"
      });
    }
    return summary;
  }

  async discoverVibes(
    input: { limit?: number; offset?: number; query?: string },
    meta?: UpstreamRequestMeta
  ): Promise<LiveVibeSummary[]> {
    const params = new URLSearchParams();
    params.set("mode", "latest");
    params.set("surface", "feed");
    if (typeof input.limit === "number") params.set("limit", String(input.limit));
    if (typeof input.offset === "number") params.set("offset", String(input.offset));
    if (input.query?.trim()) params.set("q", input.query.trim());
    const query = params.toString();
    const data = await this.publicReq("GET", "/feed/discover" + (query ? "?" + query : ""), meta);
    return extractCollection(data, ["posts", "items", "feed", "vibes"])
      .map((post) => this.toLiveVibeSummary(post))
      .filter((post): post is LiveVibeSummary => Boolean(post));
  }

  async getPublicPost(postId: string, meta?: UpstreamRequestMeta): Promise<LiveVibeSummary> {
    const data = await this.publicReq("GET", "/posts/" + encodeURIComponent(postId), meta) as Record<string, unknown>;
    const summary = this.toLiveVibeSummary(data["post"] ?? data);
    if (!summary) {
      throw Object.assign(new Error("Public post response could not be summarized"), {
        code: "INVALID_PUBLIC_POST_RESPONSE"
      });
    }
    return summary;
  }

  async getPublicProfile(handle: string, meta?: UpstreamRequestMeta): Promise<SocialProfileSummary> {
    let data: unknown;
    try {
      data = await this.publicReq("GET", "/profile/" + encodeURIComponent(handle), meta);
    } catch {
      data = await this.publicReq("GET", "/users/" + encodeURIComponent(handle), meta);
    }
    const source = readRecord(readRecord(data)["profile"] ?? readRecord(data)["user"] ?? data);
    return this.toSocialProfileSummary(source, handle);
  }

  async searchVibecodr(
    input: { query: string; types?: string; limit?: number; offset?: number },
    meta?: UpstreamRequestMeta
  ): Promise<SocialSearchResult[]> {
    const params = new URLSearchParams({ q: input.query });
    const normalizedTypes = normalizeSearchTypes(input.types);
    if (normalizedTypes) params.set("types", normalizedTypes);
    if (typeof input.limit === "number") params.set("limit", String(input.limit));
    if (typeof input.offset === "number") params.set("offset", String(input.offset));
    const data = await this.publicReq("GET", "/search?" + params.toString(), meta);
    return extractCollection(data, ["results", "items", "posts", "profiles", "tags"])
      .map((item) => this.toSocialSearchResult(item))
      .filter((item): item is SocialSearchResult => Boolean(item));
  }

  async getRemixLineage(
    input: { postId?: string; capsuleId?: string },
    meta?: UpstreamRequestMeta
  ): Promise<RemixLineageSummary> {
    const post = input.postId && !input.capsuleId ? await this.getPublicPost(input.postId, meta) : undefined;
    const capsuleId = input.capsuleId || post?.capsuleId || undefined;
    if (!capsuleId) {
      throw Object.assign(new Error("capsuleId or postId with a capsule is required."), {
        code: "MISSING_REMIX_CAPSULE_ID"
      });
    }
    const data = await this.publicReq("GET", "/capsules/" + encodeURIComponent(capsuleId) + "/remixes", meta);
    return {
      capsuleId,
      ...(input.postId ? { postId: input.postId } : {}),
      remixes: extractCollection(data, ["remixes", "children", "nodes", "capsules"])
        .map((item) => this.toRemixSummary(item))
        .filter((item): item is RemixLineageSummary["remixes"][number] => Boolean(item))
    };
  }

  async getVibeEngagementSummary(
    ctx: VibeClientUserContext,
    postId: string,
    meta?: UpstreamRequestMeta
  ): Promise<VibeEngagementSummary> {
    const vibe = await this.getLiveVibe(ctx, postId, meta);
    const stats = vibe.stats;
    return {
      postId: vibe.postId,
      title: vibe.title,
      visibility: vibe.visibility,
      playerUrl: vibe.playerUrl,
      postUrl: vibe.postUrl,
      stats,
      summary:
        `${vibe.title} has ${stats.runs} runs, ${stats.likes} likes, ${stats.comments} comments, and ${stats.remixes} remixes.`
    };
  }

  async getVibeShareSummary(
    ctx: VibeClientUserContext,
    postId: string,
    meta?: UpstreamRequestMeta
  ): Promise<VibeShareSummary> {
    const vibe = await this.getLiveVibe(ctx, postId, meta);
    return {
      postId: vibe.postId,
      title: vibe.title,
      visibility: vibe.visibility,
      postUrl: vibe.postUrl,
      playerUrl: vibe.playerUrl,
      shareCta:
        vibe.visibility === "public"
          ? "Share the live player link so people can open the vibe immediately."
          : "Share the link directly with people who should see this vibe."
    };
  }

  async updateLiveVibeMetadata(
    ctx: VibeClientUserContext,
    postId: string,
    input: UpdatePostMetadataInput & { visibility?: PublishVisibility | undefined },
    meta?: UpstreamRequestMeta
  ): Promise<LiveVibeSummary> {
    const { visibility, ...metadata } = input;
    const effectiveSeo = metadata.coverKey && metadata.seo && !metadata.seo.imageKey
      ? { ...metadata.seo, imageKey: metadata.coverKey }
      : metadata.seo;
    if (visibility) {
      await this.req("PATCH", "/posts/" + encodeURIComponent(postId) + "/visibility", ctx, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility })
      }, meta);
    }
    if (metadata.coverKey || effectiveSeo) {
      await this.req("PATCH", "/posts/" + encodeURIComponent(postId), ctx, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(metadata.coverKey ? { coverKey: metadata.coverKey } : {}),
          ...(effectiveSeo ? { seo: effectiveSeo } : {})
        })
      }, meta);
    }
    return this.getLiveVibe(ctx, postId, meta);
  }

  private toLiveVibeSummary(raw: unknown): LiveVibeSummary | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const post = raw as Record<string, unknown>;
    const postId = readString(post["id"]) || readString(post["postId"]) || "";
    const title = readString(post["title"]) || readString(post["name"]) || "";
    if (!postId || !title) return null;
    const author = post["author"] && typeof post["author"] === "object" ? post["author"] as Record<string, unknown> : {};
    const capsule = post["capsule"] && typeof post["capsule"] === "object" ? post["capsule"] as Record<string, unknown> : {};
    const stats = post["stats"] && typeof post["stats"] === "object" ? post["stats"] as Record<string, unknown> : {};
    return {
      postId,
      title,
      ...(typeof post["description"] === "string" || post["description"] === null ? { description: post["description"] as string | null } : {}),
      visibility: toVisibility(post["visibility"]),
      ...(typeof author["handle"] === "string" ? { authorHandle: author["handle"] } : {}),
      ...(typeof author["name"] === "string" || author["name"] === null ? { authorName: author["name"] as string | null } : {}),
      ...(typeof post["coverKey"] === "string" || post["coverKey"] === null ? { coverKey: post["coverKey"] as string | null } : {}),
      ...(typeof post["createdAt"] === "number" || typeof post["createdAt"] === "string" ? { createdAt: post["createdAt"] as number | string } : {}),
      playerUrl: this.webBase + "/player/" + encodeURIComponent(postId),
      postUrl: this.webBase + "/post/" + encodeURIComponent(postId),
      ...(typeof capsule["id"] === "string" ? { capsuleId: capsule["id"] } : {}),
      stats: {
        runs: toNumber(stats["runs"] ?? post["runsCount"] ?? post["runs_count"]),
        likes: toNumber(stats["likes"] ?? post["likesCount"] ?? post["likes_count"]),
        comments: toNumber(stats["comments"] ?? post["commentsCount"] ?? post["comments_count"]),
        remixes: toNumber(stats["remixes"] ?? post["remixesCount"] ?? post["remixes_count"]),
        ...(stats["views"] !== undefined ? { views: toNumber(stats["views"]) } : {}),
        ...(stats["embedViews"] !== undefined ? { embedViews: toNumber(stats["embedViews"]) } : {})
      },
      packageSummary: {
        ...(typeof capsule["runner"] === "string" ? { runner: capsule["runner"] } : {}),
        ...(typeof capsule["entry"] === "string" ? { entry: capsule["entry"] } : {}),
        ...(typeof capsule["artifactId"] === "string" || capsule["artifactId"] === null ? { artifactId: capsule["artifactId"] as string | null } : {})
      }
    };
  }

  private toSocialProfileSummary(raw: Record<string, unknown>, fallbackHandle: string): SocialProfileSummary {
    const handle = readString(raw["handle"]) || readString(raw["username"]) || fallbackHandle;
    const name = readString(raw["name"]) || readString(raw["displayName"]);
    const avatarUrl = readString(raw["avatarUrl"]) || readString(raw["imageUrl"]);
    const bio = readString(raw["bio"]) || readString(raw["tagline"]);
    const plan = readString(raw["plan"]);
    const createdAt = raw["createdAt"];
    return {
      id: readString(raw["id"]) || readString(raw["userId"]) || handle,
      handle,
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(bio ? { bio } : {}),
      ...(plan ? { plan } : {}),
      ...(createdAt !== undefined && (typeof createdAt === "number" || typeof createdAt === "string") ? { createdAt } : {}),
      profileUrl: this.webBase + "/profile/" + encodeURIComponent(handle)
    };
  }

  private toSocialSearchResult(raw: unknown): SocialSearchResult | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const type = toSearchType(item["type"] ?? item["entityType"]);
    const id = readString(item["id"]) || readString(item["postId"]) || readString(item["userId"]) || readString(item["tag"]) || "";
    const title = readString(item["title"]) || readString(item["name"]) || readString(item["handle"]) || readString(item["tag"]) || "";
    if (!id || !title) return null;
    const url = this.toPublicWebUrl(readString(item["url"]));
    return {
      type,
      id,
      title,
      ...(url ? { url } : type === "post" ? { url: this.webBase + "/post/" + encodeURIComponent(id) } : {}),
      ...(readString(item["description"]) || readString(item["tagline"]) ? { description: readString(item["description"]) || readString(item["tagline"]) } : {}),
      ...(readString(item["authorHandle"]) || readString(item["handle"]) ? { authorHandle: readString(item["authorHandle"]) || readString(item["handle"]) } : {})
    };
  }

  private toPublicWebUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const webBase = new URL(this.webBase);
      const url = new URL(value, webBase.href.endsWith("/") ? webBase.href : webBase.href + "/");
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === webBase.origin) {
        return url.toString();
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private toRemixSummary(raw: unknown): RemixLineageSummary["remixes"][number] | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const id = readString(item["id"]) || readString(item["capsuleId"]) || readString(item["postId"]) || "";
    if (!id) return null;
    return {
      id,
      ...(readString(item["title"]) || readString(item["name"]) ? { title: readString(item["title"]) || readString(item["name"]) } : {}),
      ...(readString(item["postId"]) ? { postId: readString(item["postId"]) } : {}),
      ...(readString(item["capsuleId"]) || readString(item["id"]) ? { capsuleId: readString(item["capsuleId"]) || readString(item["id"]) } : {}),
      ...(readString(item["authorHandle"]) ? { authorHandle: readString(item["authorHandle"]) } : {}),
      ...(item["createdAt"] !== undefined && (typeof item["createdAt"] === "number" || typeof item["createdAt"] === "string") ? { createdAt: item["createdAt"] } : {})
    };
  }

  private toOwnedCapsuleSummary(raw: unknown): OwnedCapsuleSummary | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const capsule = raw as Record<string, unknown>;
    const id = typeof capsule["id"] === "string" ? capsule["id"] : "";
    if (!id) return null;
    const title = typeof capsule["title"] === "string" && capsule["title"].trim() ? capsule["title"] : null;
    return {
      id,
      ...(title ? { title } : {}),
      ...(typeof capsule["createdAt"] === "number" || typeof capsule["createdAt"] === "string" ? { createdAt: capsule["createdAt"] as number | string } : {}),
      ...(typeof capsule["updatedAt"] === "number" || typeof capsule["updatedAt"] === "string" ? { updatedAt: capsule["updatedAt"] as number | string } : {}),
      ...(typeof capsule["publishedAt"] === "number" || typeof capsule["publishedAt"] === "string" ? { publishedAt: capsule["publishedAt"] as number | string } : {}),
      ...(typeof capsule["publishState"] === "string" ? { publishState: capsule["publishState"] } : {})
    };
  }

  private toFallbackLiveVibeSummary(capsule: OwnedCapsuleSummary, postIdOverride?: string): LiveVibeSummary {
    const postId = postIdOverride || capsule.id;
    const title = capsule.title || "Live vibe";
    return {
      postId,
      title,
      visibility: "public",
      playerUrl: this.webBase + "/player/" + encodeURIComponent(postId),
      postUrl: this.webBase + "/post/" + encodeURIComponent(postId),
      ...(capsule.id ? { capsuleId: capsule.id } : {}),
      ...(capsule.publishedAt ?? capsule.createdAt ? { createdAt: (capsule.publishedAt ?? capsule.createdAt) as number | string } : {}),
      ...(capsule.updatedAt ? { updatedAt: capsule.updatedAt as number | string } : {}),
      stats: {
        runs: 0,
        likes: 0,
        comments: 0,
        remixes: 0
      }
    };
  }
}

function deriveWebBase(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    if (url.hostname === "api.vibecodr.space") {
      return "https://vibecodr.space";
    }
    return url.origin;
  } catch {
    return "https://vibecodr.space";
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractCollection(raw: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  const obj = readRecord(raw);
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
    }
  }
  return [];
}

type PublicSearchApiType = "post" | "user" | "tag";

function normalizeSearchTypes(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const selected: PublicSearchApiType[] = [];
  const unsupported: string[] = [];
  const tokens = value
    .split(/[,\s|]+/)
    .map((token) => token.trim().toLowerCase().replace(/^[@#]+/, ""))
    .filter(Boolean);

  for (const token of tokens) {
    const type = toPublicSearchApiType(token);
    if (type && !selected.includes(type)) selected.push(type);
    if (!type && !unsupported.includes(token)) unsupported.push(token);
  }

  if (selected.length === 0 || unsupported.length > 0) {
    throw Object.assign(
      new Error(
        unsupported.length > 0
          ? `Unsupported search type filter: ${unsupported.join(", ")}. Supported public search types are posts, profiles, and tags.`
          : "Unsupported search type filter. Supported public search types are posts, profiles, and tags."
      ),
      { code: "UNSUPPORTED_SEARCH_TYPES" }
    );
  }
  return selected.join(",");
}

function toPublicSearchApiType(value: string): PublicSearchApiType | undefined {
  if (value === "post" || value === "posts" || value === "vibe" || value === "vibes" || value === "app" || value === "apps" || value === "creation" || value === "creations") {
    return "post";
  }
  if (value === "user" || value === "users" || value === "profile" || value === "profiles" || value === "creator" || value === "creators" || value === "handle" || value === "handles" || value === "person" || value === "people") {
    return "user";
  }
  if (value === "tag" || value === "tags" || value === "hashtag" || value === "hashtags" || value === "topic" || value === "topics") {
    return "tag";
  }
  return undefined;
}

function toSearchType(value: unknown): SocialSearchResult["type"] {
  if (value === "post" || value === "profile" || value === "tag") return value;
  if (value === "user") return "profile";
  return "unknown";
}

function toNumber(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function toUnlimitedNumber(value: unknown): number | "unlimited" {
  if (value === "unlimited") return "unlimited";
  return toNumber(value);
}

function toVisibility(value: unknown): PublishVisibility {
  return value === "unlisted" || value === "private" ? value : "public";
}
