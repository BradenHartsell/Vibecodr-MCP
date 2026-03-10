#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { assertSafePath } from "../dist/lib/pathPolicy.js";
import { parseNormalizedPackage } from "../dist/adapters/packageSchema.js";

function expectThrows(fn, expectedMessage) {
  let didThrow = false;
  try {
    fn();
  } catch (error) {
    didThrow = true;
    const message = error instanceof Error ? error.message : String(error);
    if (expectedMessage) {
      assert.match(message, expectedMessage);
    }
  }
  assert.equal(didThrow, true, "Expected function to throw");
}

function parseSetCookie(setCookie) {
  const firstPart = (setCookie || "").split(";")[0] || "";
  const eq = firstPart.indexOf("=");
  if (eq <= 0) return null;
  return {
    name: firstPart.slice(0, eq).trim(),
    value: firstPart.slice(eq + 1).trim()
  };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  update(headers) {
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")]
          : [];
    for (const raw of setCookies) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      this.cookies.set(parsed.name, parsed.value);
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

async function fetchJson(baseUrl, jar, path, init = {}) {
  const headers = new Headers(init.headers || {});
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(baseUrl + path, { ...init, headers });
  jar.update(res.headers);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, text, json };
}

async function waitForServer(baseUrl, path = "/health") {
  let lastError = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(baseUrl + path);
      if (res.ok) return;
      lastError = "Unexpected status " + res.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for local server: " + lastError);
}

function withTimeout(promise, label, timeoutMs = 10000) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(label + " timed out after " + timeoutMs + "ms");
    })
  ]);
}

