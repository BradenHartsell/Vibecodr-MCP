import { createHash, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";
import { jsonResponse, setCookieHeader } from "../lib/http.js";
import { OauthStateStore } from "./oauthStateStore.js";
import { SessionStore } from "./sessionStore.js";
import type { Telemetry } from "../observability/telemetry.js";
import { exchangeProviderAccessForVibecodr } from "./vibecodrTokenExchange.js";
import { writeSessionCookieName } from "./sessionCookie.js";

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

type TokenResponse = {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
};

type OAuthEndpoints = {
  authorizationUrl: string;
  tokenUrl: string;
};

type DiscoveryCacheRecord = OAuthEndpoints & { expiresAt: number };

const discoveryCache = new Map<string, DiscoveryCacheRecord>();
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeReturnTo(value: string | null): string {
  const fallback = "/";
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/\r|\n/.test(value)) return fallback;
  return value;
}

async function resolveOAuthEndpoints(cfg: AppConfig, httpFetch: HttpFetch = fetch): Promise<OAuthEndpoints> {
  const explicitAuthorization = cfg.oauth.authorizationUrl.trim();
  const explicitToken = cfg.oauth.tokenUrl.trim();
  if (explicitAuthorization && explicitToken) {
    return { authorizationUrl: explicitAuthorization, tokenUrl: explicitToken };
  }

  const issuer = cfg.oauth.issuerUrl ? trimSlash(cfg.oauth.issuerUrl) : "";
  const discoveryOverride = cfg.oauth.discoveryUrl?.trim() || "";

  if (!issuer && !discoveryOverride) {
    throw new Error(
      "OAuth endpoints not configured. Set OAUTH_AUTHORIZATION_URL and OAUTH_TOKEN_URL, or set OAUTH_ISSUER_URL/OAUTH_DISCOVERY_URL."
    );
  }

  const cacheKey = discoveryOverride + "|" + issuer;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { authorizationUrl: cached.authorizationUrl, tokenUrl: cached.tokenUrl };
  }

  const candidates = [
    discoveryOverride,
    issuer ? issuer + "/.well-known/oauth-authorization-server" : "",
    issuer ? issuer + "/.well-known/openid-configuration" : ""
  ].filter((value, idx, arr) => Boolean(value) && arr.indexOf(value) === idx);

  let lastError = "No discovery URLs attempted";
  for (const discoveryUrl of candidates) {
    try {
      const res = await httpFetch(discoveryUrl, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!res.ok) {
        lastError = "Discovery request failed " + discoveryUrl + " status " + res.status;
        continue;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const authorizationUrl = typeof data["authorization_endpoint"] === "string" ? data["authorization_endpoint"] : "";
      const tokenUrl = typeof data["token_endpoint"] === "string" ? data["token_endpoint"] : "";
      if (!authorizationUrl || !tokenUrl) {
        lastError = "Discovery payload missing authorization_endpoint/token_endpoint at " + discoveryUrl;
        continue;
      }

      discoveryCache.set(cacheKey, {
        authorizationUrl,
        tokenUrl,
        expiresAt: Date.now() + DISCOVERY_CACHE_MS
      });

      return { authorizationUrl, tokenUrl };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error("Unable to resolve OAuth endpoints from discovery. " + lastError);
}

export async function oauthStartResponse(
  reqUrl: URL,
  cfg: AppConfig,
  stateStore: OauthStateStore,
  oauthFetch: HttpFetch = fetch,
  telemetry?: Telemetry,
  traceId?: string
): Promise<Response> {
  if (!cfg.oauth.clientId) {
    telemetry?.auth({
      traceId,
      event: "oauth_start",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/start",
      errorCode: "OAUTH_CLIENT_ID_MISSING"
    });
    return jsonResponse(500, {
      error: "OAuth is not configured",
      missing: {
        OAUTH_CLIENT_ID: !cfg.oauth.clientId
      }
    });
  }

  let endpoints: OAuthEndpoints;
  try {
    endpoints = await resolveOAuthEndpoints(cfg, oauthFetch);
  } catch (error) {
    telemetry?.auth({
      traceId,
      event: "oauth_start",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/start",
      errorCode: "OAUTH_DISCOVERY_FAILED",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    return jsonResponse(500, {
      error: "OAuth discovery failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }

  const returnTo = sanitizeReturnTo(reqUrl.searchParams.get("return_to"));
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const rec = stateStore.create(verifier, returnTo);

  const redirectUri = cfg.oauth.redirectUri || cfg.appBaseUrl + "/auth/callback";
  const auth = new URL(endpoints.authorizationUrl);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", cfg.oauth.clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", cfg.oauth.scopes);
  auth.searchParams.set("state", rec.state);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  if (cfg.oauth.audience) auth.searchParams.set("audience", cfg.oauth.audience);

  telemetry?.auth({
    traceId,
    event: "oauth_start",
    outcome: "challenge",
    provider: cfg.oauth.providerName,
    endpoint: "/auth/start"
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: auth.toString(),
      "cache-control": "no-store"
    }
  });
}

export async function oauthCallbackResponse(args: {
  reqUrl: URL;
  cfg: AppConfig;
  stateStore: OauthStateStore;
  sessionStore: SessionStore;
  oauthFetch?: HttpFetch;
  vibecodrFetch?: HttpFetch;
  telemetry?: Telemetry;
  traceId?: string;
}): Promise<Response> {
  const { reqUrl, cfg, stateStore, sessionStore, oauthFetch = fetch, vibecodrFetch = fetch, telemetry, traceId } = args;
  const error = reqUrl.searchParams.get("error");
  if (error) {
    const desc = reqUrl.searchParams.get("error_description") || "OAuth authorization failed";
    telemetry?.auth({
      traceId,
      event: "oauth_callback",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: error,
      details: { description: desc }
    });
    return new Response(null, {
      status: 302,
      headers: { location: "/?auth_error=" + encodeURIComponent(error + ":" + desc) }
    });
  }

  const code = reqUrl.searchParams.get("code") || "";
  const state = reqUrl.searchParams.get("state") || "";
  if (!code || !state) {
    telemetry?.auth({
      traceId,
      event: "oauth_callback",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "MISSING_CODE_OR_STATE"
    });
    return jsonResponse(400, { error: "Missing code or state" });
  }

  const rec = stateStore.consume(state);
  if (!rec) {
    telemetry?.auth({
      traceId,
      event: "oauth_callback",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "INVALID_OAUTH_STATE"
    });
    return jsonResponse(400, { error: "Invalid or expired OAuth state" });
  }

  let endpoints: OAuthEndpoints;
  try {
    endpoints = await resolveOAuthEndpoints(cfg, oauthFetch);
  } catch (discoveryError) {
    telemetry?.auth({
      traceId,
      event: "oauth_callback",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "OAUTH_DISCOVERY_FAILED",
      details: { error: discoveryError instanceof Error ? discoveryError.message : String(discoveryError) }
    });
    return jsonResponse(500, {
      error: "OAuth discovery failed",
      details: discoveryError instanceof Error ? discoveryError.message : String(discoveryError)
    });
  }

  const redirectUri = cfg.oauth.redirectUri || cfg.appBaseUrl + "/auth/callback";
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUri);
  form.set("client_id", cfg.oauth.clientId);
  form.set("code_verifier", rec.codeVerifier);
  if (cfg.oauth.clientSecret) form.set("client_secret", cfg.oauth.clientSecret);

  const tokenRes = await oauthFetch(endpoints.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: form.toString()
  });

  if (!tokenRes.ok) {
    await tokenRes.text();
    telemetry?.auth({
      traceId,
      event: "oauth_token_exchange",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "OAUTH_TOKEN_EXCHANGE_FAILED",
      details: { status: tokenRes.status }
    });
    return jsonResponse(502, {
      error: "OAuth token exchange failed",
      status: tokenRes.status,
      details: "The OAuth provider returned a non-success token response."
    });
  }

  const tokenData = (await tokenRes.json()) as Partial<TokenResponse>;
  const oauthAccessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!oauthAccessToken) {
    telemetry?.auth({
      traceId,
      event: "oauth_token_exchange",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "OAUTH_ACCESS_TOKEN_MISSING"
    });
    return jsonResponse(502, { error: "OAuth token response missing access_token" });
  }

  let exData;
  try {
    exData = await exchangeProviderAccessForVibecodr(oauthAccessToken, cfg.vibecodrApiBase, vibecodrFetch, traceId);
  } catch (error) {
    telemetry?.auth({
      traceId,
      event: "vibecodr_cli_exchange",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "VIBECDR_CLI_EXCHANGE_FAILED",
      details: error instanceof Error ? { error: error.message } : { error: String(error) }
    });
    return jsonResponse(502, {
      error: "Vibecodr CLI exchange failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }

  const vibecodrToken = typeof exData.access_token === "string" ? exData.access_token : "";
  const userId = typeof exData.user_id === "string" ? exData.user_id : "";
  const userHandle = typeof exData.user_handle === "string" && exData.user_handle.trim()
    ? exData.user_handle.trim()
    : undefined;
  const expiresAtEpoch = typeof exData.expires_at === "number" ? exData.expires_at : undefined;

  if (!vibecodrToken || !userId) {
    telemetry?.auth({
      traceId,
      event: "vibecodr_cli_exchange",
      outcome: "failure",
      provider: cfg.oauth.providerName,
      endpoint: "/auth/callback",
      errorCode: "INVALID_VIBECDR_EXCHANGE_RESPONSE"
    });
    return jsonResponse(502, { error: "Invalid CLI exchange response from Vibecodr" });
  }

  let ttlSec = 60 * 60 * 6;
  if (expiresAtEpoch) {
    const nowSec = Math.floor(Date.now() / 1000);
    const rem = Math.max(60, expiresAtEpoch - nowSec);
    ttlSec = Math.min(ttlSec, rem);
  }

  const { signedToken } = sessionStore.issue(userId, vibecodrToken, ttlSec, userHandle);

  telemetry?.auth({
    traceId,
    event: "oauth_callback",
    outcome: "success",
    provider: cfg.oauth.providerName,
    userId,
    endpoint: "/auth/callback"
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: rec.returnTo || "/",
      "set-cookie": setCookieHeader(writeSessionCookieName(cfg.cookieSecure), signedToken, ttlSec, { secure: cfg.cookieSecure })
    }
  });
}

