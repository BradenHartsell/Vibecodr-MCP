import {
  jsonResponse,
  htmlResponse,
  readJson,
  inferUserIdFromToken,
  setCookieHeader,
  clearCookieHeader,
  RequestBodyLimitError
} from "./lib/http.js";
import type { AppConfig } from "./config.js";
import { SessionStore } from "./auth/sessionStore.js";
import { OauthStateStore } from "./auth/oauthStateStore.js";
import { resolveRequestSession } from "./auth/requestSession.js";
import type { OperationStorePort } from "./storage/operationStorePort.js";
import type { ImportService } from "./services/importService.js";
import type { VibecodrClient } from "./vibecodr/client.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { oauthStartResponse, oauthCallbackResponse } from "./auth/oauth.js";
import { buildOfficialMcpClientMetadata, OFFICIAL_MCP_CLIENT_METADATA_PATH } from "./auth/officialMcpClient.js";
import {
  AuthorizationCodeStore,
  GenericOauthRequestStateStore,
  corsHeaders,
  handleGatewayAuthorize,
  handleGatewayCallback,
  handleGatewayMetadata,
  handleGatewayRegistration,
  handleGatewayRevoke,
  handleGatewayToken,
  isGatewayOauthStateToken
} from "./auth/mcpOAuthCompat.js";
import { OAuthRefreshStore } from "./auth/oauthRefreshStore.js";
import { SessionRevocationStore } from "./auth/sessionRevocationStore.js";
import { Telemetry } from "./observability/telemetry.js";
import type { KvNamespaceLike } from "./storage/operationStoreKv.js";
import type { SessionRecord } from "./types.js";
import type { AuthorizationCodeCoordinatorNamespaceLike } from "./auth/authorizationCodeCoordinator.js";
import type { CodeModeWorkerLoaderLike } from "./mcp/codeModeRuntime.js";
import {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  readSessionCookie,
  writeSessionCookieName
} from "./auth/sessionCookie.js";

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RouteHandler = (req: Request, url: URL) => Promise<Response>;
type RateLimitScope = "global" | "mcp";
type CloudflareRateLimitBinding = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
};
type RateLimitState = { windowStartMs: number; count: number };
type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSeconds: number;
};

type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation?: string;
  resource_policy_uri?: string;
  resource_tos_uri?: string;
};

export type AppRequestHandler = (req: Request) => Promise<Response>;

export type AppRuntimeDeps = {
  config: AppConfig;
  sessionStore: SessionStore;
  oauthStateStore: OauthStateStore;
  operationStore: OperationStorePort;
  importService: ImportService;
  vibecodr: VibecodrClient;
  telemetry: Telemetry;
  oauthFetch?: HttpFetch;
  vibecodrFetch?: HttpFetch;
  oauthKv?: KvNamespaceLike;
  authorizationCodeCoordinator?: AuthorizationCodeCoordinatorNamespaceLike;
  sessionRevocationStore?: SessionRevocationStore;
  codeModeWorkerLoader?: CodeModeWorkerLoaderLike;
  rateLimiters?: {
    global?: CloudflareRateLimitBinding;
    mcp?: CloudflareRateLimitBinding;
  };
};

const REQUEST_METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

function parseContentLength(req: Request): number | undefined {
  const raw = req.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function normalizeIpv6(ip: string): string {
  const source = (ip.split("%")[0] || ip).toLowerCase();
  const parts = source.split(":");
  const head: string[] = [];
  const tail: string[] = [];
  let hasCompression = false;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    if (part === "") {
      if (!hasCompression) {
        hasCompression = true;
      }
      continue;
    }
    if (!hasCompression) {
      head.push(part);
    } else {
      tail.push(part);
    }
  }

  const missing = Math.max(8 - (head.length + tail.length), 0);
  const expanded = [...head, ...Array(missing).fill("0"), ...tail].slice(0, 8);
  const subnet = expanded.slice(0, 4).map((part) => part.padStart(4, "0")).join(":");
  return subnet + "::/64";
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed) return "unknown";
  if (trimmed.includes(":")) return normalizeIpv6(trimmed);
  return trimmed;
}

function getClientIdentity(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return "ip:" + normalizeIp(cfIp);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return "ip:" + normalizeIp(first);
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return "ip:" + normalizeIp(realIp);
  return "ip:unknown";
}

