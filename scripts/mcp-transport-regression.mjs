import assert from "node:assert/strict";

import { createAppRequestHandler } from "../dist/app.js";
import { SessionStore } from "../dist/auth/sessionStore.js";
import { OauthStateStore } from "../dist/auth/oauthStateStore.js";
import { Telemetry } from "../dist/observability/telemetry.js";

const CURRENT_PROTOCOL_VERSION = "2025-11-25";

function makeConfig() {
  return {
    port: 8787,
    appBaseUrl: "https://openai.vibecodr.space",
    vibecodrApiBase: "https://api.vibecodr.space",
    sessionSigningKey: "transport-regression-session-key-0123456789",
    cookieSecure: true,
    allowManualTokenLink: false,
    enableCodexImportPath: true,
    enableChatGptImportPath: true,
    enablePublishFromChatGpt: true,
    maxRequestBodyBytes: 1_500_000,
    rateLimitWindowSeconds: 60,
    rateLimitRequestsPerWindow: 240,
    rateLimitMcpRequestsPerWindow: 120,
    dataDir: "data",
    oauth: {
      providerName: "clerk",
      authorizationUrl: "https://vibecodr.space/__clerk/oauth/authorize",
      tokenUrl: "https://vibecodr.space/__clerk/oauth/token",
      clientId: "test-client",
      clientSecret: undefined,
      scopes: "openid profile email offline_access",
      redirectUri: "https://openai.vibecodr.space/auth/callback",
      audience: undefined,
      issuerUrl: "https://vibecodr.space/__clerk",
      discoveryUrl: "https://vibecodr.space/__clerk/.well-known/openid-configuration"
    },
    staticMcpClient: {
      clientId: "chatgpt-vibecodr-space",
      clientSecret: "static-secret",
      redirectUris: []
    },
    codeMode: {
      enabled: true,
      defaultEnabled: false,
      requireDynamicWorker: false,
      allowNativeFallback: true,
      maxExecutionMs: 5_000,
      maxOutputBytes: 32_768,
      maxLogBytes: 8_192,
      maxNestedCalls: 5
    }
  };
}

function createNoopStore() {
  return {
    async create(op) { return op; },
    async getById() { return undefined; },
    async getByIdempotency() { return undefined; },
    async listByUser() { return []; },
    async addDiagnostic() { throw new Error("not used"); },
    async updateStatus() { throw new Error("not used"); }
  };
}

function createNoopImportService() {
  return {
    async refreshPendingOperations(_session, operations) { return operations; },
    async refreshImportJobStatus() { return undefined; },
    async cancelImport() { throw new Error("not used"); },
    async compileDraft() { throw new Error("not used"); },
    async publishDraft() { throw new Error("not used"); }
  };
}

