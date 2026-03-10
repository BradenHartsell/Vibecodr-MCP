import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadConfigFromSource } from "../src/config.js";
import {
  AuthorizationCodeStore,
  GenericOauthRequestStateStore,
  buildGatewayAuthMetadata,
  handleGatewayAuthorize,
  handleGatewayToken
} from "../src/auth/mcpOAuthCompat.js";
import { OAuthRefreshStore } from "../src/auth/oauthRefreshStore.js";
import { buildOfficialMcpClientMetadata } from "../src/auth/officialMcpClient.js";
import { buildToolWwwAuthenticate } from "../src/mcp/tools.js";
import { SessionStore } from "../src/auth/sessionStore.js";
import type { KvNamespaceLike } from "../src/storage/operationStoreKv.js";

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

function createConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfigFromSource({
    PORT: "3000",
    APP_BASE_URL: "https://openai.vibecodr.space",
    VIBECDR_API_BASE: "https://api.vibecodr.space",
    SESSION_SIGNING_KEY: "x".repeat(32),
    COOKIE_SECURE: "true",
    OAUTH_PROVIDER_NAME: "clerk",
    OAUTH_CLIENT_ID: "clerk-client-id",
    OAUTH_ISSUER_URL: "https://clerk.vibecodr.space",
    OAUTH_SCOPES: "openid profile email offline_access",
    MCP_STATIC_CLIENT_ID: "vc-public-cli",
    MCP_STATIC_CLIENT_REDIRECT_URIS: "http://127.0.0.1/oauth/callback/vibecodr,http://localhost/oauth/callback/vibecodr",
    ...overrides
  });
}