class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitState>();
  private lastSweepMs = 0;

  constructor(private readonly windowMs: number) {}

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < this.windowMs) return;
    this.lastSweepMs = nowMs;
    for (const [key, state] of this.buckets.entries()) {
      if (state.windowStartMs + this.windowMs * 2 < nowMs) {
        this.buckets.delete(key);
      }
    }
  }

  take(scope: RateLimitScope, clientIdentity: string, limit: number, nowMs = Date.now()): RateLimitDecision {
    this.sweep(nowMs);
    const windowStartMs = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const resetAtMs = windowStartMs + this.windowMs;
    const bucketKey = scope + ":" + clientIdentity;
    const state = this.buckets.get(bucketKey);

    if (!state || state.windowStartMs !== windowStartMs) {
      this.buckets.set(bucketKey, { windowStartMs, count: 1 });
      return {
        allowed: true,
        limit,
        remaining: Math.max(limit - 1, 0),
        resetAtMs,
        retryAfterSeconds: Math.max(Math.ceil((resetAtMs - nowMs) / 1000), 1)
      };
    }

    state.count += 1;
    const allowed = state.count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(limit - Math.min(state.count, limit), 0),
      resetAtMs,
      retryAfterSeconds: Math.max(Math.ceil((resetAtMs - nowMs) / 1000), 1)
    };
  }
}

function jsonErrorResponse(
  status: number,
  traceId: string,
  error: string,
  message: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  return jsonResponse(
    status,
    { error, message, traceId, ...(body || {}) },
    { "x-trace-id": traceId, ...(headers || {}) }
  );
}

