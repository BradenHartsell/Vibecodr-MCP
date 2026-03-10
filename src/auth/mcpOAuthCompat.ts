import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { KvNamespaceLike } from "../storage/operationStoreKv.js";
import { OAuthRefreshStore, type RefreshReplayResponse } from "./oauthRefreshStore.js";
import { SessionStore } from "./sessionStore.js";
import { exchangeProviderAccessForVibecodr } from "./vibecodrTokenExchange.js";
import { buildOfficialMcpClientMetadata, isOfficialMcpClientId } from "./officialMcpClient.js";
import {
  AuthorizationCodeCoordinatorClient,
  type AuthorizationCodeCoordinatorNamespaceLike
} from "./authorizationCodeCoordinator.js";
import { readJson, readTextWithLimit, RequestBodyLimitError } from "../lib/http.js";

type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OAuthEndpoints = {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  response_modes_supported?: string[];
  grant_types_supported?: string[];
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  claims_supported?: string[];
  code_challenge_methods_supported?: string[];
};

type MetadataCacheRecord = {
  data: OAuthEndpoints;
  expiresAt: number;
};

type RegisteredClientPayload = {
  redirect_uris: string[];
  client_name?: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  iat: number;
};

export type AuthorizationRequestPayload = {
  nonce: string;
  client_id: string;
  redirect_uri: string;
  client_state: string;
  code_challenge: string;
  requested_scope: string;
  requested_resource?: string;
  clerk_code_verifier: string;
  iat: number;
  exp: number;
};

type AuthorizationCodeRecord = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  requested_scope: string;
  requested_resource?: string;
  vibecodr_access_token: string;
  user_id: string;
  user_handle?: string;
  vibecodr_expires_at?: number;
  provider_refresh_token?: string;
  provider_refresh_expires_at?: number;
  created_at: number;
  expires_at: number;
};

type UpstreamTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  refresh_token_expires_in?: number;
  refresh_expires_in?: number;
};

export type GatewayAuthMetadata = OAuthEndpoints & {
  issuer: string;
  registration_endpoint: string;
  registration_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
};

export type RegisteredClient = Omit<RegisteredClientPayload, "iat"> & {
  client_id: string;
  client_id_issued_at: number;
};

type KnownClient = RegisteredClient | {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
};

const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const metadataCache = new Map<string, MetadataCacheRecord>();

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function sign(signingKey: string, value: string): string {
  return createHmac("sha256", signingKey).update(value).digest("hex");
}

