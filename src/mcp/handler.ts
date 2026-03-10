import {
  buildToolWwwAuthenticate,
  callTool,
  getSessionForToolRequest,
  getTools,
  toolRequiresAuth,
  type ToolDeps
} from "./tools.js";
import { jsonResponse } from "../lib/http.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  id?: string | number | null;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponsePayload = {
  id?: string | number | null;
  jsonrpc?: string;
  result?: unknown;
  error?: unknown;
};

type McpHandlerOptions = {
  maxRequestBodyBytes?: number;
};

type ClientPresentationState = {
  supportsUi: boolean;
  expiresAt: number;
};

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_500_000;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_FALLBACK_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
const MCP_SESSION_HEADER = "mcp-session-id";
const UI_EXTENSION_KEY = "io.modelcontextprotocol/ui";
const CLIENT_PRESENTATION_TTL_MS = 60 * 60 * 1000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
]);
const clientPresentationSessions = new Map<string, ClientPresentationState>();

function parseContentLength(req: Request): number | undefined {
  const raw = req.headers.get("content-length");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function errorEnvelope(error: string, message: string, traceId: string, errorId: string, extra?: Record<string, unknown>) {
  return { error, message, traceId, errorId, ...(extra || {}) };
}

function acceptedResponse(traceId: string): Response {
  return new Response(null, {
    status: 202,
    headers: {
      "x-trace-id": traceId,
      "cache-control": "no-store"
    }
  });
}

function mcpJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  traceId: string,
  status = 200,
  headers?: Record<string, string>,
  extraData?: Record<string, unknown>
): Response {
  const errorId = crypto.randomUUID();
  return jsonResponse(
    status,
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        data: { traceId, errorId, ...(extraData || {}) }
      }
    },
    { "x-trace-id": traceId, "cache-control": "no-store", ...(headers || {}) }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcResponsePayload(payload: unknown): payload is JsonRpcResponsePayload {
  if (!isRecord(payload)) return false;
  return payload["jsonrpc"] === "2.0" && !("method" in payload) && ("result" in payload || "error" in payload);
}

function isJsonRpcNotification(payload: unknown): payload is JsonRpcRequest {
  if (!isRecord(payload)) return false;
  return payload["jsonrpc"] === "2.0" && typeof payload["method"] === "string" && !("id" in payload);
}

function parseRequestParams(payload: JsonRpcRequest): Record<string, unknown> {
  return payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
    ? payload.params
    : {};
}

function negotiatedProtocolVersion(requested?: string): string {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return requested;
  return DEFAULT_FALLBACK_PROTOCOL_VERSION;
}

function pruneExpiredClientPresentationSessions(now = Date.now()): void {
  for (const [sessionId, state] of clientPresentationSessions.entries()) {
    if (state.expiresAt <= now) clientPresentationSessions.delete(sessionId);
  }
}

function readUiExtensionCapability(params: Record<string, unknown>): boolean {
  const capabilities = params["capabilities"];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities["extensions"];
  if (!isRecord(extensions)) return false;
  return isRecord(extensions[UI_EXTENSION_KEY]);
}

