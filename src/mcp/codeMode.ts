import { findCapabilityById, getCapabilityCatalog, type CapabilityCatalogEntry } from "./capabilityCatalog.js";
import { callTool, type ToolDeps, type ToolDescriptor, type ToolResult } from "./tools.js";
import {
  executeCodeModeInDynamicWorker,
  jsonByteLength,
  limitCodeModeLogs,
  resolveCodeModeRuntime,
  type CodeModeRuntimePolicy
} from "./codeModeRuntime.js";
import type { SessionRecord } from "../types.js";

type CodeModeToolResult = ToolResult;

const CODE_MODE_SECURITY_NOAUTH = [{ type: "noauth" }];
const CODE_MODE_SECURITY_OAUTH = [{ type: "oauth2", scopes: ["openid", "profile", "email", "offline_access"] }];

const codeInputSchema = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "Optional JavaScript async arrow function for multi-step orchestration. Omit when using top-level query or capabilityId."
    },
    query: { type: "string" },
    capabilityId: { type: "string" },
    arguments: { type: "object", additionalProperties: true },
    confirmed: { type: "boolean" }
  },
  additionalProperties: false
} as const;

export function isCodeModeRequest(req: Request, defaultEnabled = false): boolean {
  try {
    const param = new URL(req.url).searchParams.get("codemode");
    if (param === "false") return false;
    return param === "search_and_execute" || (defaultEnabled && param == null);
  } catch {
    return false;
  }
}

export function getCodeModeTools(): ToolDescriptor[] {
  return [
    {
      name: "search",
      title: "Search Vibecodr Capabilities",
      description:
        "Search the server-side Vibecodr capability catalog. Use this to discover tools, schemas, constraints, workflow lanes, and hidden recovery capabilities without loading every native tool into context.",
      securitySchemes: CODE_MODE_SECURITY_NOAUTH,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      inputSchema: codeInputSchema,
      _meta: { securitySchemes: CODE_MODE_SECURITY_NOAUTH }
    },
    {
      name: "execute",
      title: "Execute Vibecodr Capability",
      description:
        "Execute a discovered Vibecodr capability through the gateway-owned host proxy. Destructive capabilities require explicit confirmation and authenticated user context.",
      securitySchemes: CODE_MODE_SECURITY_OAUTH,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      inputSchema: codeInputSchema,
      _meta: { securitySchemes: CODE_MODE_SECURITY_OAUTH }
    }
  ];
}

export function codeModeToolRequiresAuth(name: string): boolean {
  return name === "execute";
}

function errorResult(text: string, error: string, message?: string, extra?: Record<string, unknown>): CodeModeToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { error, ...(message ? { message } : {}), ...(extra || {}), errorId: crypto.randomUUID() }
  };
}

function compactEntry(entry: CapabilityCatalogEntry) {
  return {
    id: entry.id,
    namespace: entry.namespace,
    title: entry.title,
    purpose: entry.purpose,
    visibility: entry.visibility,
    kind: entry.kind,
    executionStatus: entry.executionStatus,
    nativeToolName: entry.nativeToolName,
    authRequired: entry.authRequired,
    destructive: entry.destructive,
    confirmationRequired: entry.confirmationRequired,
    argumentSummary: entry.argumentSummary,
    keywords: entry.keywords,
    notes: entry.notes
  };
}

function detailedEntry(entry: CapabilityCatalogEntry) {
  return {
    ...compactEntry(entry),
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    examples: entry.examples || []
  };
}