function createNoopVibecodrClient() {
  return {};
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const config = makeConfig();
  const handler = createAppRequestHandler({
    config,
    sessionStore: new SessionStore(config.sessionSigningKey),
    oauthStateStore: new OauthStateStore(config.sessionSigningKey),
    operationStore: createNoopStore(),
    importService: createNoopImportService(),
    vibecodr: createNoopVibecodrClient(),
    telemetry: new Telemetry({ hashSalt: "transport-regression-salt" }),
  });

  const invalidOriginResponse = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  }));
  assert.equal(invalidOriginResponse.status, 403);

  const preflightResponse = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "OPTIONS",
    headers: {
      origin: "https://chatgpt.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,mcp-protocol-version,mcp-session-id"
    }
  }));
  assert.equal(preflightResponse.status, 204);
  assert.equal(preflightResponse.headers.get("access-control-allow-origin"), "https://chatgpt.com");
  assert.match(preflightResponse.headers.get("access-control-allow-headers") || "", /\bmcp-session-id\b/i);
  assert.match(preflightResponse.headers.get("access-control-expose-headers") || "", /\bmcp-session-id\b/i);

  const initializeResponse = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://chatgpt.com" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: CURRENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
    })
  }));
  assert.equal(initializeResponse.status, 200);
  assert.match(initializeResponse.headers.get("access-control-expose-headers") || "", /\bmcp-session-id\b/i);
  const initializeJson = await readJson(initializeResponse);
  assert.equal(initializeJson.result.protocolVersion, CURRENT_PROTOCOL_VERSION);
  assert.equal(initializeJson.result.capabilities.tools.listChanged, false);
  assert.equal(initializeJson.result.capabilities.prompts.listChanged, false);
  assert.equal(Object.prototype.hasOwnProperty.call(initializeJson.result.capabilities, "resources"), false);
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);

  const fallbackInitializeResponse = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } }
    })
  }));
  const fallbackInitializeJson = await readJson(fallbackInitializeResponse);
  assert.equal(fallbackInitializeResponse.status, 200);
  assert.equal(fallbackInitializeJson.result.protocolVersion, CURRENT_PROTOCOL_VERSION);

  const initializedNotification = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  }));
  assert.equal(initializedNotification.status, 202);

  const responseOnlyPayload = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })
  }));
  assert.equal(responseOnlyPayload.status, 202);

  const promptList = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "prompts/list",
      params: {}
    })
  }));
  assert.equal(promptList.status, 200);
  const promptListJson = await readJson(promptList);
  assert.equal(Boolean(promptListJson.result.prompts.find((prompt) => prompt.name === "publish_creation_end_to_end")), true);

  const promptGet = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "prompts/get",
      params: {
        name: "publish_creation_end_to_end",
        arguments: {
          creation_summary: "AI-built files ready to publish"
        }
      }
    })
  }));
  assert.equal(promptGet.status, 200);
  const promptGetJson = await readJson(promptGet);
  assert.match(promptGetJson.result.messages[0].content.text, /cover image/i);

  const unauthorizedProtectedTool = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_account_capabilities", arguments: {} }
    })
  }));
  assert.equal(unauthorizedProtectedTool.status, 401);
  assert.match(unauthorizedProtectedTool.headers.get("www-authenticate") || "", /Bearer realm="vibecodr"/);

  const hiddenRecoveryTool = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "explain_operation_failure", arguments: { operationId: "op_missing" } }
    })
  }));
  assert.equal(hiddenRecoveryTool.status, 401);
  assert.match(hiddenRecoveryTool.headers.get("www-authenticate") || "", /Bearer realm="vibecodr"/);

  const publicTool = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_vibecodr_platform_overview", arguments: {} }
    })
  }));
  assert.equal(publicTool.status, 200);

  const resourceNotFound = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "ui://widget/unknown" }
    })
  }));
  const resourceNotFoundJson = await readJson(resourceNotFound);
  assert.equal(resourceNotFound.status, 200);
  assert.equal(resourceNotFoundJson.error.code, -32002);

  const batchPayload = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} }
    ])
  }));
  assert.equal(batchPayload.status, 200);
  const batchJson = await readJson(batchPayload);
  assert.equal(Array.isArray(batchJson), true);
  assert.equal(batchJson.length, 3);
  const batchToolsSize = Buffer.byteLength(JSON.stringify(batchJson.find((item) => item.id === 1)));
  assert.ok(batchToolsSize < 60_000, "tools/list payload should stay compact for connector refresh");
  const toolsResult = batchJson.find((item) => item.id === 1)?.result?.tools || [];
  const resourcesResult = batchJson.find((item) => item.id === 2)?.result?.resources || [];
  const promptsResult = batchJson.find((item) => item.id === 3)?.result?.prompts || [];
  assert.ok(Array.isArray(toolsResult) && toolsResult.length > 0);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "quick_publish_creation")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "get_runtime_readiness")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "explain_operation_failure")), false);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "get_guided_publish_requirements")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "get_launch_best_practices")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "prepare_publish_package")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "resume_latest_publish_flow")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "discover_vibes")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "search_vibecodr")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "build_share_copy")), true);
  assert.equal(Boolean(toolsResult.find((tool) => tool.name === "watch_operation")), false);
  assert.deepEqual(resourcesResult, []);
  assert.equal(Boolean(promptsResult.find((prompt) => prompt.name === "polish_public_launch")), true);
  assert.equal("outputSchema" in toolsResult[0], false);
  const protectedTool = toolsResult.find((tool) => tool.name === "get_account_capabilities");
  assert.deepEqual(protectedTool?.securitySchemes, [{ type: "oauth2", scopes: ["openid", "profile", "email", "offline_access"] }]);
  const metadataTool = toolsResult.find((tool) => tool.name === "update_live_vibe_metadata");
  assert.equal(metadataTool?.inputSchema?.properties?.seo?.properties?.og?.type, "object");
  assert.equal(metadataTool?.inputSchema?.properties?.seo?.properties?.twitter?.type, "object");
  assert.equal(metadataTool?.inputSchema?.properties?.thumbnailFile?.required?.includes("fileId"), true);
  assert.equal(Boolean(metadataTool?._meta?.["openai/outputTemplate"]), false, "live vibe metadata updates should not advertise a widget template");
  const quickPublishTool = toolsResult.find((tool) => tool.name === "quick_publish_creation");
  assert.equal(Boolean(quickPublishTool?._meta?.["openai/outputTemplate"]), false, "MCP clients should not receive widget templates");
  assert.equal(quickPublishTool?.inputSchema?.properties?.thumbnailFile?.required?.includes("downloadUrl"), true);
  assert.equal(quickPublishTool?.inputSchema?.properties?.confirmed?.const, true, "publish writes should require explicit confirmation");

  const codeModeTools = await handler(new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/list",
      params: {}
    })
  }));
  assert.equal(codeModeTools.status, 200);
  const codeModeToolsJson = await readJson(codeModeTools);
  assert.deepEqual(codeModeToolsJson.result.tools.map((tool) => tool.name), ["search", "execute"]);

  const codeModeSearch = await handler(new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": CURRENT_PROTOCOL_VERSION,
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "search",
        arguments: {
          code: "async catalog => catalog.filter((capability) => capability.namespace === 'runtime')",
          capabilityId: "native.get_runtime_readiness"
        }
      }
    })
  }));
  assert.equal(codeModeSearch.status, 200);
  const codeModeSearchJson = await readJson(codeModeSearch);
  const runtimeCapability = codeModeSearchJson.result.structuredContent.results.find((entry) => entry.id === "native.get_runtime_readiness");
  assert.equal(Boolean(runtimeCapability), true);
  assert.equal(runtimeCapability?.executionStatus, "callable");
  assert.equal(Boolean(runtimeCapability?.inputSchema?.properties?.operationId), true);

  const launchGuidance = await handler(new Request("https://openai.vibecodr.space/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "get_launch_best_practices", arguments: {} }
    })
  }));
  assert.equal(launchGuidance.status, 200);
  const launchGuidanceJson = await readJson(launchGuidance);
  assert.equal(launchGuidanceJson?.result?.structuredContent?.headline, "Launch like a product, not a file upload.");
  const generationSpec = launchGuidanceJson?.result?.structuredContent?.coverGuidance?.generationSpec;
  assert.equal(generationSpec?.preferredSize, "Prefer 1536x1024 when the image model supports it. If not, use at least 1200x675 or another similarly large landscape size.");
  assert.equal(generationSpec?.minimumSize, "Never generate tiny covers. Stay at or above 1024x576 for launch art unless the user explicitly wants a small icon.");

  console.log("mcp transport regression OK");
}

await main();
