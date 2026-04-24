import {
  buildToolWwwAuthenticate,
  getSessionForToolRequest,
  type ToolResult,
  type ToolDeps
} from "./tools.js";
import { isCodeModeRequest } from "./codeMode.js";
import { createVibecodrMcpServer } from "./server.js";
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

type ToolCallResult = ToolResult;
type ToolCallOutcome = "success" | "failure" | "challenge";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_500_000;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_FALLBACK_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
const MCP_SESSION_HEADER = "mcp-session-id";
const REQUIRED_TOOL_SCOPES = ["openid", "profile", "email", "offline_access"];
const MCP_SERVER_INSTRUCTIONS = [
  "Start with Vibecodr product intent: help the user publish, inspect, polish, share, remix, and understand vibes on vibecodr.space.",
  "For fresh publish flows, safely read get_upload_capabilities, get_guided_publish_requirements, and optionally the publish_creation_end_to_end prompt before any write; ask only for missing package, entry, visibility, cover, or SEO details.",
  "Never make a vibe live, update live metadata, publish a draft, or cancel an operation until the user has explicitly confirmed the exact action; pass confirmed: true only after that confirmation.",
  "Prefer product-level tools over operation internals. Use recovery tools only after a guided flow fails or the user explicitly asks for diagnostics.",
  "In Code Mode, use search for progressive discovery, request exact capability detail before execute, and remember catalog-only entries describe planned or policy lanes but are not callable."
].join("\n");
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
]);

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

function structuredContentRecord(result: ToolCallResult): Record<string, unknown> | undefined {
  return isRecord(result.structuredContent) ? result.structuredContent : undefined;
}

function getToolCallOutcome(result: ToolCallResult): ToolCallOutcome {
  if (result._meta?.["mcp/www_authenticate"]) return "challenge";
  return typeof structuredContentRecord(result)?.["error"] === "string" ? "failure" : "success";
}

function getToolErrorCode(result: ToolCallResult): string | undefined {
  const record = structuredContentRecord(result);
  return typeof record?.["error"] === "string" ? record["error"] : undefined;
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
  options?: McpHandlerOptions
): Promise<Response> {
  const traceId = req.headers.get("x-trace-id") || crypto.randomUUID();
  const requestStartedAt = Date.now();
  const codeMode = isCodeModeRequest(req, deps.codeMode?.defaultEnabled === true);
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
  const mcpServer = createVibecodrMcpServer({ mode: codeMode ? "codemode" : "native", req, deps });

  try {
    if (method === "initialize") {
      const requestedProtocolVersion = typeof params["protocolVersion"] === "string"
        ? String(params["protocolVersion"])
        : undefined;
      const protocolVersion = negotiatedProtocolVersion(requestedProtocolVersion);
      const sessionId = crypto.randomUUID();
      const initializeCapabilities: Record<string, unknown> = {
        tools: { listChanged: false },
        prompts: { listChanged: false }
      };
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
          serverInfo: mcpServer.serverInfo,
          capabilities: initializeCapabilities,
          instructions: MCP_SERVER_INSTRUCTIONS
        }
      }, { "x-trace-id": traceId, "cache-control": "no-store", [MCP_SESSION_HEADER]: sessionId });
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
      deps.telemetry.tool({
        traceId,
        toolName: codeMode ? "mcp.codemode.tools.list" : "mcp.tools.list",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            tools: mcpServer.listTools({ includeOutputSchema: false })
          }
        },
        { "x-trace-id": traceId, "cache-control": "no-store" }
      );
    }

    if (method === "prompts/list") {
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.prompts.list",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(
        200,
        { jsonrpc: "2.0", id, result: { prompts: mcpServer.listPrompts() } },
        { "x-trace-id": traceId, "cache-control": "no-store" }
      );
    }

    if (method === "prompts/get") {
      const name = String(params["name"] || "");
      const args =
        params["arguments"] && typeof params["arguments"] === "object" && !Array.isArray(params["arguments"])
          ? (params["arguments"] as Record<string, unknown>)
          : {};
      const prompt = mcpServer.getPrompt(name, args);
      if (!prompt) {
        deps.telemetry.tool({
          traceId,
          toolName: "mcp.prompts.get",
          outcome: "failure",
          latencyMs: Date.now() - requestStartedAt,
          errorCode: "UNKNOWN_PROMPT"
        });
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: "Unknown prompt",
            data: { traceId, errorId: crypto.randomUUID() }
          }
        }, { "x-trace-id": traceId, "cache-control": "no-store" });
      }
      deps.telemetry.tool({
        traceId,
        toolName: "mcp.prompts.get",
        outcome: "success",
        latencyMs: Date.now() - requestStartedAt
      });
      return jsonResponse(
        200,
        { jsonrpc: "2.0", id, result: prompt },
        { "x-trace-id": traceId, "cache-control": "no-store" }
      );
    }

    if (method === "tools/call") {
      const name = String(params["name"] || "");
      const args =
        params["arguments"] && typeof params["arguments"] === "object" && !Array.isArray(params["arguments"])
          ? (params["arguments"] as Record<string, unknown>)
          : {};
      const resourceMetadataUri = deps.appBaseUrl.replace(/\/$/, "") + "/.well-known/oauth-protected-resource/mcp";
      const requiresAuth = mcpServer.toolRequiresAuth(name);
      const session = requiresAuth
        ? await getSessionForToolRequest(req, deps, traceId)
        : null;
      if (requiresAuth && !session) {
        const challengeError = req.headers.get("authorization") || req.headers.get("cookie")
          ? "invalid_token"
          : undefined;
        deps.telemetry.auth({
          traceId,
          event: "tool_auth_challenge",
          outcome: "challenge",
          provider: "vibecodr",
          endpoint: "/mcp",
          details: { toolName: codeMode ? "codemode." + name : name }
        });
        return mcpJsonRpcError(
          id,
          -32001,
          "Authentication required.",
          traceId,
          401,
          {
            "www-authenticate": buildToolWwwAuthenticate(deps.appBaseUrl, {
              scope: REQUIRED_TOOL_SCOPES.join(" "),
              ...(challengeError ? { error: challengeError } : {})
            }),
            "cache-control": "no-store"
          },
          {
            authChallenge: {
              authorizationUri: deps.appBaseUrl.replace(/\/$/, "") + "/authorize",
              resourceMetadataUri,
              requiredScopes: REQUIRED_TOOL_SCOPES,
              ...(challengeError ? { error: challengeError } : {})
            }
          }
        );
      }
      const result = await mcpServer.callTool(req, deps, name, args, session);
      const outcome = getToolCallOutcome(result);
      const errorCode = outcome === "failure" ? getToolErrorCode(result) : undefined;
      deps.telemetry.tool({
        traceId,
        toolName: codeMode ? "codemode." + name : name,
        outcome,
        latencyMs: Date.now() - requestStartedAt,
        errorCode
      });
      return jsonResponse(200, { jsonrpc: "2.0", id, result }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    if (method === "resources/list") {
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
          resources: mcpServer.listResources()
        }
      }, { "x-trace-id": traceId, "cache-control": "no-store" });
    }

    if (method === "resources/read") {
      const uri = typeof params["uri"] === "string" ? params["uri"] : "";
      const resource = mcpServer.readResource(uri);
      if (resource) {
        deps.telemetry.tool({
          traceId,
          toolName: "mcp.resources.read",
          outcome: "success",
          latencyMs: Date.now() - requestStartedAt
        });
        return jsonResponse(200, { jsonrpc: "2.0", id, result: resource }, { "x-trace-id": traceId, "cache-control": "no-store" });
      }
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