function extractSearchTerms(code: string, query?: string): string[] {
  const source = [code, query || ""].join(" ").toLowerCase();
  const quoted = [...source.matchAll(/["'`]([^"'`]{2,80})["'`]/g)]
    .map((match) => match[1])
    .filter((value): value is string => typeof value === "string");
  const words = source.split(/[^a-z0-9_.-]+/).filter((word) => word.length >= 3);
  return [...new Set([...quoted, ...words].filter(Boolean))];
}

function entryMatches(entry: CapabilityCatalogEntry, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    entry.id,
    entry.namespace,
    entry.title,
    entry.purpose,
    entry.visibility,
    entry.kind,
    entry.nativeToolName || "",
    ...entry.keywords,
    ...entry.notes
  ].join(" ").toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function inferCapabilityId(code: string): string | undefined {
  const direct = code.match(/capabilityId\s*[:=]\s*["'`]([^"'`]+)["'`]/)?.[1];
  if (direct) return direct;
  const nativeCall = code.match(/(?:vibecodr|codemode)\.([a-zA-Z0-9_]+)\s*\(/)?.[1];
  return nativeCall ? "native." + nativeCall : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function searchCapabilityCatalog(code: string, query?: string, capabilityId?: string) {
  if (capabilityId) {
    const exact = findCapabilityById(capabilityId);
    return {
      mode: "search",
      terms: [capabilityId],
      results: exact ? [detailedEntry(exact)] : []
    };
  }
  const terms = extractSearchTerms(code, query);
  const results = getCapabilityCatalog()
    .filter((entry) => entryMatches(entry, terms))
    .slice(0, 20)
    .map(compactEntry);
  return {
    mode: "search",
    terms,
    results
  };
}

function structuredErrorCode(result: CodeModeToolResult): string | undefined {
  const record = asRecord(result.structuredContent);
  return typeof record["error"] === "string" ? record["error"] : undefined;
}

function enforceOutputLimit(result: CodeModeToolResult, policy?: CodeModeRuntimePolicy, runtime = "native_fallback"): CodeModeToolResult {
  if (!policy) return result;
  if (jsonByteLength(result.structuredContent ?? result.content) <= policy.maxOutputBytes) return result;
  return errorResult("Code Mode output exceeded the configured size limit.", "CODEMODE_OUTPUT_TOO_LARGE", undefined, {
    runtime,
    maxOutputBytes: policy.maxOutputBytes
  });
}

function recordNestedCapabilityTelemetry(
  deps: ToolDeps,
  req: Request,
  capability: CapabilityCatalogEntry,
  startedAt: number,
  outcome: "success" | "failure",
  errorCode?: string,
  session?: SessionRecord | null
): void {
  deps.telemetry.event("codemode.nested_call", outcome === "failure" ? "warn" : "info", {
    traceId: req.headers.get("x-trace-id") || undefined,
    userHash: deps.telemetry.userHash(session?.userId),
    latencyMs: Date.now() - startedAt,
    errorCode,
    details: {
      capabilityId: capability.id,
      nativeToolName: capability.nativeToolName,
      visibility: capability.visibility,
      authRequired: capability.authRequired,
      destructive: capability.destructive,
      confirmationRequired: capability.confirmationRequired,
      outcome
    }
  });
}

async function executeCapability(
  req: Request,
  deps: ToolDeps,
  code: string,
  args: Record<string, unknown>,
  session: SessionRecord | null
): Promise<CodeModeToolResult> {
  const capabilityId = typeof args["capabilityId"] === "string" && args["capabilityId"].trim()
    ? args["capabilityId"].trim()
    : inferCapabilityId(code);
  if (!capabilityId) {
    return errorResult("execute requires capabilityId or a recognizable vibecodr.<nativeTool>() call.", "MISSING_CAPABILITY_ID");
  }

  const capability = findCapabilityById(capabilityId);
  if (!capability) {
    return errorResult("Unknown Vibecodr capability: " + capabilityId, "UNKNOWN_CAPABILITY");
  }

  const startedAt = Date.now();
  if (capability.confirmationRequired && args["confirmed"] !== true) {
    recordNestedCapabilityTelemetry(deps, req, capability, startedAt, "failure", "CONFIRMATION_REQUIRED", session);
    return {
      content: [{ type: "text", text: "This capability needs explicit confirmation before execution." }],
      structuredContent: {
        confirmationRequired: true,
        capability: compactEntry(capability),
        userMessage: "Confirm before executing " + capability.title + "."
      }
    };
  }

  if (!capability.nativeToolName) {
    recordNestedCapabilityTelemetry(deps, req, capability, startedAt, "failure", "CATALOG_ONLY_CAPABILITY", session);
    return errorResult("Capability is catalog-only and cannot be executed by this gateway.", "CATALOG_ONLY_CAPABILITY", undefined, {
      capability: compactEntry(capability)
    });
  }

  const toolArgs = args["arguments"] && typeof args["arguments"] === "object" && !Array.isArray(args["arguments"])
    ? args["arguments"] as Record<string, unknown>
    : {};
  const topLevelForwarding = Object.entries(args).reduce<Record<string, unknown>>((acc, [key, value]) => {
    if (!["code", "capabilityId", "query", "arguments"].includes(key) && value !== undefined) {
      acc[key] = value;
    }
    return acc;
  }, {});
  const mergedToolArgs = {
    ...topLevelForwarding,
    ...toolArgs
  };
  const result = await callTool(req, deps, capability.nativeToolName, mergedToolArgs, session);
  const errorCode = structuredErrorCode(result);
  recordNestedCapabilityTelemetry(deps, req, capability, startedAt, errorCode ? "failure" : "success", errorCode, session);
  return {
    ...result,
    structuredContent: {
      mode: "execute",
      capability: compactEntry(capability),
      result: result.structuredContent
    }
  };
}

function buildSandboxProviders(
  req: Request,
  deps: ToolDeps,
  code: string,
  session: SessionRecord | null,
  policy: CodeModeRuntimePolicy
) {
  let nestedCalls = 0;
  const gate = async <T>(run: () => Promise<T>): Promise<T> => {
    nestedCalls += 1;
    if (nestedCalls > policy.maxNestedCalls) {
      throw new Error("CODEMODE_NESTED_CALL_LIMIT_EXCEEDED");
    }
    return run();
  };
  const fns = {
    search: async (input: unknown) => gate(async () => {
      const record = asRecord(input);
      const searchCode = typeof record["code"] === "string" ? record["code"] : code;
      const query = typeof record["query"] === "string" ? record["query"] : undefined;
      const capabilityId = typeof record["capabilityId"] === "string" ? record["capabilityId"] : undefined;
      return searchCapabilityCatalog(searchCode, query, capabilityId);
    }),
    execute: async (input: unknown) => gate(async () => {
      if (!session) throw new Error("AUTH_REQUIRED");
      const record = asRecord(input);
      const executeCode = typeof record["code"] === "string" ? record["code"] : code;
      const result = await executeCapability(req, deps, executeCode, record, session);
      return result.structuredContent || result.content;
    })
  };
  return [
    { name: "codemode", fns },
    { name: "vibecodr", fns }
  ];
}

async function callDynamicWorkerCodeModeTool(
  req: Request,
  deps: ToolDeps,
  name: string,
  code: string,
  args: Record<string, unknown>,
  session: SessionRecord | null,
  policy: CodeModeRuntimePolicy
): Promise<CodeModeToolResult> {
  if (name === "search" && (typeof args["capabilityId"] === "string" || typeof args["query"] === "string")) {
    const search = searchCapabilityCatalog(
      code,
      typeof args["query"] === "string" ? args["query"] : undefined,
      typeof args["capabilityId"] === "string" ? args["capabilityId"] : undefined
    );
    return enforceOutputLimit({
      content: [{ type: "text", text: "Found " + search.results.length + " Vibecodr capabilities." }],
      structuredContent: { ...search, runtime: "dynamic_worker" }
    }, policy, "dynamic_worker");
  }
  if (name === "execute" && typeof args["capabilityId"] === "string") {
    const result = await executeCapability(req, deps, code, args, session);
    return enforceOutputLimit({
      ...result,
      structuredContent: {
        runtime: "dynamic_worker",
        ...(asRecord(result.structuredContent))
      }
    }, policy, "dynamic_worker");
  }

  const execution = await executeCodeModeInDynamicWorker(
    code,
    policy,
    buildSandboxProviders(req, deps, code, session, policy)
  );
  const logs = limitCodeModeLogs(execution.logs, policy.maxLogBytes);
  if (execution.error) {
    return errorResult("Code Mode sandbox execution failed: " + execution.error, "CODEMODE_EXECUTION_FAILED", execution.error, {
      runtime: "dynamic_worker",
      ...(logs?.length ? { logs } : {})
    });
  }

  const resultRecord = asRecord(execution.result);
  const structuredContent = Object.keys(resultRecord).length > 0
    ? { ...resultRecord, runtime: "dynamic_worker", ...(logs?.length ? { logs } : {}) }
    : { mode: name, runtime: "dynamic_worker", result: execution.result, ...(logs?.length ? { logs } : {}) };
  if (jsonByteLength(structuredContent) > policy.maxOutputBytes) {
    return errorResult("Code Mode output exceeded the configured size limit.", "CODEMODE_OUTPUT_TOO_LARGE", undefined, {
      runtime: "dynamic_worker",
      maxOutputBytes: policy.maxOutputBytes
    });
  }

  const text = name === "search" && Array.isArray(resultRecord["results"])
    ? "Found " + resultRecord["results"].length + " Vibecodr capabilities."
    : "Code Mode sandbox completed.";
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

export async function callCodeModeTool(
  req: Request,
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  session: SessionRecord | null
): Promise<CodeModeToolResult> {
  const code = typeof args["code"] === "string" ? args["code"] : "";
  const hasDirectSearchInput =
    name === "search" && (typeof args["query"] === "string" || typeof args["capabilityId"] === "string");
  const hasDirectExecuteInput = name === "execute" && typeof args["capabilityId"] === "string";
  if (!code.trim() && !hasDirectSearchInput && !hasDirectExecuteInput) {
    return errorResult(
      "Code Mode requires code, query, or capabilityId.",
      "MISSING_CODE"
    );
  }

  const runtime = resolveCodeModeRuntime(deps.codeMode);
  if (!runtime.available) {
    return errorResult("Code Mode cannot run: " + runtime.message, runtime.error, runtime.message, {
      dynamicWorkerRequired: deps.codeMode?.requireDynamicWorker === true
    });
  }

  if (runtime.mode === "dynamic_worker") {
    return callDynamicWorkerCodeModeTool(req, deps, name, code, args, session, deps.codeMode!);
  }

  if (name === "search") {
    const search = searchCapabilityCatalog(
      code,
      typeof args["query"] === "string" ? args["query"] : undefined,
      typeof args["capabilityId"] === "string" ? args["capabilityId"] : undefined
    );
    return enforceOutputLimit({
      content: [{ type: "text", text: "Found " + search.results.length + " Vibecodr capabilities." }],
      structuredContent: search
    }, deps.codeMode);
  }

  if (name !== "execute") {
    return errorResult("Unknown Code Mode tool: " + name, "UNKNOWN_CODEMODE_TOOL");
  }

  return enforceOutputLimit(await executeCapability(req, deps, code, args, session), deps.codeMode);
}
