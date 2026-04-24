import { createHash } from "node:crypto";
import type { SessionStore } from "./sessionStore.js";
import type { Telemetry } from "../observability/telemetry.js";
import type { SessionRecord } from "../types.js";
import type { SessionRevocationStore } from "./sessionRevocationStore.js";
import { exchangeProviderAccessForVibecodr } from "./vibecodrTokenExchange.js";
import { readSessionCookie } from "./sessionCookie.js";

type RequestSessionDeps = {
  sessionStore: SessionStore;
  sessionRevocationStore?: SessionRevocationStore | undefined;
  telemetry: Telemetry;
  vibecodrApiBase: string;
  vibecodrFetch?: typeof fetch | undefined;
};

export type RequestSessionResolution = {
  session: SessionRecord | null;
  authMode: "cookie" | "gateway_bearer" | "oauth_bearer" | null;
};

const bearerSessionCache = new Map<string, SessionRecord>();

function stableTokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function looksLikeGatewaySessionToken(token: string): boolean {
  return token.startsWith("v1.");
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

async function ensureNotRevoked(
  session: SessionRecord | null,
  revocationStore?: SessionRevocationStore
): Promise<SessionRecord | null> {
  if (!session) return null;
  if (!revocationStore) return session;
  return (await revocationStore.isRevoked(session.sessionId)) ? null : session;
}

export async function getSessionFromCookie(
  req: Request,
  store: SessionStore,
  revocationStore?: SessionRevocationStore
): Promise<SessionRecord | null> {
  const cookie = req.headers.get("cookie") || "";
  const token = readSessionCookie(cookie);
  if (!token.value) return null;
  return ensureNotRevoked(store.getBySigned(token.value), revocationStore);
}

export async function getGatewayBearerSession(
  req: Request,
  store: SessionStore,
  revocationStore?: SessionRevocationStore
): Promise<SessionRecord | null> {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) return null;
  return ensureNotRevoked(store.getBySigned(bearerToken), revocationStore);
}

export async function exchangeBearerForSession(
  req: Request,
  deps: RequestSessionDeps,
  traceId?: string
): Promise<SessionRecord | null> {
  const bearerToken = getBearerToken(req);
  if (!bearerToken) return null;

  const cacheKey = stableTokenHash(bearerToken);
  const cached = bearerSessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5_000) {
    const activeCached = await ensureNotRevoked(cached, deps.sessionRevocationStore);
    if (activeCached) return activeCached;
    bearerSessionCache.delete(cacheKey);
    return null;
  }

  let data: Awaited<ReturnType<typeof exchangeProviderAccessForVibecodr>>;
  try {
    data = await exchangeProviderAccessForVibecodr(
      bearerToken,
      deps.vibecodrApiBase,
      deps.vibecodrFetch || fetch,
      traceId
    );
  } catch (error) {
    deps.telemetry.auth({
      traceId,
      event: "mcp_bearer_exchange",
      outcome: "failure",
      provider: "vibecodr",
      endpoint: "/auth/session",
      errorCode: "VIBECDR_CLI_EXCHANGE_FAILED",
      details: {
        error: error instanceof Error ? error.message : String(error),
        ...(typeof (error as { status?: unknown })?.status === "number"
          ? { status: (error as { status: number }).status }
          : {})
      }
    });
    return null;
  }

  if (typeof data.access_token !== "string" || typeof data.user_id !== "string") {
    deps.telemetry.auth({
      traceId,
      event: "mcp_bearer_exchange",
      outcome: "failure",
      provider: "vibecodr",
      endpoint: "/auth/session",
      errorCode: "INVALID_VIBECDR_EXCHANGE_RESPONSE"
    });
    return null;
  }

  const expiresAt = typeof data.expires_at === "number"
    ? data.expires_at * 1000
    : Date.now() + 60 * 60 * 1000;
  const userHandle = typeof data.user_handle === "string" && data.user_handle.trim()
    ? data.user_handle.trim()
    : undefined;
  const session: SessionRecord = {
    sessionId: "oauth_bearer:" + cacheKey.slice(0, 16),
    userId: data.user_id,
    ...(userHandle ? { userHandle } : {}),
    vibecodrToken: data.access_token,
    createdAt: Date.now(),
    expiresAt
  };
  const activeSession = await ensureNotRevoked(session, deps.sessionRevocationStore);
  if (!activeSession) return null;
  bearerSessionCache.set(cacheKey, activeSession);
  deps.telemetry.auth({
    traceId,
    event: "mcp_bearer_exchange",
    outcome: "success",
    provider: "vibecodr",
    userId: activeSession.userId,
    endpoint: "/auth/session"
  });
  return activeSession;
}

export async function resolveRequestSession(
  req: Request,
  deps: RequestSessionDeps,
  traceId?: string
): Promise<RequestSessionResolution> {
  const cookieSession = await getSessionFromCookie(req, deps.sessionStore, deps.sessionRevocationStore);
  if (cookieSession) {
    return { session: cookieSession, authMode: "cookie" };
  }

  const gatewayBearerSession = await getGatewayBearerSession(req, deps.sessionStore, deps.sessionRevocationStore);
  if (gatewayBearerSession) {
    return { session: gatewayBearerSession, authMode: "gateway_bearer" };
  }

  const bearerToken = getBearerToken(req);
  if (bearerToken && looksLikeGatewaySessionToken(bearerToken)) {
    return { session: null, authMode: null };
  }

  const bearerSession = await exchangeBearerForSession(req, deps, traceId);
  if (bearerSession) {
    return { session: bearerSession, authMode: "oauth_bearer" };
  }

  return { session: null, authMode: null };
}
