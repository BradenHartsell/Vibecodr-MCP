#!/usr/bin/env node
import assert from "node:assert/strict";

const baseUrl = (process.env.MCP_BASE_URL || "").replace(/\/$/, "");
const bearerToken = (process.env.MCP_BEARER_TOKEN || "").trim();

if (!baseUrl) {
  console.error("MCP_BASE_URL is required, for example: MCP_BASE_URL=https://staging-openai.vibecodr.space npm run codemode:live-sandbox");
  process.exit(1);
}

const endpoint = baseUrl + "/mcp?codemode=search_and_execute";
let nextId = 1;

async function rpc(method, params, auth = false) {
  const headers = {
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25"
  };
  if (auth && bearerToken) headers.authorization = "Bearer " + bearerToken;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params
    })
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

function structured(result) {
  return result.body?.result?.structuredContent || {};
}

async function callTool(name, args, auth = false) {
  return rpc("tools/call", {
    name,
    arguments: args
  }, auth);
}

const tools = await rpc("tools/list", {});
assert.equal(tools.response.status, 200);
assert.deepEqual(tools.body?.result?.tools?.map((tool) => tool.name), ["search", "execute"]);

const network = await callTool("search", {
  code: `async () => {
    const result = {};
    try {
      await fetch("https://example.com");
      result.fetch = "allowed";
    } catch (error) {
      result.fetch = "blocked";
      result.fetchError = String(error && error.message || error).slice(0, 160);
    }
    try {
      const maybeConnect = globalThis.connect;
      if (typeof maybeConnect !== "function") {
        result.connect = "unavailable";
      } else {
        await maybeConnect({ hostname: "example.com", port: 443 });
        result.connect = "allowed";
      }
    } catch (error) {
      result.connect = "blocked";
      result.connectError = String(error && error.message || error).slice(0, 160);
    }
    return result;
  }`
});
assert.equal(network.response.status, 200);
assert.equal(structured(network).runtime, "dynamic_worker");
assert.equal(structured(network).fetch, "blocked");
assert.notEqual(structured(network).connect, "allowed");

const environment = await callTool("search", {
  code: `async () => ({
    processEnvKeys: typeof process !== "undefined" && process.env ? Object.keys(process.env).slice(0, 5) : [],
    hasWorkerLoaderGlobal: typeof CODEMODE_WORKER_LOADER !== "undefined",
    hasAuthorizationGlobal: typeof authorization !== "undefined" || typeof Authorization !== "undefined",
    hasCookieGlobal: typeof cookie !== "undefined" || typeof Cookie !== "undefined"
  })`
});
assert.equal(environment.response.status, 200);
assert.equal(structured(environment).runtime, "dynamic_worker");
assert.deepEqual(structured(environment).processEnvKeys, []);
assert.equal(structured(environment).hasWorkerLoaderGlobal, false);
assert.equal(structured(environment).hasAuthorizationGlobal, false);
assert.equal(structured(environment).hasCookieGlobal, false);

const outputCap = await callTool("search", {
  code: `async () => ({ payload: "x".repeat(40000) })`
});
assert.equal(outputCap.response.status, 200);
assert.equal(structured(outputCap).error, "CODEMODE_OUTPUT_TOO_LARGE");

const timeout = await callTool("search", {
  code: `async () => new Promise((resolve) => setTimeout(() => resolve({ tooLate: true }), 60000))`
});
assert.equal(timeout.response.status, 200);
assert.equal(structured(timeout).error, "CODEMODE_EXECUTION_FAILED");
assert.match(String(structured(timeout).message || ""), /timed out/i);

if (bearerToken) {
  const catalogOnly = await callTool("execute", {
    code: `async ({ vibecodr }) => vibecodr.execute({ capabilityId: "publish.publish_capsule", confirmed: true })`,
    capabilityId: "publish.publish_capsule",
    confirmed: true
  }, true);
  assert.equal(catalogOnly.response.status, 200);
  assert.equal(structured(catalogOnly).error, "CATALOG_ONLY_CAPABILITY");

  const missingConfirmation = await callTool("execute", {
    code: `async ({ vibecodr }) => vibecodr.execute({ capabilityId: "native.cancel_import_operation" })`,
    capabilityId: "native.cancel_import_operation"
  }, true);
  assert.equal(missingConfirmation.response.status, 200);
  assert.equal(structured(missingConfirmation).confirmationRequired, true);
} else {
  console.warn("MCP_BEARER_TOKEN not provided; skipped authenticated execute checks.");
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  assertions: [
    "codemode_tool_surface",
    "dynamic_worker_runtime",
    "fetch_blocked",
    "connect_not_allowed",
    "env_and_binding_globals_absent",
    "output_cap",
    "timeout_cap",
    ...(bearerToken ? ["catalog_only_rejected", "destructive_confirmation_required"] : [])
  ]
}, null, 2));