async function discoveryFetch(): Promise<Response> {
  return new Response(
    JSON.stringify({
      authorization_endpoint: "https://clerk.vibecodr.space/oauth/authorize",
      token_endpoint: "https://clerk.vibecodr.space/oauth/token",
      code_challenge_methods_supported: ["S256"]
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

class MockKv implements KvNamespaceLike {
  private readonly map = new Map<string, string>();

  async get(key: string, type?: "text" | "json"): Promise<string | null | unknown> {
    const value = this.map.get(key) ?? null;
    if (value == null) return null;
    if (type === "json") return JSON.parse(value) as unknown;
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

test("loadConfigFromSource parses preregistered MCP redirect URIs", () => {
  const config = createConfig({
    MCP_STATIC_CLIENT_REDIRECT_URIS: "http://127.0.0.1/oauth/callback/vibecodr https://app.vibecodr.space/oauth/callback"
  });
  assert.deepEqual(config.staticMcpClient.redirectUris, [
    "http://127.0.0.1/oauth/callback/vibecodr",
    "https://app.vibecodr.space/oauth/callback"
  ]);
});

test("loadConfigFromSource allows legacy static client ids without redirect URIs so startup does not fail", () => {
  const config = createConfig({ MCP_STATIC_CLIENT_REDIRECT_URIS: "" });
  assert.equal(config.staticMcpClient.clientId, "vc-public-cli");
  assert.deepEqual(config.staticMcpClient.redirectUris, []);
});

test("authorize accepts a preregistered public client on a loopback callback with an ephemeral port", async () => {
  const config = createConfig();
  const stateStore = new GenericOauthRequestStateStore(config.sessionSigningKey);
  const requestUrl = new URL("https://openai.vibecodr.space/authorize");
  requestUrl.searchParams.set("response_type", "code");
  requestUrl.searchParams.set("client_id", "vc-public-cli");
  requestUrl.searchParams.set("redirect_uri", "http://127.0.0.1:43123/oauth/callback/vibecodr");
  requestUrl.searchParams.set("state", "client-state");
  requestUrl.searchParams.set("code_challenge", "pkce-challenge");
  requestUrl.searchParams.set("code_challenge_method", "S256");

  const res = await handleGatewayAuthorize(requestUrl, config, stateStore, discoveryFetch);

  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location);
  assert.match(location, /^https:\/\/clerk\.vibecodr\.space\/oauth\/authorize\?/);
});

test("authorize rejects a preregistered public client when the redirect path is not registered", async () => {
  const config = createConfig();
  const stateStore = new GenericOauthRequestStateStore(config.sessionSigningKey);
  const requestUrl = new URL("https://openai.vibecodr.space/authorize");
  requestUrl.searchParams.set("response_type", "code");
  requestUrl.searchParams.set("client_id", "vc-public-cli");
  requestUrl.searchParams.set("redirect_uri", "http://127.0.0.1:43123/oauth/callback/other");
  requestUrl.searchParams.set("state", "client-state");
  requestUrl.searchParams.set("code_challenge", "pkce-challenge");
  requestUrl.searchParams.set("code_challenge_method", "S256");

  const res = await handleGatewayAuthorize(requestUrl, config, stateStore, discoveryFetch);

  assert.equal(res.status, 400);
  const payload = await res.json() as { error_description?: string };
  assert.match(payload.error_description || "", /redirect_uri does not match/i);
});

test("token exchange accepts a preregistered public client without a client secret", async () => {
  const config = createConfig();
  const sessionStore = new SessionStore(config.sessionSigningKey);
  const codeStore = new AuthorizationCodeStore();
  const codeVerifier = "proof-key-verifier";
  const redirectUri = "http://127.0.0.1:43123/oauth/callback/vibecodr";
  const code = await codeStore.issue({
    client_id: "vc-public-cli",
    redirect_uri: redirectUri,
    code_challenge: createCodeChallenge(codeVerifier),
    requested_scope: "openid profile email offline_access",
    vibecodr_access_token: "vibecodr-access-token",
    user_id: "user_123",
    user_handle: "brade"
  });

  const req = new Request("https://openai.vibecodr.space/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "vc-public-cli",
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    }).toString()
  });

  const res = await handleGatewayToken(req, config, codeStore, undefined, sessionStore, 10_000, discoveryFetch);

  assert.equal(res.status, 200);
  const payload = await res.json() as { access_token?: string; refresh_token?: string };
  assert.equal(typeof payload.access_token, "string");
  assert.equal(payload.refresh_token, undefined);
});

test("gateway metadata advertises client metadata document support", async () => {
  const config = createConfig();
  const metadata = buildGatewayAuthMetadata(config, {
    authorization_endpoint: "https://clerk.vibecodr.space/oauth/authorize",
    token_endpoint: "https://clerk.vibecodr.space/oauth/token",
    code_challenge_methods_supported: ["S256"]
  });
  assert.equal(metadata.client_id_metadata_document_supported, true);
});

test("authorize accepts the official URL-based client metadata document id", async () => {
  const config = createConfig();
  const stateStore = new GenericOauthRequestStateStore(config.sessionSigningKey);
  const official = buildOfficialMcpClientMetadata(config);
  const requestUrl = new URL("https://openai.vibecodr.space/authorize");
  requestUrl.searchParams.set("response_type", "code");
  requestUrl.searchParams.set("client_id", official.client_id);
  requestUrl.searchParams.set("redirect_uri", "http://127.0.0.1:43123/oauth/callback/vibecodr");
  requestUrl.searchParams.set("state", "client-state");
  requestUrl.searchParams.set("code_challenge", "pkce-challenge");
  requestUrl.searchParams.set("code_challenge_method", "S256");

  const res = await handleGatewayAuthorize(requestUrl, config, stateStore, discoveryFetch);

  assert.equal(res.status, 302);
});

test("token exchange accepts the official URL-based client metadata document id", async () => {
  const config = createConfig();
  const sessionStore = new SessionStore(config.sessionSigningKey);
  const codeStore = new AuthorizationCodeStore();
  const codeVerifier = "proof-key-verifier";
  const redirectUri = "http://127.0.0.1:43123/oauth/callback/vibecodr";
  const official = buildOfficialMcpClientMetadata(config);
  const code = await codeStore.issue({
    client_id: official.client_id,
    redirect_uri: redirectUri,
    code_challenge: createCodeChallenge(codeVerifier),
    requested_scope: "openid profile email offline_access",
    vibecodr_access_token: "vibecodr-access-token",
    user_id: "user_123",
    user_handle: "brade"
  });

  const req = new Request("https://openai.vibecodr.space/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: official.client_id,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    }).toString()
  });

  const res = await handleGatewayToken(req, config, codeStore, undefined, sessionStore, 10_000, discoveryFetch);

  assert.equal(res.status, 200);
});

test("refresh exchange replays the successful response when an official client retries the old token", async () => {
  const config = createConfig();
  const sessionStore = new SessionStore(config.sessionSigningKey);
  const codeStore = new AuthorizationCodeStore();
  const refreshStore = new OAuthRefreshStore(new MockKv(), config.sessionSigningKey);
  const official = buildOfficialMcpClientMetadata(config);
  const initialRefreshToken = await refreshStore.issue({
    client_id: official.client_id,
    provider_refresh_token: "clerk-refresh-token-1",
    requested_scope: "openid profile email offline_access"
  });
  let upstreamRefreshCalls = 0;
  let vibecodrExchangeCalls = 0;

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://clerk.vibecodr.space/.well-known/oauth-authorization-server") {
      return discoveryFetch();
    }
    if (url === "https://clerk.vibecodr.space/oauth/token") {
      const body = new URLSearchParams(String(init?.body || ""));
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "clerk-refresh-token-1");
      upstreamRefreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "oauth_access_token_refreshed",
        refresh_token: "clerk-refresh-token-2",
        scope: "openid profile email offline_access"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === "https://api.vibecodr.space/auth/cli/exchange") {
      vibecodrExchangeCalls += 1;
      return new Response(JSON.stringify({
        access_token: "vibecodr_access_token_refreshed",
        user_id: "user_123",
        user_handle: "brade",
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error("Unexpected fetch target: " + url);
  };

  const requestBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: initialRefreshToken,
    client_id: official.client_id
  }).toString();

  const firstResponse = await handleGatewayToken(
    new Request("https://openai.vibecodr.space/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: requestBody
    }),
    config,
    codeStore,
    refreshStore,
    sessionStore,
    10_000,
    fakeFetch
  );
  assert.equal(firstResponse.status, 200);
  const firstPayload = await firstResponse.json() as { access_token?: string; refresh_token?: string; scope?: string };
  assert.equal(typeof firstPayload.access_token, "string");
  assert.equal(typeof firstPayload.refresh_token, "string");

  const replayResponse = await handleGatewayToken(
    new Request("https://openai.vibecodr.space/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: requestBody
    }),
    config,
    codeStore,
    refreshStore,
    sessionStore,
    10_000,
    fakeFetch
  );
  assert.equal(replayResponse.status, 200);
  const replayPayload = await replayResponse.json() as { access_token?: string; refresh_token?: string; scope?: string };
  assert.deepEqual(replayPayload, firstPayload);
  assert.equal(upstreamRefreshCalls, 1);
  assert.equal(vibecodrExchangeCalls, 1);
});

test("tool auth challenge includes resource metadata and required scopes", () => {
  const challenge = buildToolWwwAuthenticate("https://openai.vibecodr.space", {
    scope: "openid profile email offline_access",
    error: "insufficient_scope"
  });
  assert.match(challenge, /resource_metadata="https:\/\/openai\.vibecodr\.space\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /scope="openid profile email offline_access"/);
  assert.match(challenge, /error="insufficient_scope"/);
});