function mcpOauthBrowserFailureResponse(): Response {
  return htmlResponse(
    400,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MCP sign-in could not be completed</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #101113;
        color: #f5f5f2;
      }
      main {
        min-height: 100vh;
        box-sizing: border-box;
        display: grid;
        align-content: center;
        max-width: 680px;
        margin: 0 auto;
        padding: 32px 24px;
      }
      h1 {
        margin: 0 0 16px;
        font-size: clamp(28px, 6vw, 44px);
        line-height: 1.05;
        font-weight: 750;
      }
      p {
        margin: 0 0 14px;
        color: #d7d5ce;
        font-size: 17px;
        line-height: 1.6;
      }
      .status {
        width: fit-content;
        margin-bottom: 18px;
        padding: 6px 10px;
        border: 1px solid #55514a;
        border-radius: 6px;
        color: #f2c97d;
        font-size: 13px;
        letter-spacing: 0;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="status">Sign-in expired</div>
      <h1>MCP sign-in could not be completed</h1>
      <p>This sign-in link expired, was already used, or was created for a different browser session.</p>
      <p>Return to your MCP client and start the sign-in flow again. You can close this tab.</p>
    </main>
  </body>
</html>`,
    { "cache-control": "no-store" }
  );
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function allowedMcpOrigins(config: AppConfig): { exact: Set<string>; suffixes: string[] } {
  const exact = new Set<string>();
  try {
    exact.add(new URL(config.appBaseUrl).origin);
  } catch {
    // Ignore malformed app base URL here; config validation handles production URLs.
  }
  exact.add("https://chatgpt.com");
  exact.add("https://chat.openai.com");
  exact.add("https://inspector.modelcontextprotocol.io");
  return {
    exact,
    suffixes: [".oaiusercontent.com"]
  };
}

function buildMcpCorsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400",
    vary: "Origin",
    "cache-control": "no-store"
  };
}

function validateMcpOrigin(req: Request, config: AppConfig): { origin?: string; response?: Response } {
  const originHeader = req.headers.get("origin")?.trim();
  if (!originHeader) return {};
  if (originHeader === "null") {
    return {
      response: jsonResponse(403, { error: "MCP_ORIGIN_FORBIDDEN", message: "Origin header is not allowed." })
    };
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    return {
      response: jsonResponse(403, { error: "MCP_ORIGIN_FORBIDDEN", message: "Origin header is invalid." })
    };
  }
  if (parsedOrigin.protocol !== "https:" && !(parsedOrigin.protocol === "http:" && isLoopbackHostname(parsedOrigin.hostname))) {
    return {
      response: jsonResponse(403, { error: "MCP_ORIGIN_FORBIDDEN", message: "Origin protocol is not allowed." })
    };
  }
  const normalizedOrigin = parsedOrigin.origin;
  const allowed = allowedMcpOrigins(config);
  if (allowed.exact.has(normalizedOrigin) || allowed.suffixes.some((suffix) => parsedOrigin.hostname.endsWith(suffix))) {
    return { origin: normalizedOrigin };
  }
  return {
    response: jsonResponse(403, { error: "MCP_ORIGIN_FORBIDDEN", message: "Origin is not allowed for MCP requests." })
  };
}

function buildProtectedResourceMetadata(
  config: AppConfig,
  resource: string,
  authorizationServerIssuers: string[]
): ProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: Array.from(new Set(authorizationServerIssuers.filter(Boolean))),
    scopes_supported: [],
    bearer_methods_supported: ["header"],
    resource_name: resource.endsWith("/mcp") ? "Vibecodr.Space MCP Server" : "Vibecodr.Space",
    resource_documentation: config.appBaseUrl,
    resource_policy_uri: "https://vibecodr.space/privacy",
    resource_tos_uri: "https://vibecodr.space/terms"
  };
}

async function finalizeResponse(response: Response, traceId: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-trace-id", traceId);
  if (response.status < 400) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  try {
    const body = await response.clone().json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, "traceId")) {
        record["traceId"] = traceId;
      }
      return jsonResponse(response.status, record, headersToRecord(headers));
    }
  } catch {
    // Leave non-JSON bodies unchanged.
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createAppRequestHandler(deps: AppRuntimeDeps): AppRequestHandler {
  const {
    config,
    sessionStore,
    oauthStateStore,
    operationStore,
    importService,
    vibecodr,
    telemetry,
    oauthFetch,
    vibecodrFetch,
    oauthKv,
    authorizationCodeCoordinator,
    sessionRevocationStore: providedSessionRevocationStore,
    codeModeWorkerLoader,
    rateLimiters
  } = deps;

  const normalizedBaseUrl = trimTrailingSlash(config.appBaseUrl);
  const authorizationServerIssuers = [normalizedBaseUrl];
  const rootProtectedResourceMetadata = buildProtectedResourceMetadata(
    config,
    normalizedBaseUrl,
    authorizationServerIssuers
  );
  const mcpProtectedResourceMetadata = buildProtectedResourceMetadata(
    config,
    normalizedBaseUrl + "/mcp",
    authorizationServerIssuers
  );
  const hasWorkerSocketPair = typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function";
  if (hasWorkerSocketPair && config.appBaseUrl.startsWith("https://") && !authorizationCodeCoordinator) {
    throw new Error("AUTH_CODE_COORDINATOR binding is required for production OAuth code redemption.");
  }
  const genericOauthStateStore = new GenericOauthRequestStateStore(config.sessionSigningKey);
  const authorizationCodeStore = new AuthorizationCodeStore(undefined, authorizationCodeCoordinator);
  const refreshGrantStore = oauthKv ? new OAuthRefreshStore(oauthKv, config.sessionSigningKey, authorizationCodeCoordinator) : undefined;
  const sessionRevocationStore = providedSessionRevocationStore || (oauthKv ? new SessionRevocationStore(oauthKv) : undefined);
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitWindowSeconds * 1000);
  const routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = [];

  function register(method: string, pattern: RegExp, handler: RouteHandler): void {
    routes.push({ method, pattern, handler });
  }

  async function getSession(req: Request): Promise<SessionRecord | null> {
    const cookie = req.headers.get("cookie") || "";
    const token = readSessionCookie(cookie);
    if (!token.value) return null;
    const session = sessionStore.getBySigned(token.value);
    if (!session) return null;
    if (sessionRevocationStore && await sessionRevocationStore.isRevoked(session.sessionId)) {
      return null;
    }
    return session;
  }

  register(
    "GET",
    /^\/$/,
    async () =>
      htmlResponse(
        200,
        "<!doctype html><html><body style='font-family:sans-serif;padding:24px'><h1>Vibecodr MCP Gateway</h1><ul><li><a href='/mcp'>MCP endpoint</a></li><li><a href='/auth/start'>OAuth start</a></li><li><a href='/health'>Health</a></li></ul></body></html>"
      )
  );

  register("GET", /^\/health$/, async () => jsonResponse(200, { ok: true, service: "vibecodr-mcp-gateway" }));
  register("GET", /^\/\.well-known\/oauth-protected-resource$/, async () =>
    jsonResponse(200, rootProtectedResourceMetadata, corsHeaders())
  );
  register("GET", new RegExp("^" + OFFICIAL_MCP_CLIENT_METADATA_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), async () =>
    jsonResponse(200, buildOfficialMcpClientMetadata(config), corsHeaders())
  );
  register("GET", /^\/\.well-known\/oauth-protected-resource\/mcp$/, async () =>
    jsonResponse(200, mcpProtectedResourceMetadata, corsHeaders())
  );
  register("GET", /^\/\.well-known\/oauth-authorization-server$/, async () =>
    handleGatewayMetadata(config, oauthFetch)
  );
  register("GET", /^\/\.well-known\/openid-configuration$/, async () =>
    handleGatewayMetadata(config, oauthFetch)
  );
  register("GET", /^\/health\/observability$/, async () => {
    const summary = telemetry.summary();
    return jsonResponse(200, {
      ok: true,
      generatedAt: summary.generatedAt,
      uptimeMs: summary.uptimeMs,
      counters: summary.counters,
      distributions: summary.distributions,
      alerts: summary.alerts,
      alertCount: summary.alerts.length
    });
  });
  register("HEAD", /^\/health$/, async () => new Response(null, { status: 200 }));
  register("HEAD", /^\/\.well-known\/oauth-protected-resource$/, async () => new Response(null, { status: 200, headers: corsHeaders() }));
  register("HEAD", new RegExp("^" + OFFICIAL_MCP_CLIENT_METADATA_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), async () => new Response(null, { status: 200, headers: corsHeaders() }));
  register("HEAD", /^\/\.well-known\/oauth-protected-resource\/mcp$/, async () => new Response(null, { status: 200, headers: corsHeaders() }));
  register("HEAD", /^\/\.well-known\/oauth-authorization-server$/, async () => new Response(null, { status: 200, headers: corsHeaders() }));
  register("HEAD", /^\/\.well-known\/openid-configuration$/, async () => new Response(null, { status: 200, headers: corsHeaders() }));
  register("OPTIONS", /^\/\.well-known\/(oauth-authorization-server|openid-configuration|oauth-protected-resource|oauth-protected-resource\/mcp|oauth-client\/vibecodr-mcp\.json)$/, async () => new Response(null, { status: 204, headers: corsHeaders() }));
  register("OPTIONS", /^\/(register|token|revoke)$/, async () => new Response(null, { status: 204, headers: corsHeaders() }));
  register("GET", /^\/auth\/start$/, async (req, url) =>
    oauthStartResponse(url, config, oauthStateStore, oauthFetch, telemetry, req.headers.get("x-trace-id") || undefined)
  );
  register("GET", /^\/register$/, async () =>
    new Response(null, {
      status: 405,
      headers: {
        allow: "POST, OPTIONS",
        ...corsHeaders()
      }
    })
  );
  register("POST", /^\/register$/, async (req) => handleGatewayRegistration(req, config, config.maxRequestBodyBytes));
  register("GET", /^\/authorize$/, async (_req, url) => handleGatewayAuthorize(url, config, genericOauthStateStore, oauthFetch));
  register("POST", /^\/token$/, async (req) =>
    handleGatewayToken(
      req,
      config,
      authorizationCodeStore,
      refreshGrantStore,
      sessionStore,
      config.maxRequestBodyBytes,
      oauthFetch
    )
  );
  register("POST", /^\/revoke$/, async (req) =>
    handleGatewayRevoke(req, config, refreshGrantStore, config.maxRequestBodyBytes, oauthFetch)
  );
  register("HEAD", /^\/register$/, async () =>
    new Response(null, {
      status: 405,
      headers: {
        allow: "POST, OPTIONS",
        ...corsHeaders()
      }
    })
  );
  register("HEAD", /^\/auth\/start$/, async (req, url) =>
    oauthStartResponse(url, config, oauthStateStore, oauthFetch, telemetry, req.headers.get("x-trace-id") || undefined)
  );

  register(
    "GET",
    /^\/(auth\/callback|oauth_callback)$/,
    async (_req, url) => {
      const traceId = _req.headers.get("x-trace-id") || undefined;
      const state = url.searchParams.get("state") || "";
      const genericResponse = await handleGatewayCallback(
        url,
        config,
        genericOauthStateStore,
        authorizationCodeStore,
        oauthFetch
      );
      if (genericResponse) return genericResponse;
      if (isGatewayOauthStateToken(state)) {
        telemetry.auth({
          traceId,
          event: "mcp_oauth_callback",
          outcome: "failure",
          provider: config.oauth.providerName,
          endpoint: "/auth/callback",
          errorCode: "INVALID_GATEWAY_OAUTH_STATE",
          details: { reason: "expired_replayed_or_invalid_gateway_state" }
        });
        return mcpOauthBrowserFailureResponse();
      }
      return oauthCallbackResponse({
        reqUrl: url,
        cfg: config,
        stateStore: oauthStateStore,
        sessionStore,
        telemetry,
        ...(traceId ? { traceId } : {}),
        ...(oauthFetch ? { oauthFetch } : {}),
        ...(vibecodrFetch ? { vibecodrFetch } : {})
      });
    }
  );

  register("GET", /^\/api\/auth\/session$/, async (req) => {
    const traceId = req.headers.get("x-trace-id") || undefined;
    const resolved = await resolveRequestSession(req, {
      sessionStore,
      sessionRevocationStore,
      telemetry,
      vibecodrApiBase: config.vibecodrApiBase,
      vibecodrFetch
    }, traceId);
    if (!resolved.session) return jsonResponse(200, { authenticated: false });
    return jsonResponse(200, {
      authenticated: true,
      userId: resolved.session.userId,
      expiresAt: resolved.session.expiresAt,
      provider: config.oauth.providerName,
      authMode: resolved.authMode
    });
  });

  register("POST", /^\/api\/auth\/link$/, async (req) => {
    if (!config.allowManualTokenLink) return jsonResponse(404, { error: "Not found" });

    const body = await readJson<{ token?: string; userId?: string }>(req, config.maxRequestBodyBytes);
    const token = body.token?.trim() || "";
    if (!token) return jsonResponse(400, { error: "token is required" });

    const userId = body.userId?.trim() || inferUserIdFromToken(token);
    const issued = sessionStore.issue(userId, token);
    telemetry.auth({
      traceId: req.headers.get("x-trace-id") || undefined,
      event: "manual_token_link",
      outcome: "success",
      provider: config.oauth.providerName,
      userId,
      endpoint: "/api/auth/link"
    });
    return jsonResponse(
      200,
      { ok: true, userId: issued.session.userId, expiresAt: issued.session.expiresAt, mode: "manual_override" },
      {
        "set-cookie": setCookieHeader(writeSessionCookieName(config.cookieSecure), issued.signedToken, 60 * 60 * 12, { secure: config.cookieSecure })
      }
    );
  });

  register("POST", /^\/api\/auth\/logout$/, async (req) => {
    const cookie = req.headers.get("cookie") || "";
    const token = readSessionCookie(cookie);
    const signedToken = token.value;
    const session = signedToken ? sessionStore.getBySigned(signedToken) : null;
    if (session && sessionRevocationStore) {
      await sessionRevocationStore.revoke(session.sessionId, session.expiresAt);
    }
    telemetry.auth({
      traceId: req.headers.get("x-trace-id") || undefined,
      event: "logout",
      outcome: "success",
      provider: config.oauth.providerName,
      userId: session?.userId,
      endpoint: "/api/auth/logout"
    });
    const response = jsonResponse(200, { ok: true });
    response.headers.append("set-cookie", clearCookieHeader(SESSION_COOKIE_NAME, { secure: true }));
    response.headers.append("set-cookie", clearCookieHeader(LEGACY_SESSION_COOKIE_NAME, { secure: config.cookieSecure }));
    return response;
  });

  register("GET", /^\/api\/observability\/summary$/, async (req) => {
    const session = await getSession(req);
    if (!session) return jsonResponse(401, { error: "auth required" });
    return jsonResponse(200, telemetry.summary({ userId: session.userId }));
  });

  register("GET", /^\/api\/operations$/, async (req, url) => {
    const session = await getSession(req);
    if (!session) return jsonResponse(401, { error: "auth required" });
    const limitRaw = Number(url.searchParams.get("limit") || "25");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;
    const operations = await operationStore.listByUser(session.userId, limit);
    const refreshed = await importService.refreshPendingOperations(session, operations, {
      traceId: req.headers.get("x-trace-id") || undefined,
      endpoint: url.pathname
    });
    return jsonResponse(200, { operations: refreshed });
  });

  register("GET", /^\/api\/operations\/([^\/]+)$/, async (req, url) => {
    const session = await getSession(req);
    if (!session) return jsonResponse(401, { error: "auth required" });
    const operationId = url.pathname.split("/")[3] || "";
    const operation = await importService.refreshImportJobStatus(session, operationId, {
      traceId: req.headers.get("x-trace-id") || undefined,
      endpoint: url.pathname
    });
    if (!operation || operation.userId !== session.userId) return jsonResponse(404, { error: "not found" });
    return jsonResponse(200, { operation });
  });

  register("POST", /^\/api\/operations\/([^\/]+)\/cancel$/, async (req, url) => {
    const session = await getSession(req);
    if (!session) return jsonResponse(401, { error: "auth required" });
    const operationId = url.pathname.split("/")[3] || "";
    const operation = await importService.cancelImport(session, operationId, {
      traceId: req.headers.get("x-trace-id") || undefined,
      endpoint: url.pathname
    });
    return jsonResponse(200, { operation });
  });

  register("POST", /^\/mcp$/, async (req) =>
    handleMcpRequest(
      req,
      {
        importService,
        operationStore,
        sessionStore,
        sessionRevocationStore,
        vibecodr,
        telemetry,
        appBaseUrl: config.appBaseUrl,
        vibecodrApiBase: config.vibecodrApiBase,
        vibecodrFetch,
        featureFlags: {
          enableCodexImportPath: config.enableCodexImportPath,
          enableChatGptImportPath: config.enableChatGptImportPath,
          enablePublishFromChatGpt: config.enablePublishFromChatGpt
        },
        codeMode: {
          ...config.codeMode,
          workerLoader: codeModeWorkerLoader
        }
      },
      { maxRequestBodyBytes: config.maxRequestBodyBytes }
    )
  );
  register("OPTIONS", /^\/mcp$/, async (req) => {
    const originCheck = validateMcpOrigin(req, config);
    if (originCheck.response) return originCheck.response;
    const origin = originCheck.origin;
    return new Response(null, {
      status: 204,
      headers: origin ? buildMcpCorsHeaders(origin) : { "cache-control": "no-store" }
    });
  });

  register("GET", /^\/mcp$/, async (req) => {
    const origin = validateMcpOrigin(req, config).origin;
    return new Response(null, {
      status: 405,
      headers: {
        allow: "POST, OPTIONS",
        "cache-control": "no-store",
        ...(origin ? buildMcpCorsHeaders(origin) : {})
      }
    });
  });

  return async function handleRequest(req: Request): Promise<Response> {
    const traceId = crypto.randomUUID();
    const requestStartedAt = Date.now();
    const url = new URL(req.url);
    let validatedMcpOrigin: string | undefined;

    if (url.pathname === "/mcp") {
      const originCheck = validateMcpOrigin(req, config);
      if (originCheck.response) {
        const denied = await finalizeResponse(originCheck.response, traceId);
        telemetry.request({
          traceId,
          method: req.method,
          endpoint: url.pathname,
          statusCode: denied.status,
          latencyMs: Date.now() - requestStartedAt,
          errorCode: "MCP_ORIGIN_FORBIDDEN"
        });
        return denied;
      }
      validatedMcpOrigin = originCheck.origin;
    }

    if (REQUEST_METHODS_WITH_BODY.has(req.method)) {
      const contentLength = parseContentLength(req);
      if (contentLength !== undefined && contentLength > config.maxRequestBodyBytes) {
        telemetry.request({
          traceId,
          method: req.method,
          endpoint: url.pathname,
          statusCode: 413,
          latencyMs: Date.now() - requestStartedAt,
          errorCode: "REQUEST_BODY_TOO_LARGE"
        });
        return jsonErrorResponse(
          413,
          traceId,
          "REQUEST_BODY_TOO_LARGE",
          "Request body exceeds configured limit.",
          { maxBytes: config.maxRequestBodyBytes }
        );
      }
    }

    const scope: RateLimitScope = url.pathname === "/mcp" ? "mcp" : "global";
    const limit = scope === "mcp" ? config.rateLimitMcpRequestsPerWindow : config.rateLimitRequestsPerWindow;
    let isAllowed = true;
    let retryAfterSeconds = config.rateLimitWindowSeconds;
    let limitHeaders: Record<string, string> = {
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": "1",
      "x-ratelimit-reset": String(Math.floor((Date.now() + config.rateLimitWindowSeconds * 1000) / 1000))
    };

    const rateLimiterBinding = scope === "mcp" ? rateLimiters?.mcp : rateLimiters?.global;
    if (rateLimiterBinding) {
      try {
        const session = await getSession(req);
        const actorKey = session?.userId ? "user:" + session.userId : getClientIdentity(req);
        const bindingResult = await rateLimiterBinding.limit({ key: actorKey });
        isAllowed = bindingResult.success;
        retryAfterSeconds = config.rateLimitWindowSeconds;
        limitHeaders = {
          "x-ratelimit-limit": String(limit),
          "x-ratelimit-remaining": bindingResult.success ? "1" : "0",
          "x-ratelimit-reset": String(Math.floor((Date.now() + config.rateLimitWindowSeconds * 1000) / 1000))
        };
      } catch (error) {
        console.error("app.rate_limit_binding_error", {
          traceId,
          scope,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      const fallbackDecision = rateLimiter.take(scope, getClientIdentity(req), limit);
      isAllowed = fallbackDecision.allowed;
      retryAfterSeconds = fallbackDecision.retryAfterSeconds;
      limitHeaders = {
        "x-ratelimit-limit": String(fallbackDecision.limit),
        "x-ratelimit-remaining": String(fallbackDecision.remaining),
        "x-ratelimit-reset": String(Math.floor(fallbackDecision.resetAtMs / 1000))
      };
    }

    if (!isAllowed) {
      const session = await getSession(req);
      telemetry.request({
        traceId,
        method: req.method,
        endpoint: url.pathname,
        statusCode: 429,
        latencyMs: Date.now() - requestStartedAt,
        userId: session?.userId,
        errorCode: "RATE_LIMITED"
      });
      return jsonErrorResponse(
        429,
        traceId,
        "RATE_LIMITED",
        "Too many requests. Retry after the limit window resets.",
        {
          scope,
          retryAfterSeconds,
          limit
        },
        {
          "retry-after": String(retryAfterSeconds),
          ...limitHeaders
        }
      );
    }

    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      const session = await getSession(req);
      telemetry.request({
        traceId,
        method: req.method,
        endpoint: url.pathname,
        statusCode: 404,
        latencyMs: Date.now() - requestStartedAt,
        userId: session?.userId,
        errorCode: "NOT_FOUND"
      });
      return jsonErrorResponse(404, traceId, "NOT_FOUND", "Route not found.");
    }

    try {
      const headersWithTrace = new Headers(req.headers);
      headersWithTrace.set("x-trace-id", traceId);
      const requestWithTrace = new Request(req, { headers: headersWithTrace });
      const session = await getSession(requestWithTrace);
      const response = await route.handler(requestWithTrace, url);
      const finalizedBase = await finalizeResponse(response, traceId);
      const finalized = url.pathname === "/mcp" && validatedMcpOrigin
        ? new Response(finalizedBase.body, {
            status: finalizedBase.status,
            statusText: finalizedBase.statusText,
            headers: {
              ...headersToRecord(finalizedBase.headers),
              ...buildMcpCorsHeaders(validatedMcpOrigin)
            }
          })
        : finalizedBase;
      telemetry.request({
        traceId,
        method: req.method,
        endpoint: url.pathname,
        statusCode: finalized.status,
        latencyMs: Date.now() - requestStartedAt,
        userId: session?.userId
      });
      return finalized;
    } catch (error) {
      if (error instanceof RequestBodyLimitError) {
        const session = await getSession(req);
        telemetry.request({
          traceId,
          method: req.method,
          endpoint: url.pathname,
          statusCode: 413,
          latencyMs: Date.now() - requestStartedAt,
          userId: session?.userId,
          errorCode: "REQUEST_BODY_TOO_LARGE"
        });
        return jsonErrorResponse(
          413,
          traceId,
          "REQUEST_BODY_TOO_LARGE",
          "Request body exceeds configured limit.",
          { maxBytes: config.maxRequestBodyBytes }
        );
      }
      console.error("app.route_error", {
        traceId,
        method: req.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      });
      telemetry.request({
        traceId,
        method: req.method,
        endpoint: url.pathname,
        statusCode: 500,
        latencyMs: Date.now() - requestStartedAt,
        userId: (await getSession(req))?.userId,
        errorCode: "INTERNAL_SERVER_ERROR"
      });
      return jsonErrorResponse(500, traceId, "INTERNAL_SERVER_ERROR", "Route handler failed.");
    }
  };
}