function makeRpcBody(id, name, args = {}) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  });
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkceChallenge(verifier) {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

async function main() {
  assert.doesNotThrow(() =>
    parseNormalizedPackage({
      sourceType: "codex_v1",
      title: "Regression Fixture",
      entry: "index.tsx",
      importMode: "direct_files",
      files: [{ path: "index.tsx", content: "export default 1;", contentEncoding: "utf8" }]
    })
  );
  expectThrows(() => assertSafePath("../escape.txt"), /Path traversal blocked/);
  expectThrows(() => assertSafePath("\\\\server\\share"), /Absolute paths are blocked|Backslashes are blocked/);
  expectThrows(() => parseNormalizedPackage({ sourceType: "chatgpt_v1", importMode: "direct_files", files: [] }), /INGEST_NO_FILES_FOR_DIRECT_IMPORT/);
  expectThrows(
    () =>
      parseNormalizedPackage({
        sourceType: "chatgpt_v1",
        importMode: "direct_files",
        files: [{ path: "../secret.txt", content: "bad", contentEncoding: "utf8" }]
      }),
    /Path traversal blocked/
  );

  const port = 3300 + Math.floor(Math.random() * 300);
  const oauthPort = port + 500;
  const apiPort = port + 600;
  const baseUrl = `http://127.0.0.1:${port}`;
  const oauthBaseUrl = `http://127.0.0.1:${oauthPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;

  const oauthServer = spawn(process.execPath, ["-e", `
    const { createServer } = require("node:http");
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1:${oauthPort}");
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const grantType = body.get("grant_type");
        res.writeHead(200, { "content-type": "application/json" });
        if (grantType === "refresh_token") {
          const incomingRefreshToken = body.get("refresh_token");
          if (incomingRefreshToken !== "oauth_refresh_token") {
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          res.end(JSON.stringify({
            access_token: "oauth_access_token_refreshed",
            refresh_token: "oauth_refresh_token_rotated",
            token_type: "Bearer",
            expires_in: 3600
          }));
          return;
        }
        res.end(JSON.stringify({
          access_token: "oauth_access_token",
          refresh_token: "oauth_refresh_token",
          token_type: "Bearer",
          expires_in: 3600
        }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/oauth/revoke") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("authorize");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.listen(${oauthPort});
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const vibecodrServer = spawn(process.execPath, ["-e", `
    const { createServer } = require("node:http");
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1:${apiPort}");
      if (req.method === "POST" && url.pathname === "/auth/cli/exchange") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const incomingAccessToken = body.access_token;
        const responseToken =
          incomingAccessToken === "oauth_access_token_refreshed"
            ? "vibecodr_access_token_refreshed"
            : "vibecodr_access_token";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: responseToken,
          token_type: "Bearer",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: "user_regression",
          user_handle: "regression-user"
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.listen(${apiPort});
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
  `], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const env = {
    ...process.env,
    PORT: String(port),
    APP_BASE_URL: baseUrl,
    VIBECDR_API_BASE: apiBaseUrl,
    SESSION_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
    OAUTH_PROVIDER_NAME: "clerk",
    OAUTH_CLIENT_ID: "security-regression",
    OAUTH_AUTHORIZATION_URL: `${oauthBaseUrl}/oauth/authorize`,
    OAUTH_TOKEN_URL: `${oauthBaseUrl}/oauth/token`,
    OAUTH_REDIRECT_URI: `${baseUrl}/oauth_callback`,
    ALLOW_MANUAL_TOKEN_LINK: "true",
    MAX_REQUEST_BODY_BYTES: "1024",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    RATE_LIMIT_REQUESTS_PER_WINDOW: "500",
    RATE_LIMIT_MCP_REQUESTS_PER_WINDOW: "500"
  };

  const server = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);
    await waitForServer(oauthBaseUrl, "/oauth/authorize");
    await waitForServer(apiBaseUrl, "/health");

    const jar = new CookieJar();

    const mcpGet = await fetch(baseUrl + "/mcp");
    assert.equal(mcpGet.status, 405, "Expected GET /mcp to reject non-POST access");
    assert.equal(mcpGet.headers.get("allow"), "POST, OPTIONS");

    const protectedResource = await fetchJson(baseUrl, jar, "/.well-known/oauth-protected-resource/mcp");
    assert.equal(protectedResource.res.status, 200, "Expected protected resource metadata");
    assert.deepEqual(protectedResource.json?.authorization_servers, [baseUrl], "Expected gateway to be sole advertised authorization server");

    const authMeta = await fetchJson(baseUrl, jar, "/.well-known/oauth-authorization-server");
    assert.equal(authMeta.res.status, 200, "Expected gateway authorization metadata");
    assert.equal(authMeta.json?.registration_endpoint, baseUrl + "/register");
    assert.deepEqual(authMeta.json?.token_endpoint_auth_methods_supported, ["none"]);
    assert.deepEqual(authMeta.json?.registration_endpoint_auth_methods_supported, ["none"]);
    assert.equal(authMeta.json?.client_id_metadata_document_supported, true);
    assert.deepEqual(authMeta.json?.response_modes_supported, ["query"]);
    assert.deepEqual(authMeta.json?.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.ok(Array.isArray(authMeta.json?.scopes_supported) && authMeta.json.scopes_supported.every((scope) => ["openid", "profile", "email", "offline_access"].includes(scope)), "Expected gateway to advertise only configured OAuth scopes");

    const clientMetadata = await fetchJson(baseUrl, jar, "/.well-known/oauth-client/vibecodr-mcp.json");
    assert.equal(clientMetadata.res.status, 200, "Expected official client metadata document");
    assert.equal(clientMetadata.json?.client_id, baseUrl + "/.well-known/oauth-client/vibecodr-mcp.json");
    assert.deepEqual(clientMetadata.json?.grant_types, ["authorization_code", "refresh_token"]);

    const widget = await fetch(baseUrl + "/widget");
    const widgetHtml = await widget.text();
    assert.ok(widgetHtml.includes("Waiting for the creation package."), "Expected compact widget to remain inert until host payload arrives");
    assert.ok(!widgetHtml.includes('"title": "My Vibe"'), "Expected compact widget to avoid shipping a sample publish payload");
    assert.ok(!widgetHtml.includes("Package source and raw payload"), "Expected compact widget to exclude advanced package editing UI");

    const registration = await fetchJson(baseUrl, jar, "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Regression MCP Client",
        redirect_uris: ["http://127.0.0.1:8788/callback"]
      })
    });
    assert.equal(registration.res.status, 201, "Expected dynamic client registration to succeed");
    assert.equal(typeof registration.json?.client_id, "string");

    const clientState = "regression-state";
    const codeVerifier = "regression-verifier-0123456789";
    const authorize = await fetch(
      baseUrl +
        "/authorize?response_type=code&client_id=" +
        encodeURIComponent(registration.json.client_id) +
        "&redirect_uri=" +
        encodeURIComponent("http://127.0.0.1:8788/callback") +
        "&state=" +
        encodeURIComponent(clientState) +
        "&code_challenge=" +
        encodeURIComponent(createPkceChallenge(codeVerifier)) +
        "&code_challenge_method=S256",
      { redirect: "manual" }
    );
    assert.equal(authorize.status, 302, "Expected generic authorize redirect");
    const authorizeLocation = authorize.headers.get("location") || "";
    assert.ok(authorizeLocation.startsWith(oauthBaseUrl + "/oauth/authorize?"), "Expected upstream authorize redirect");

    const upstreamState = new URL(authorizeLocation).searchParams.get("state");
    assert.equal(typeof upstreamState, "string");
    assert.ok(upstreamState && upstreamState.startsWith("vcgs."), "Expected signed generic state");

    const callback = await fetch(baseUrl + "/oauth_callback?code=provider-code&state=" + encodeURIComponent(upstreamState), {
      redirect: "manual"
    });
    assert.equal(callback.status, 302, "Expected gateway callback redirect to client");
    const callbackLocation = callback.headers.get("location") || "";
    const callbackUrl = new URL(callbackLocation);
    assert.equal(callbackUrl.origin + callbackUrl.pathname, "http://127.0.0.1:8788/callback");
    assert.equal(callbackUrl.searchParams.get("state"), clientState);
    const gatewayCode = callbackUrl.searchParams.get("code");
    assert.equal(typeof gatewayCode, "string");
    assert.ok(gatewayCode && gatewayCode.startsWith("vc_code_"), "Expected gateway-issued auth code");

    const gatewayToken = await fetchJson(baseUrl, jar, "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: gatewayCode,
        client_id: registration.json.client_id,
        redirect_uri: "http://127.0.0.1:8788/callback",
        code_verifier: codeVerifier
      }).toString()
    });
    assert.equal(gatewayToken.res.status, 200, "Expected gateway token exchange");
    assert.equal(typeof gatewayToken.json?.access_token, "string", "Expected gateway-issued access token");
    assert.match(String(gatewayToken.json?.access_token), /^v1\./, "Expected sealed gateway access token");
    assert.notEqual(gatewayToken.json?.access_token, "oauth_access_token", "Expected gateway to avoid leaking upstream access tokens");
    assert.equal(typeof gatewayToken.json?.refresh_token, "string", "Expected gateway-issued refresh token");
    assert.match(String(gatewayToken.json?.refresh_token), /^vc_rt\./, "Expected opaque gateway refresh token");
    assert.notEqual(gatewayToken.json?.refresh_token, "oauth_refresh_token", "Expected gateway to avoid leaking upstream refresh tokens");

    const bearerSession = await fetchJson(baseUrl, new CookieJar(), "/api/auth/session", {
      headers: { authorization: `Bearer ${gatewayToken.json.access_token}` }
    });
    assert.equal(bearerSession.res.status, 200, "Expected gateway bearer token to authenticate");
    assert.equal(bearerSession.json?.authenticated, true);
    assert.equal(bearerSession.json?.authMode, "gateway_bearer");

    const refreshedToken = await fetchJson(baseUrl, jar, "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: gatewayToken.json.refresh_token,
        client_id: registration.json.client_id
      }).toString()
    });
    assert.equal(refreshedToken.res.status, 200, "Expected refresh-token exchange");
    assert.equal(typeof refreshedToken.json?.access_token, "string", "Expected refreshed gateway access token");
    assert.match(String(refreshedToken.json?.access_token), /^v1\./, "Expected refreshed sealed gateway access token");
    assert.notEqual(refreshedToken.json?.access_token, "oauth_access_token_refreshed", "Expected gateway to avoid leaking refreshed upstream access tokens");
    assert.equal(typeof refreshedToken.json?.refresh_token, "string", "Expected rotated refresh token");
    assert.match(String(refreshedToken.json?.refresh_token), /^vc_rt\./, "Expected rotated opaque refresh token");
    assert.notEqual(refreshedToken.json?.refresh_token, gatewayToken.json.refresh_token, "Expected refresh-token rotation");

    const oldRefreshReuse = await fetchJson(baseUrl, jar, "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: gatewayToken.json.refresh_token,
        client_id: registration.json.client_id
      }).toString()
    });
    assert.equal(oldRefreshReuse.res.status, 200, "Expected immediate refresh-token retry to replay the successful response");
    assert.equal(oldRefreshReuse.json?.access_token, refreshedToken.json?.access_token);
    assert.equal(oldRefreshReuse.json?.refresh_token, refreshedToken.json?.refresh_token);

    const revoked = await fetchJson(baseUrl, jar, "/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshedToken.json.refresh_token
      }).toString()
    });
    assert.equal(revoked.res.status, 204, "Expected revoke to succeed even without upstream revocation support");

    const revokedRefreshReuse = await fetchJson(baseUrl, jar, "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshedToken.json.refresh_token,
        client_id: registration.json.client_id
      }).toString()
    });
    assert.equal(revokedRefreshReuse.res.status, 400, "Expected revoked refresh token to be rejected");
    assert.equal(revokedRefreshReuse.json?.error, "invalid_grant");

    const health = await fetchJson(baseUrl, jar, "/health/observability");
    assert.equal(health.res.status, 200, "Expected /health/observability to succeed");
    assert.equal(health.json?.ok, true);
    assert.ok(Array.isArray(health.json?.counters), "Expected counters array");
    assert.ok(Array.isArray(health.json?.distributions), "Expected distributions array");
    assert.ok(Array.isArray(health.json?.alerts), "Expected alerts array");

    const oversizedBody = makeRpcBody(500, "start_creation_import", {
      sourceType: "codex_v1",
      payload: {
        title: "Oversized Regression Payload",
        entry: "index.tsx",
        importMode: "direct_files",
        files: [{ path: "index.tsx", content: "x".repeat(70000), contentEncoding: "utf8" }]
      }
    });
    const oversized = await fetch(baseUrl + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody
    });
    const oversizedJson = await oversized.json();
    assert.equal(oversized.status, 413, "Expected body size enforcement");
    assert.equal(oversizedJson.error, "REQUEST_BODY_TOO_LARGE");
    assert.equal(oversized.headers.get("x-trace-id"), oversizedJson.traceId);

    for (let i = 0; i < 10; i += 1) {
      const unauth = await fetchJson(baseUrl, jar, "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: makeRpcBody(i + 1, "list_vibecodr_drafts", {})
      });
      assert.equal(unauth.res.status, 401, "Expected HTTP auth challenge");
      assert.equal(typeof unauth.res.headers.get("www-authenticate"), "string", "Expected WWW-Authenticate header");
      assert.match(
        String(unauth.res.headers.get("www-authenticate")),
        /authorization_uri="http:\/\/127\.0\.0\.1:\d+\/authorize"/,
        "Expected generic auth challenge to target the gateway authorization endpoint"
      );
    }

    for (let i = 0; i < 3; i += 1) {
      const invalidCallback = await fetchJson(baseUrl, jar, `/oauth_callback?code=fake-${i}&state=bad-state-${i}`);
      assert.equal(invalidCallback.res.status, 400, "Expected invalid state failure");
      assert.equal(invalidCallback.json?.error, "Invalid or expired OAuth state");
    }

    const linked = await fetchJson(baseUrl, jar, "/api/auth/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "vc_regression_token", userId: "user_regression" })
    });
    assert.equal(linked.res.status, 200, "Expected manual link success");
    assert.equal(linked.json?.ok, true);

    const session = await fetchJson(baseUrl, jar, "/api/auth/session");
    assert.equal(session.res.status, 200);
    assert.equal(session.json?.authenticated, true);

    const copiedCookie = jar.header();
    const logout = await fetchJson(baseUrl, jar, "/api/auth/logout", { method: "POST" });
    assert.equal(logout.res.status, 200, "Expected logout to succeed");
    const replayedSession = await fetch(baseUrl + "/api/auth/session", {
      headers: { cookie: copiedCookie }
    });
    const replayedSessionJson = await replayedSession.json();
    assert.equal(replayedSession.status, 200, "Expected revoked cookie replay check to complete");
    assert.equal(replayedSessionJson.authenticated, false, "Expected copied session cookie to be revoked after logout");

    const watch = await fetchJson(baseUrl, jar, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: makeRpcBody(99, "watch_operation", {})
    });
    assert.equal(watch.res.status, 401);
    assert.equal(typeof watch.res.headers.get("www-authenticate"), "string");

    const summary = await fetchJson(baseUrl, jar, "/api/observability/summary");
    assert.equal(summary.res.status, 401, "Expected observability summary to require a live session");
    const relinked = await fetchJson(baseUrl, jar, "/api/auth/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "vc_regression_token_2", userId: "user_regression" })
    });
    assert.equal(relinked.res.status, 200, "Expected relink after logout");

    const authedSummary = await fetchJson(baseUrl, jar, "/api/observability/summary");
    assert.equal(authedSummary.res.status, 200, "Expected authenticated observability summary");
    assert.ok(Array.isArray(authedSummary.json?.recentEvents), "Expected recent events");
    assert.ok(Array.isArray(authedSummary.json?.alerts), "Expected alerts array");
    assert.ok(
      authedSummary.json.alerts.some((alert) => alert.code === "AUTH_FAILURE_SPIKE"),
      "Expected auth spike alert after induced challenge/failure events"
    );
    assert.ok(
      authedSummary.json.recentEvents.some((event) => event.category === "auth.audit" || event.category === "http.request"),
      "Expected recent auth or request telemetry after the induced challenge/revocation flow"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          assertions: [
            "path_policy_guards",
            "package_schema_guards",
            "request_body_limit",
            "generic_oauth_metadata_and_registration",
            "generic_oauth_authorize_and_token_flow",
            "gateway_refresh_token_rotation",
            "gateway_bearer_authentication",
            "compact_widget_inertness",
            "oauth_auth_challenge",
            "logout_revokes_copied_cookie",
            "oauth_failure_alerting",
            "structured_tool_errors",
            "observability_summary_contract"
          ],
          alertCodes: authedSummary.json.alerts.map((alert) => alert.code)
        },
        null,
        2
      )
    );
  } finally {
    oauthServer.kill("SIGTERM");
    await withTimeout(once(oauthServer, "exit"), "oauth server shutdown", 5000).catch(() => {
      oauthServer.kill("SIGKILL");
      return null;
    });
    vibecodrServer.kill("SIGTERM");
    await withTimeout(once(vibecodrServer, "exit"), "vibecodr server shutdown", 5000).catch(() => {
      vibecodrServer.kill("SIGKILL");
      return null;
    });
    server.kill("SIGTERM");
    const exitResult = await withTimeout(once(server, "exit"), "server shutdown", 5000).catch(() => {
      server.kill("SIGKILL");
      return null;
    });
    const [exitCode, exitSignal] = Array.isArray(exitResult) ? exitResult : [server.exitCode, server.signalCode];
    if (exitSignal == null && exitCode && exitCode !== 0) {
      console.error(stdout);
      console.error(stderr);
      throw new Error("Local server exited with code " + exitCode);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