function requestOriginSupportsUi(req: Request): boolean {
  for (const headerName of ["origin", "referer"]) {
    const raw = req.headers.get(headerName);
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function getClientPresentationForRequest(req: Request, params?: Record<string, unknown>): ClientPresentationState {
  pruneExpiredClientPresentationSessions();
  const sessionId = req.headers.get(MCP_SESSION_HEADER)?.trim();
  if (sessionId) {
    const state = clientPresentationSessions.get(sessionId);
    if (state) return state;
  }
  return {
    supportsUi: requestOriginSupportsUi(req) || (params ? readUiExtensionCapability(params) : false),
    expiresAt: Date.now() + CLIENT_PRESENTATION_TTL_MS
  };
}

function storeClientPresentationForInitialize(req: Request, params: Record<string, unknown>): {
  sessionId: string;
  state: ClientPresentationState;
} {
  const sessionId = crypto.randomUUID();
  const state = {
    supportsUi: requestOriginSupportsUi(req) || readUiExtensionCapability(params),
    expiresAt: Date.now() + CLIENT_PRESENTATION_TTL_MS
  };
  clientPresentationSessions.set(sessionId, state);
  return { sessionId, state };
}

function validateProtocolVersionHeader(req: Request, payload: JsonRpcRequest, traceId: string): Response | undefined {
  if (payload.method === "initialize") return undefined;
  const requestedVersion = req.headers.get("mcp-protocol-version")?.trim();
  if (!requestedVersion) return undefined;
  if (SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) return undefined;
  return mcpJsonRpcError(
    null,
    -32600,
    "Unsupported MCP-Protocol-Version header.",
    traceId,
    400,
    undefined,
    {
      requestedProtocolVersion: requestedVersion,
      supportedProtocolVersions: Array.from(SUPPORTED_PROTOCOL_VERSIONS)
    }
  );
}

async function readJsonRpcPayload(req: Request, maxBytes: number): Promise<{ payload?: unknown; response?: Response }> {
  const traceId = req.headers.get("x-trace-id") || crypto.randomUUID();
  const contentLength = parseContentLength(req);
  if (contentLength !== undefined && contentLength > maxBytes) {
    const errorId = crypto.randomUUID();
    return {
      response: jsonResponse(
        413,
        errorEnvelope("REQUEST_BODY_TOO_LARGE", "Request body exceeds configured limit.", traceId, errorId, {
          maxBytes
        }),
        { "x-trace-id": traceId }
      )
    };
  }

  if (!req.body) {
    const errorId = crypto.randomUUID();
    return {
      response: jsonResponse(
        400,
        errorEnvelope("INVALID_JSON", "Request body is empty.", traceId, errorId),
        { "x-trace-id": traceId }
      )
    };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      const errorId = crypto.randomUUID();
      return {
        response: jsonResponse(
          413,
          errorEnvelope("REQUEST_BODY_TOO_LARGE", "Request body exceeds configured limit.", traceId, errorId, {
            maxBytes
          }),
          { "x-trace-id": traceId }
        )
      };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!isRecord(payload) && !Array.isArray(payload)) {
      const errorId = crypto.randomUUID();
      return {
        response: jsonResponse(
          400,
          errorEnvelope("INVALID_REQUEST", "JSON-RPC payload must be an object.", traceId, errorId),
          { "x-trace-id": traceId }
        )
      };
    }
    return { payload };
  } catch {
    const errorId = crypto.randomUUID();
    return {
      response: jsonResponse(
        400,
        errorEnvelope("INVALID_JSON", "Invalid JSON payload.", traceId, errorId),
        { "x-trace-id": traceId }
      )
    };
  }
}

export async function handleMcpRequest(
  req: Request,
  deps: ToolDeps,
  widgetSource: string,
  widgetDomain: string,
  connectDomains: string[],
  options?: McpHandlerOptions
): Promise<Response> {
  const traceId = req.headers.get("x-trace-id") || crypto.randomUUID();
  const requestStartedAt = Date.now();
  const maxRequestBodyBytes = Math.max(options?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES, 64_000);
  const parsed = await readJsonRpcPayload(req, maxRequestBodyBytes);
  if (parsed.response) {
    return parsed.response;
  }
  const payload = parsed.payload as JsonRpcRequest | JsonRpcResponsePayload | unknown[];

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return mcpJsonRpcError(null, -32600, "Invalid JSON-RPC batch request.", traceId, 400);
    }

    if (payload.every((item) => isJsonRpcResponsePayload(item) || isJsonRpcNotification(item))) {
      return acceptedResponse(traceId);
    }

    const responses: unknown[] = [];
    for (const item of payload) {
      if (isJsonRpcResponsePayload(item) || isJsonRpcNotification(item)) continue;
      const itemHeaders = new Headers(req.headers);
      itemHeaders.delete("content-length");
      const singleRequest = new Request(req.url, {
        method: req.method,
        headers: itemHeaders,
        body: JSON.stringify(item)
      });
      const singleResponse = await handleMcpRequest(
        singleRequest,
        deps,
        widgetSource,
        widgetDomain,
        connectDomains,
        options
      );
      if (singleResponse.status !== 200) {
        return singleResponse;
      }
      responses.push(await singleResponse.json());
    }

    return jsonResponse(200, responses, { "x-trace-id": traceId, "cache-control": "no-store" });
  }

  if (isJsonRpcResponsePayload(payload) || isJsonRpcNotification(payload)) {
    return acceptedResponse(traceId);
  }

  const requestCandidate = payload as Record<string, unknown>;
  if (requestCandidate["jsonrpc"] !== "2.0" || typeof requestCandidate["method"] !== "string") {
    return mcpJsonRpcError(null, -32600, "Invalid JSON-RPC request.", traceId, 400);
  }

  const requestPayload = payload as JsonRpcRequest;

  const protocolVersionError = validateProtocolVersionHeader(req, requestPayload, traceId);
  if (protocolVersionError) {
    return protocolVersionError;
  }

  const id = requestPayload.id ?? null;
  const method = requestPayload.method || "";
  const params = parseRequestParams(requestPayload);

  try {
    if (method === "initialize") {
      const requestedProtocolVersion = typeof params["protocolVersion"] === "string"
        ? String(params["protocolVersion"])
        : undefined;
      const protocolVersion = negotiatedProtocolVersion(requestedProtocolVersion);
      const presentation = storeClientPresentationForInitialize(req, params);
      const initializeCapabilities: Record<string, unknown> = {
        tools: { listChanged: false }
      };
      if (presentation.state.supportsUi) {
        initializeCapabilities["resources"] = { listChanged: false };
      }
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.initialize",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          serverInfo: { name: "vibecodr-openai-app", version: "0.2.0" },
          capabilities: initializeCapabilities
        }
      }, { "x-trace-id": traceId, "cache-control": "no-store", [MCP_SESSION_HEADER]: presentation.sessionId });
    }

    if (method === "ping") {
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.ping",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(200, { jsonrpc: "2.0", id, result: {} }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    if (method === "tools/list") {
      const presentation = getClientPresentationForRequest(req, params);
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.tools.list",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(
        200,
        { jsonrpc: "2.0", id, result: { tools: getTools({ includeOutputSchema: false, supportsUi: presentation.supportsUi }) } },
        { "x-trace-id": traceId, "cache-control": "no-store" }
      );
    }

    if (method === "tools/call") {
      const presentation = getClientPresentationForRequest(req, params);
      const name = String(params["name"] || "");
      const args =
        params["arguments"] && typeof params["arguments"] === "object" && !Array.isArray(params["arguments"])
          ? (params["arguments"] as Record<string, unknown>)
          : {};
      const requiredScopes = ["openid", "profile", "email", "offline_access"];
      const resourceMetadataUri = deps.appBaseUrl.replace(/\/$/, "") + "/.well-known/oauth-protected-resource/mcp";
      const session = toolRequiresAuth(name)
        ? await getSessionForToolRequest(req, deps, traceId)
        : null;
      if (toolRequiresAuth(name) && !session) {
        const challengeError = req.headers.get("authorization") || req.headers.get("cookie")
          ? "invalid_token"
          : undefined;
        deps.telemetry.auth({
          traceId,
          event: "tool_auth_challenge",
          outcome: "challenge",
          provider: "vibecodr",
          endpoint: "/mcp",
          details: { toolName: name }
        });
        return mcpJsonRpcError(
          id,
          -32001,
          "Authentication required.",
          traceId,
          401,
          {
            "www-authenticate": buildToolWwwAuthenticate(deps.appBaseUrl, {
              scope: requiredScopes.join(" "),
              ...(challengeError ? { error: challengeError } : {})
            }),
            "cache-control": "no-store"
          },
          {
            authChallenge: {
              authorizationUri: deps.appBaseUrl.replace(/\/$/, "") + "/authorize",
              resourceMetadataUri,
              requiredScopes,
              ...(challengeError ? { error: challengeError } : {})
            }
          }
        );
      }
      const result = await callTool(req, deps, name, args, session, { supportsUi: presentation.supportsUi });
      const outcome = result._meta?.["mcp/www_authenticate"] ? "challenge" : result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent) && typeof (result.structuredContent as Record<string, unknown>)["error"] === "string"
        ? "failure"
        : "success";
      const errorCode = outcome === "failure" && result.structuredContent && typeof result.structuredContent === "object"
        ? String((result.structuredContent as Record<string, unknown>)["error"] || "")
        : undefined;
      deps.telemetry.tool({
        traceId,
        toolName: name,
        outcome,
        latencyMs: Date.now() - requestStartedAt,
        errorCode
      });
      return jsonResponse(200, { jsonrpc: "2.0", id, result }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    if (method === "resources/list") {
      const presentation = getClientPresentationForRequest(req, params);
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.resources.list",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id,
        result: {
          resources: presentation.supportsUi
            ? [
                {
                  uri: "ui://widget/publisher-v1",
                  name: "Vibecodr.Space",
                  mimeType: "text/html;profile=mcp-app",
                  _meta: {
                    ui: { uri: "ui://widget/publisher-v1", domain: widgetDomain },
                    "openai/widgetDescription":
                      "Vibecodr.Space is a social platform where code runs as content. This widget supports a guided publish flow: connect once, answer only the missing launch questions, and publish the generated app as a live, remixable vibe on the timeline.",
                    "openai/widgetPrefersBorder": true,
                    "openai/widgetDomain": widgetDomain
                  }
                }
              ]
            : []
        }
      }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    if (method === "resources/read") {
      const presentation = getClientPresentationForRequest(req, params);
      const uri = String(params["uri"] || "");
      if (!presentation.supportsUi || uri !== "ui://widget/publisher-v1") {
        deps.telemetry.tool({
          traceId,
          toolName: "mcp.resources.read",
          outcome: "failure",
          latencyMs: Date.now() - requestStartedAt,
          errorCode: "UNKNOWN_RESOURCE_URI"
        });
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32002,
            message: "Unknown resource URI",
            data: { traceId, errorId: crypto.randomUUID() }
          }
        }, { "x-trace-id": traceId, "cache-control": "no-store" });
      }
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.resources.read",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: "ui://widget/publisher-v1",
              mimeType: "text/html;profile=mcp-app",
              text: widgetSource,
              _meta: {
                ui: {
                  uri: "ui://widget/publisher-v1",
                  domain: widgetDomain,
                  csp: {
                    connect_domains: connectDomains,
                    resource_domains: [widgetDomain]
                  }
                },
                "openai/widgetDescription":
                  "Vibecodr.Space is a social platform where code runs as content. This widget supports a guided publish flow: connect once, answer only the missing launch questions, and publish the generated app as a live, remixable vibe on the timeline.",
                "openai/widgetPrefersBorder": true,
                "openai/widgetDomain": widgetDomain,
                "openai/widgetCSP": {
                  connect_domains: connectDomains,
                  resource_domains: [widgetDomain]
                }
              }
            }
          ]
        }
      }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    deps.telemetry.tool({
      traceId,
      toolName: "mcp.unknown_method",
      outcome: "failure",
      latencyMs: Date.now() - requestStartedAt,
      errorCode: "METHOD_NOT_FOUND"
    });
    return mcpJsonRpcError(id, -32601, "Method not found", traceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("mcp.request_error", {
      traceId,
      method,
      error: message
    });
    deps.telemetry.tool({
      traceId,
      toolName: method || "mcp.unknown",
      outcome: "failure",
      latencyMs: Date.now() - requestStartedAt,
      errorCode: "MCP_REQUEST_ERROR"
    });
    return mcpJsonRpcError(id, -32000, message, traceId);
  }
}