function verifySignature(signingKey: string, value: string, signature: string): boolean {
  const expected = Buffer.from(sign(signingKey, value), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isValidRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function normalizeRedirectUriForComparison(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function matchesRegisteredRedirectUri(requestedUri: string, registeredUri: string): boolean {
  const requested = normalizeRedirectUriForComparison(requestedUri);
  const registered = normalizeRedirectUriForComparison(registeredUri);
  if (!requested || !registered) return false;
  if (requested.hash || registered.hash) return false;
  if (requested.protocol !== registered.protocol) return false;
  if (requested.hostname !== registered.hostname) return false;
  if (requested.pathname !== registered.pathname) return false;
  if (requested.search !== registered.search) return false;
  if (requested.protocol === "http:" && isLoopbackHost(requested.hostname) && isLoopbackHost(registered.hostname)) {
    return true;
  }
  return requested.port === registered.port;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return items.length ? items : fallback;
}

function allowedScopes(config: AppConfig): string[] {
  return Array.from(new Set(config.oauth.scopes.split(/\s+/).map((item) => item.trim()).filter(Boolean)));
}

function gatewayTokenEndpointAuthMethods(config: AppConfig): string[] {
  return config.staticMcpClient.clientId && config.staticMcpClient.clientSecret
    ? ["none", "client_secret_post", "client_secret_basic"]
    : ["none"];
}

function hasStaticClientRegistration(config: AppConfig): boolean {
  return Boolean(config.staticMcpClient.clientId && config.staticMcpClient.redirectUris.length);
}

export function negotiateScope(config: AppConfig, requestedScopeRaw: string): string {
  const allowed = allowedScopes(config);
  if (!requestedScopeRaw.trim()) return allowed.join(" ");
  const requested = requestedScopeRaw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  const granted = requested.filter((scope, index) => allowed.includes(scope) && requested.indexOf(scope) === index);
  return (granted.length ? granted : allowed).join(" ");
}

function clientPrefix(config: AppConfig): string {
  const suffix = createHash("sha256").update("mcp-client:" + config.sessionSigningKey).digest("hex").slice(0, 10);
  return "vc_dcr_" + suffix;
}

function createCodeVerifier(): string {
  return base64UrlEncode(randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function trimDiscoveryUrl(url: string): string {
  return url.trim();
}

function parseUpstreamTokenPayload(text: string): UpstreamTokenPayload {
  try {
    return text ? JSON.parse(text) as UpstreamTokenPayload : {};
  } catch {
    return {};
  }
}

function deriveRefreshTokenExpiry(payload: UpstreamTokenPayload): number | undefined {
  const refreshTtlSeconds = typeof payload.refresh_token_expires_in === "number"
    ? payload.refresh_token_expires_in
    : typeof payload.refresh_expires_in === "number"
      ? payload.refresh_expires_in
      : undefined;
  if (refreshTtlSeconds == null || !Number.isFinite(refreshTtlSeconds) || refreshTtlSeconds <= 0) return undefined;
  return Date.now() + refreshTtlSeconds * 1000;
}

function deriveGatewayTokenTtlSeconds(vibecodrExpiresAt?: number): number {
  const maxTtlSeconds = 60 * 60;
  if (typeof vibecodrExpiresAt !== "number" || !Number.isFinite(vibecodrExpiresAt)) {
    return maxTtlSeconds;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const remainingSeconds = Math.max(vibecodrExpiresAt - nowSeconds, 60);
  return Math.min(remainingSeconds, maxTtlSeconds);
}

function deriveIssuer(config: AppConfig): string | undefined {
  if (config.oauth.issuerUrl) return trimSlash(config.oauth.issuerUrl);
  const discovery = trimDiscoveryUrl(config.oauth.discoveryUrl || "");
  if (discovery) {
    try {
      const parsed = new URL(discovery);
      for (const suffix of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
        if (parsed.pathname.endsWith(suffix)) {
          parsed.pathname = parsed.pathname.slice(0, -suffix.length) || "/";
          return trimSlash(parsed.toString());
        }
      }
    } catch {}
  }
  return undefined;
}

function jsonResponse(status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(headers || {})
    }
  });
}

export async function fetchUpstreamAuthMetadata(config: AppConfig, httpFetch: HttpFetch = fetch): Promise<OAuthEndpoints> {
  const issuer = deriveIssuer(config);
  const discoveryOverride = trimDiscoveryUrl(config.oauth.discoveryUrl || "");
  const cacheKey = [issuer || "", discoveryOverride || "", config.oauth.authorizationUrl || "", config.oauth.tokenUrl || ""].join("|");
  const cached = metadataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const candidates = [
    discoveryOverride,
    issuer ? issuer + "/.well-known/oauth-authorization-server" : "",
    issuer ? issuer + "/.well-known/openid-configuration" : ""
  ].filter((value, index, array) => Boolean(value) && array.indexOf(value) === index);

  let lastError = "No discovery candidates";
  for (const candidate of candidates) {
    try {
      const res = await httpFetch(candidate, { method: "GET", headers: { accept: "application/json" } });
      if (!res.ok) {
        lastError = "status " + res.status + " for " + candidate;
        continue;
      }
      const data = await res.json() as Record<string, unknown>;
      if (typeof data.authorization_endpoint !== "string" || typeof data.token_endpoint !== "string") {
        lastError = "missing authorization/token endpoint in " + candidate;
        continue;
      }
      const parsed: OAuthEndpoints = {
        authorization_endpoint: data.authorization_endpoint,
        token_endpoint: data.token_endpoint,
        revocation_endpoint: typeof data.revocation_endpoint === "string" ? data.revocation_endpoint : undefined,
        introspection_endpoint: typeof data.introspection_endpoint === "string" ? data.introspection_endpoint : undefined,
        userinfo_endpoint: typeof data.userinfo_endpoint === "string" ? data.userinfo_endpoint : undefined,
        jwks_uri: typeof data.jwks_uri === "string" ? data.jwks_uri : undefined,
        scopes_supported: normalizeStringArray(data.scopes_supported, allowedScopes(config)),
        response_types_supported: normalizeStringArray(data.response_types_supported, ["code"]),
        response_modes_supported: normalizeStringArray(data.response_modes_supported, ["query"]),
        grant_types_supported: normalizeStringArray(data.grant_types_supported, ["authorization_code", "refresh_token"]),
        subject_types_supported: normalizeStringArray(data.subject_types_supported, ["public"]),
        id_token_signing_alg_values_supported: normalizeStringArray(data.id_token_signing_alg_values_supported, ["RS256"]),
        token_endpoint_auth_methods_supported: normalizeStringArray(data.token_endpoint_auth_methods_supported, ["none", "client_secret_post"]),
        claims_supported: normalizeStringArray(data.claims_supported, []),
        code_challenge_methods_supported: normalizeStringArray(data.code_challenge_methods_supported, ["S256"])
      };
      metadataCache.set(cacheKey, { data: parsed, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
      return parsed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (config.oauth.authorizationUrl && config.oauth.tokenUrl) {
    const fallback: OAuthEndpoints = {
      authorization_endpoint: config.oauth.authorizationUrl,
      token_endpoint: config.oauth.tokenUrl,
      scopes_supported: allowedScopes(config),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      claims_supported: [],
      code_challenge_methods_supported: ["S256"]
    };
    metadataCache.set(cacheKey, { data: fallback, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
    return fallback;
  }

  throw new Error("Unable to resolve upstream auth metadata. " + lastError);
}

export function buildGatewayAuthMetadata(config: AppConfig, upstream: OAuthEndpoints): GatewayAuthMetadata {
  const base = trimSlash(config.appBaseUrl);
  return {
    issuer: base,
    authorization_endpoint: base + "/authorize",
    token_endpoint: base + "/token",
    registration_endpoint: base + "/register",
    registration_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    revocation_endpoint: base + "/revoke",
    ...(upstream.userinfo_endpoint ? { userinfo_endpoint: upstream.userinfo_endpoint } : {}),
    scopes_supported: allowedScopes(config),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    token_endpoint_auth_methods_supported: gatewayTokenEndpointAuthMethods(config),
    code_challenge_methods_supported: ["S256"]
  };
}

export function corsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,accept",
    "cache-control": "no-store",
    ...(extra || {})
  };
}

export function registerDynamicClient(config: AppConfig, body: unknown): RegisteredClient {
  const allowedGrantTypes = new Set(["authorization_code", "refresh_token"]);
  const raw = typeof body === "object" && body ? body as Record<string, unknown> : {};
  const redirectUris = Array.isArray(raw.redirect_uris)
    ? raw.redirect_uris.filter((item): item is string => typeof item === "string" && isValidRedirectUri(item))
    : [];
  if (!redirectUris.length) {
    throw Object.assign(new Error("redirect_uris must include at least one valid redirect URI"), {
      status: 400,
      error: "invalid_redirect_uri"
    });
  }
  const requestedGrantTypes = normalizeStringArray(raw.grant_types, ["authorization_code"]);
  if (!requestedGrantTypes.includes("authorization_code")) {
    throw Object.assign(new Error("authorization_code grant type is required."), {
      status: 400,
      error: "invalid_client_metadata"
    });
  }
  if (requestedGrantTypes.some((value) => !allowedGrantTypes.has(value))) {
    throw Object.assign(new Error("Only authorization_code and refresh_token grant types are supported."), {
      status: 400,
      error: "invalid_client_metadata"
    });
  }
  const requestedResponseTypes = normalizeStringArray(raw.response_types, ["code"]);
  if (requestedResponseTypes.some((value) => value !== "code")) {
    throw Object.assign(new Error("Only code response type is supported."), {
      status: 400,
      error: "invalid_client_metadata"
    });
  }
  const tokenEndpointAuthMethod = typeof raw.token_endpoint_auth_method === "string" ? raw.token_endpoint_auth_method : "none";
  if (tokenEndpointAuthMethod !== "none") {
    throw Object.assign(new Error("Only public PKCE clients with token_endpoint_auth_method=none are supported."), {
      status: 400,
      error: "invalid_client_metadata"
    });
  }
  const iat = Math.floor(Date.now() / 1000);
  const payload: RegisteredClientPayload = {
    redirect_uris: redirectUris,
    client_name: typeof raw.client_name === "string" && raw.client_name.trim() ? raw.client_name.trim() : undefined,
    grant_types: requestedGrantTypes.filter((value, index) => requestedGrantTypes.indexOf(value) === index),
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    iat
  };
  const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = sign(config.sessionSigningKey, "client:" + encoded);
  const clientId = clientPrefix(config) + "." + encoded + "." + signature;
  return {
    client_id: clientId,
    client_id_issued_at: iat,
    redirect_uris: payload.redirect_uris,
    ...(payload.client_name ? { client_name: payload.client_name } : {}),
    grant_types: payload.grant_types,
    response_types: payload.response_types,
    token_endpoint_auth_method: payload.token_endpoint_auth_method
  };
}

export function buildAuthorizationErrorRedirect(redirectUri: string, params: Record<string, string>): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "cache-control": "no-store"
    }
  });
}

export function parseRegisteredClient(config: AppConfig, clientId: string): RegisteredClient | null {
  const allowedGrantTypes = new Set(["authorization_code", "refresh_token"]);
  const prefix = clientPrefix(config) + ".";
  if (!clientId.startsWith(prefix)) return null;
  const suffix = clientId.slice(prefix.length);
  const parts = suffix.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!verifySignature(config.sessionSigningKey, "client:" + encoded, signature)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as Partial<RegisteredClientPayload>;
    if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.some((uri) => typeof uri !== "string" || !isValidRedirectUri(uri))) return null;
    return {
      client_id: clientId,
      client_id_issued_at: typeof payload.iat === "number" ? payload.iat : Math.floor(Date.now() / 1000),
      redirect_uris: payload.redirect_uris,
      client_name: typeof payload.client_name === "string" ? payload.client_name : undefined,
      grant_types: Array.isArray(payload.grant_types) && payload.grant_types.every((value) => typeof value === "string")
        ? payload.grant_types.filter((value, index, arr) => allowedGrantTypes.has(value) && arr.indexOf(value) === index)
        : ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  } catch {
    return null;
  }
}

function resolveKnownClient(config: AppConfig, clientId: string): KnownClient | null {
  const dynamicClient = parseRegisteredClient(config, clientId);
  if (dynamicClient) return dynamicClient;
  if (isOfficialMcpClientId(config, clientId)) {
    const metadata = buildOfficialMcpClientMetadata(config);
    return {
      client_id: metadata.client_id,
      client_id_issued_at: 0,
      redirect_uris: metadata.redirect_uris,
      client_name: metadata.client_name,
      grant_types: metadata.grant_types,
      response_types: metadata.response_types,
      token_endpoint_auth_method: metadata.token_endpoint_auth_method
    };
  }
  return null;
}

function isStaticClientId(config: AppConfig, clientId: string): boolean {
  return Boolean(hasStaticClientRegistration(config) && clientId === config.staticMcpClient.clientId);
}

function staticClientRequiresSecret(config: AppConfig): boolean {
  return Boolean(hasStaticClientRegistration(config) && config.staticMcpClient.clientSecret);
}

function isAllowedStaticRedirectUri(config: AppConfig, redirectUri: string): boolean {
  return config.staticMcpClient.redirectUris.some((registeredUri) => matchesRegisteredRedirectUri(redirectUri, registeredUri));
}

function isAllowedClientRedirectUri(client: { redirect_uris: string[] }, redirectUri: string): boolean {
  return client.redirect_uris.some((registeredUri) => matchesRegisteredRedirectUri(redirectUri, registeredUri));
}

function parseBasicClientCredentials(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function resolveTokenClientCredentials(req: Request, form: URLSearchParams): {
  clientId: string;
  clientSecret?: string;
} {
  const basic = parseBasicClientCredentials(req.headers.get("authorization"));
  if (basic) {
    return {
      clientId: basic.clientId,
      clientSecret: basic.clientSecret
    };
  }
  const clientId = form.get("client_id") || "";
  const clientSecret = form.get("client_secret") || undefined;
  return { clientId, clientSecret };
}

function validateStaticClientSecret(config: AppConfig, clientSecret: string | undefined): boolean {
  if (!config.staticMcpClient.clientSecret || !clientSecret) return false;
  const expected = Buffer.from(config.staticMcpClient.clientSecret, "utf8");
  const provided = Buffer.from(clientSecret, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export class GenericOauthRequestStateStore {
  private readonly used = new Map<string, number>();

  constructor(private readonly signingKey: string, private readonly ttlMs = 10 * 60 * 1000) {}

  create(args: {
    clientId: string;
    redirectUri: string;
    clientState: string;
    codeChallenge: string;
    requestedScope: string;
    requestedResource?: string;
    clerkCodeVerifier: string;
  }): string {
    this.cleanup();
    const now = Date.now();
    const payload: AuthorizationRequestPayload = {
      nonce: randomUUID(),
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      client_state: args.clientState,
      code_challenge: args.codeChallenge,
      requested_scope: args.requestedScope,
      requested_resource: args.requestedResource,
      clerk_code_verifier: args.clerkCodeVerifier,
      iat: now,
      exp: now + this.ttlMs
    };
    const encoded = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
    const signature = sign(this.signingKey, "generic-state:" + encoded);
    return "vcgs." + encoded + "." + signature;
  }

  consume(stateToken: string): AuthorizationRequestPayload | null {
    this.cleanup();
    if (!stateToken.startsWith("vcgs.")) return null;
    const [, encoded, signature] = stateToken.split(".");
    if (!encoded || !signature) return null;
    if (!verifySignature(this.signingKey, "generic-state:" + encoded, signature)) return null;
    let payload: Partial<AuthorizationRequestPayload>;
    try {
      payload = JSON.parse(base64UrlDecode(encoded).toString("utf8")) as Partial<AuthorizationRequestPayload>;
    } catch {
      return null;
    }
    if (
      typeof payload.nonce !== "string" ||
      typeof payload.client_id !== "string" ||
      typeof payload.redirect_uri !== "string" ||
      typeof payload.client_state !== "string" ||
      typeof payload.code_challenge !== "string" ||
      typeof payload.requested_scope !== "string" ||
      typeof payload.clerk_code_verifier !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp < Date.now()) return null;
    if (this.used.has(payload.nonce)) return null;
    this.used.set(payload.nonce, payload.exp);
    return payload as AuthorizationRequestPayload;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.used.entries()) {
      if (exp < now) this.used.delete(nonce);
    }
  }
}

export class AuthorizationCodeStore {
  private readonly mem = new Map<string, AuthorizationCodeRecord>();
  private readonly coordinator?: AuthorizationCodeCoordinatorClient<AuthorizationCodeRecord>;
  private readonly inflightConsumes = new Map<string, Promise<AuthorizationCodeRecord | null>>();

  constructor(
    private readonly kv?: KvNamespaceLike,
    coordinatorNamespace?: AuthorizationCodeCoordinatorNamespaceLike,
    private readonly ttlMs = 2 * 60 * 1000
  ) {
    this.coordinator = coordinatorNamespace
      ? new AuthorizationCodeCoordinatorClient<AuthorizationCodeRecord>(coordinatorNamespace)
      : undefined;
  }

  private key(code: string): string {
    return "oauth:code:" + code;
  }

  private async put(code: string, record: AuthorizationCodeRecord): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.issue(code, record);
      return;
    }
    if (this.kv) {
      if (typeof this.kv.put === "function") {
        await this.kv.put(this.key(code), JSON.stringify(record), { expirationTtl: Math.max(Math.ceil(this.ttlMs / 1000), 60) });
      }
      return;
    }
    this.mem.set(code, record);
  }

  private async delete(code: string): Promise<void> {
    if (this.kv && typeof this.kv.delete === "function") {
      await this.kv.delete(this.key(code));
      return;
    }
    this.mem.delete(code);
  }

  async issue(record: Omit<AuthorizationCodeRecord, "created_at" | "expires_at">): Promise<string> {
    const code = "vc_code_" + randomUUID().replace(/-/g, "");
    const stored: AuthorizationCodeRecord = {
      ...record,
      created_at: Date.now(),
      expires_at: Date.now() + this.ttlMs
    };
    await this.put(code, stored);
    return code;
  }

  async consume(code: string): Promise<AuthorizationCodeRecord | null> {
    if (this.coordinator) {
      const current = await this.coordinator.consume(code);
      if (!current || current.expires_at < Date.now()) return null;
      return current;
    }
    if (!this.kv) {
      const current = this.mem.get(code) || null;
      if (!current) return null;
      this.mem.delete(code);
      if (current.expires_at < Date.now()) return null;
      return current;
    }
    const existing = this.inflightConsumes.get(code);
    if (existing) return existing;
    const consumePromise = (async () => {
      const current = await this.read(code);
      if (!current) return null;
      await this.delete(code);
      if (current.expires_at < Date.now()) return null;
      return current;
    })();
    this.inflightConsumes.set(code, consumePromise);
    try {
      return await consumePromise;
    } finally {
      this.inflightConsumes.delete(code);
    }
  }

  private async read(code: string): Promise<AuthorizationCodeRecord | null> {
    if (this.kv) {
      const raw = await this.kv.get(this.key(code), "text");
      if (!raw || typeof raw !== "string") return null;
      try {
        return JSON.parse(raw) as AuthorizationCodeRecord;
      } catch {
        return null;
      }
    }
    return this.mem.get(code) || null;
  }
}

export function isPkceS256(value: string | null): boolean {
  return !value || value === "S256";
}

function oauthError(status: number, error: string, description: string, headers?: Record<string, string>): Response {
  return jsonResponse(status, { error, error_description: description }, corsHeaders(headers));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitRefreshLeader(
  refreshStore: OAuthRefreshStore,
  refreshToken: string
): Promise<
  | { kind: "leader" }
  | { kind: "replay"; response: RefreshReplayResponse }
  | { kind: "timed_out" }
> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await refreshStore.beginRefresh(refreshToken);
    if (state.state === "leader") return { kind: "leader" };
    if (state.state === "replay") return { kind: "replay", response: state.response };
    await delay(50);
  }
  return { kind: "timed_out" };
}

export async function handleGatewayMetadata(
  config: AppConfig,
  httpFetch: HttpFetch = fetch
): Promise<Response> {
  const upstream = await fetchUpstreamAuthMetadata(config, httpFetch);
  return jsonResponse(200, buildGatewayAuthMetadata(config, upstream), corsHeaders());
}

export async function handleGatewayRegistration(
  req: Request,
  config: AppConfig,
  maxRequestBodyBytes: number
): Promise<Response> {
  let body: unknown = {};
  try {
    body = await readJson(req, maxRequestBodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      return oauthError(413, "invalid_request", "Request body exceeds configured limit.");
    }
    body = {};
  }
  try {
    const client = registerDynamicClient(config, body);
    return jsonResponse(201, client as unknown as Record<string, unknown>, corsHeaders());
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 400;
    const code = typeof (error as { error?: unknown })?.error === "string" ? (error as { error: string }).error : "invalid_client_metadata";
    return oauthError(status, code, error instanceof Error ? error.message : String(error));
  }
}

export async function handleGatewayAuthorize(
  reqUrl: URL,
  config: AppConfig,
  stateStore: GenericOauthRequestStateStore,
  httpFetch: HttpFetch = fetch
): Promise<Response> {
  const responseType = reqUrl.searchParams.get("response_type");
  const clientId = reqUrl.searchParams.get("client_id") || "";
  const redirectUri = reqUrl.searchParams.get("redirect_uri") || "";
  const clientState = reqUrl.searchParams.get("state") || "";
  const codeChallenge = reqUrl.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = reqUrl.searchParams.get("code_challenge_method");
  const scope = negotiateScope(config, reqUrl.searchParams.get("scope") || "");
  const resource = reqUrl.searchParams.get("resource") || undefined;

  if (responseType !== "code") return oauthError(400, "unsupported_response_type", "Only response_type=code is supported.");
  const client = resolveKnownClient(config, clientId);
  const staticClient = isStaticClientId(config, clientId);
  if (!client && !staticClient) return oauthError(400, "invalid_client", "Unknown client_id.");
  if (client && !isAllowedClientRedirectUri(client, redirectUri)) return oauthError(400, "invalid_request", "redirect_uri does not match the registered client.");
  if (staticClient && !isAllowedStaticRedirectUri(config, redirectUri)) {
    return oauthError(400, "invalid_request", "redirect_uri does not match the registered client.");
  }
  if (!codeChallenge || !isPkceS256(codeChallengeMethod)) return oauthError(400, "invalid_request", "A PKCE S256 code_challenge is required.");
  if (!clientState) return oauthError(400, "invalid_request", "state is required.");

  const upstream = await fetchUpstreamAuthMetadata(config, httpFetch);
  const clerkVerifier = createCodeVerifier();
  const genericState = stateStore.create({
    clientId,
    redirectUri,
    clientState,
    codeChallenge,
    requestedScope: scope,
    requestedResource: resource,
    clerkCodeVerifier: clerkVerifier
  });

  const redirectUriToClerk = config.oauth.redirectUri || trimSlash(config.appBaseUrl) + "/auth/callback";
  const authUrl = new URL(upstream.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.oauth.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriToClerk);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", genericState);
  authUrl.searchParams.set("code_challenge", createCodeChallenge(clerkVerifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (config.oauth.audience) authUrl.searchParams.set("audience", config.oauth.audience);

  return new Response(null, {
    status: 302,
    headers: {
      location: authUrl.toString(),
      "cache-control": "no-store"
    }
  });
}

export async function handleGatewayCallback(
  reqUrl: URL,
  config: AppConfig,
  stateStore: GenericOauthRequestStateStore,
  codeStore: AuthorizationCodeStore,
  httpFetch: HttpFetch = fetch
): Promise<Response | null> {
  const state = reqUrl.searchParams.get("state") || "";
  const payload = stateStore.consume(state);
  if (!payload) return null;

  const error = reqUrl.searchParams.get("error");
  if (error) {
    const desc = reqUrl.searchParams.get("error_description") || "OAuth authorization failed";
    return buildAuthorizationErrorRedirect(payload.redirect_uri, {
      error,
      error_description: desc,
      state: payload.client_state
    });
  }

  const code = reqUrl.searchParams.get("code") || "";
  if (!code) {
    return buildAuthorizationErrorRedirect(payload.redirect_uri, {
      error: "invalid_request",
      error_description: "Missing authorization code",
      state: payload.client_state
    });
  }

  const upstream = await fetchUpstreamAuthMetadata(config, httpFetch);
  const redirectUriToClerk = config.oauth.redirectUri || trimSlash(config.appBaseUrl) + "/auth/callback";
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", code);
  form.set("redirect_uri", redirectUriToClerk);
  form.set("client_id", config.oauth.clientId);
  form.set("code_verifier", payload.clerk_code_verifier);
  if (config.oauth.clientSecret) form.set("client_secret", config.oauth.clientSecret);

  const tokenRes = await httpFetch(upstream.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: form.toString()
  });

  const tokenText = await tokenRes.text();
  const tokenJson = parseUpstreamTokenPayload(tokenText);

  if (!tokenRes.ok || typeof tokenJson.access_token !== "string") {
    return buildAuthorizationErrorRedirect(payload.redirect_uri, {
      error: "server_error",
      error_description: "Token exchange with identity provider failed",
      state: payload.client_state
    });
  }

  let vibecodrToken;
  try {
    vibecodrToken = await exchangeProviderAccessForVibecodr(
      tokenJson.access_token,
      config.vibecodrApiBase,
      httpFetch,
      reqUrl.searchParams.get("traceId") || undefined
    );
  } catch {
    return buildAuthorizationErrorRedirect(payload.redirect_uri, {
      error: "server_error",
      error_description: "Token exchange with Vibecodr failed",
      state: payload.client_state
    });
  }

  const issuedCode = await codeStore.issue({
    client_id: payload.client_id,
    redirect_uri: payload.redirect_uri,
    code_challenge: payload.code_challenge,
    requested_scope: payload.requested_scope,
    requested_resource: payload.requested_resource,
    vibecodr_access_token: vibecodrToken.access_token!,
    user_id: vibecodrToken.user_id!,
    ...(vibecodrToken.user_handle ? { user_handle: vibecodrToken.user_handle } : {}),
    ...(typeof vibecodrToken.expires_at === "number" ? { vibecodr_expires_at: vibecodrToken.expires_at } : {}),
    provider_refresh_token: typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : undefined,
    provider_refresh_expires_at: deriveRefreshTokenExpiry(tokenJson),
  });

  const redirect = new URL(payload.redirect_uri);
  redirect.searchParams.set("code", issuedCode);
  redirect.searchParams.set("state", payload.client_state);
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect.toString(),
      "cache-control": "no-store"
    }
  });
}

export async function handleGatewayToken(
  req: Request,
  config: AppConfig,
  codeStore: AuthorizationCodeStore,
  refreshStore: OAuthRefreshStore | undefined,
  sessionStore: SessionStore,
  maxRequestBodyBytes: number,
  httpFetch: HttpFetch = fetch
): Promise<Response> {
  let bodyText = "";
  try {
    bodyText = await readTextWithLimit(req, maxRequestBodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      return oauthError(413, "invalid_request", "Request body exceeds configured limit.");
    }
    throw error;
  }
  const form = new URLSearchParams(bodyText);
  const grantType = form.get("grant_type") || "";
  const upstream = await fetchUpstreamAuthMetadata(config, httpFetch);

  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const { clientId, clientSecret } = resolveTokenClientCredentials(req, form);
    const redirectUri = form.get("redirect_uri") || "";
    const codeVerifier = form.get("code_verifier") || "";

    const client = resolveKnownClient(config, clientId);
    const staticClient = isStaticClientId(config, clientId);
    if (!client && !staticClient) return oauthError(401, "invalid_client", "Unknown client_id.");
    if (staticClient && staticClientRequiresSecret(config) && !validateStaticClientSecret(config, clientSecret)) {
      return oauthError(401, "invalid_client", "Client authentication failed.");
    }
    if (client && !isAllowedClientRedirectUri(client, redirectUri)) return oauthError(400, "invalid_grant", "redirect_uri does not match the registered client.");
    if (staticClient && !isAllowedStaticRedirectUri(config, redirectUri)) {
      return oauthError(400, "invalid_grant", "redirect_uri does not match the registered client.");
    }
    const record = await codeStore.consume(code);
    if (!record) return oauthError(400, "invalid_grant", "Authorization code is invalid or expired.");
    if (record.client_id !== clientId || record.redirect_uri !== redirectUri) return oauthError(400, "invalid_grant", "Authorization code does not match the client.");
    const verifierChallenge = createCodeChallenge(codeVerifier);
    if (verifierChallenge !== record.code_challenge) return oauthError(400, "invalid_grant", "code_verifier did not satisfy the PKCE challenge.");
    let vibecodrAccessToken = record.vibecodr_access_token;
    let userId = record.user_id;
    let userHandle = record.user_handle;
    let vibecodrExpiresAt = record.vibecodr_expires_at;

    if (!vibecodrAccessToken || !userId) {
      const legacyRecord = record as AuthorizationCodeRecord & { access_token?: string };
      if (!legacyRecord.access_token) {
        return oauthError(400, "invalid_grant", "Authorization code does not contain an access token.");
      }
      try {
        const exchanged = await exchangeProviderAccessForVibecodr(
          legacyRecord.access_token,
          config.vibecodrApiBase,
          httpFetch,
          req.headers.get("x-trace-id") || undefined
        );
        vibecodrAccessToken = exchanged.access_token!;
        userId = exchanged.user_id!;
        userHandle = exchanged.user_handle;
        vibecodrExpiresAt = exchanged.expires_at;
      } catch {
        return oauthError(502, "server_error", "Token exchange with Vibecodr failed.");
      }
    }

    const issued = sessionStore.issue(
      userId,
      vibecodrAccessToken,
      deriveGatewayTokenTtlSeconds(vibecodrExpiresAt),
      userHandle
    );
    const refreshToken = refreshStore && record.provider_refresh_token
      ? await refreshStore.issue({
          client_id: record.client_id,
          provider_refresh_token: record.provider_refresh_token,
          requested_scope: record.requested_scope,
          requested_resource: record.requested_resource,
          provider_refresh_expires_at: record.provider_refresh_expires_at
        })
      : undefined;

    return jsonResponse(200, {
      access_token: issued.signedToken,
      token_type: "Bearer",
      expires_in: Math.max(Math.floor((issued.session.expiresAt - Date.now()) / 1000), 60),
      scope: record.requested_scope,
      ...(refreshToken ? { refresh_token: refreshToken } : {})
    }, corsHeaders({ "pragma": "no-cache" }));
  }

  if (grantType === "refresh_token") {
    if (!refreshStore) return oauthError(503, "server_error", "Refresh token support is unavailable.");
    const refreshToken = form.get("refresh_token") || "";
    if (!refreshToken) return oauthError(400, "invalid_request", "refresh_token is required.");
    const refreshState = await awaitRefreshLeader(refreshStore, refreshToken);
    if (refreshState.kind === "replay") {
      const { clientId: requestedClientId, clientSecret } = resolveTokenClientCredentials(req, form);
      const replayClientId = requestedClientId || refreshState.response.client_id;
      if (replayClientId !== refreshState.response.client_id) {
        return oauthError(400, "invalid_grant", "Refresh token does not match the client.");
      }
      const replayClient = resolveKnownClient(config, replayClientId);
      const replayStaticClient = isStaticClientId(config, replayClientId);
      if (!replayClient && !replayStaticClient) return oauthError(401, "invalid_client", "Unknown client_id.");
      if (replayStaticClient && staticClientRequiresSecret(config) && !validateStaticClientSecret(config, clientSecret)) {
        return oauthError(401, "invalid_client", "Client authentication failed.");
      }
      return jsonResponse(200, {
        access_token: refreshState.response.access_token,
        token_type: refreshState.response.token_type,
        expires_in: refreshState.response.expires_in,
        scope: refreshState.response.scope,
        ...(refreshState.response.refresh_token ? { refresh_token: refreshState.response.refresh_token } : {})
      }, corsHeaders({ "pragma": "no-cache" }));
    }
    if (refreshState.kind === "timed_out") {
      return oauthError(503, "temporarily_unavailable", "Refresh retry is already in progress. Retry once.");
    }

    const grant = await refreshStore.get(refreshToken);
    if (!grant) {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(400, "invalid_grant", "Refresh token is invalid or expired.");
    }

    const { clientId: requestedClientId, clientSecret } = resolveTokenClientCredentials(req, form);
    const clientId = requestedClientId || grant.client_id;
    if (clientId !== grant.client_id) {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(400, "invalid_grant", "Refresh token does not match the client.");
    }
    const client = resolveKnownClient(config, clientId);
    const staticClient = isStaticClientId(config, clientId);
    if (!client && !staticClient) {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(401, "invalid_client", "Unknown client_id.");
    }
    if (staticClient && staticClientRequiresSecret(config) && !validateStaticClientSecret(config, clientSecret)) {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(401, "invalid_client", "Client authentication failed.");
    }

    const upstreamForm = new URLSearchParams();
    upstreamForm.set("grant_type", "refresh_token");
    upstreamForm.set("refresh_token", grant.provider_refresh_token);
    upstreamForm.set("client_id", config.oauth.clientId);
    if (config.oauth.clientSecret) upstreamForm.set("client_secret", config.oauth.clientSecret);

    const tokenRes = await httpFetch(upstream.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: upstreamForm.toString()
    });

    const tokenText = await tokenRes.text();
    const tokenJson = parseUpstreamTokenPayload(tokenText);
    if (!tokenRes.ok) {
      if (tokenJson.error === "invalid_grant") {
        await refreshStore.revoke(refreshToken);
        await refreshStore.failRefresh(refreshToken);
        return oauthError(400, "invalid_grant", "Refresh token is invalid or expired.");
      }
      await refreshStore.failRefresh(refreshToken);
      return oauthError(502, "server_error", "Refresh token exchange with identity provider failed.");
    }
    if (typeof tokenJson.access_token !== "string") {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(502, "server_error", "Refreshed token response missing access_token.");
    }

    let vibecodrToken;
    try {
      vibecodrToken = await exchangeProviderAccessForVibecodr(
        tokenJson.access_token,
        config.vibecodrApiBase,
        httpFetch,
        req.headers.get("x-trace-id") || undefined
      );
    } catch {
      await refreshStore.failRefresh(refreshToken);
      return oauthError(502, "server_error", "Token exchange with Vibecodr failed.");
    }

    const rotatedRefreshToken = await refreshStore.replace(refreshToken, {
      client_id: grant.client_id,
      provider_refresh_token: typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : grant.provider_refresh_token,
      requested_scope: typeof tokenJson.scope === "string" ? tokenJson.scope : grant.requested_scope,
      requested_resource: grant.requested_resource,
      provider_refresh_expires_at: deriveRefreshTokenExpiry(tokenJson) || grant.provider_refresh_expires_at
    });

    const issued = sessionStore.issue(
      vibecodrToken.user_id!,
      vibecodrToken.access_token!,
      deriveGatewayTokenTtlSeconds(vibecodrToken.expires_at),
      vibecodrToken.user_handle
    );

    const refreshResponse: RefreshReplayResponse = {
      client_id: grant.client_id,
      access_token: issued.signedToken,
      token_type: "Bearer",
      expires_in: Math.max(Math.floor((issued.session.expiresAt - Date.now()) / 1000), 60),
      scope: typeof tokenJson.scope === "string" ? tokenJson.scope : grant.requested_scope,
      ...(rotatedRefreshToken ? { refresh_token: rotatedRefreshToken } : {})
    };
    await refreshStore.completeRefresh(refreshToken, refreshResponse);

    return jsonResponse(200, {
      access_token: issued.signedToken,
      token_type: "Bearer",
      expires_in: Math.max(Math.floor((issued.session.expiresAt - Date.now()) / 1000), 60),
      ...(typeof tokenJson.scope === "string" ? { scope: tokenJson.scope } : { scope: grant.requested_scope }),
      ...(rotatedRefreshToken ? { refresh_token: rotatedRefreshToken } : {})
    }, corsHeaders({ "pragma": "no-cache" }));
  }

  return oauthError(400, "unsupported_grant_type", "Supported grant types are authorization_code and refresh_token.");
}

export async function handleGatewayRevoke(
  req: Request,
  config: AppConfig,
  refreshStore: OAuthRefreshStore | undefined,
  maxRequestBodyBytes: number,
  httpFetch: HttpFetch = fetch
): Promise<Response> {
  let bodyText = "";
  try {
    bodyText = await readTextWithLimit(req, maxRequestBodyBytes);
  } catch (error) {
    if (error instanceof RequestBodyLimitError) {
      return oauthError(413, "invalid_request", "Request body exceeds configured limit.");
    }
    throw error;
  }
  const form = new URLSearchParams(bodyText);
  const token = form.get("token") || "";
  const revokedGrant = refreshStore && token ? await refreshStore.revoke(token) : null;
  const upstream = await fetchUpstreamAuthMetadata(config, httpFetch);
  if (!upstream.revocation_endpoint) {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (revokedGrant) {
    form.set("token", revokedGrant.provider_refresh_token);
  }
  if (config.oauth.clientId && !form.get("client_id")) form.set("client_id", config.oauth.clientId);
  if (config.oauth.clientSecret && !form.get("client_secret")) form.set("client_secret", config.oauth.clientSecret);

  const res = await httpFetch(upstream.revocation_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: form.toString()
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: corsHeaders({ "content-type": res.headers.get("content-type") || "application/json; charset=utf-8" })
  });
}
