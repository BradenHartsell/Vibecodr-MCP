import test from "node:test";
import assert from "node:assert/strict";
import { loadConfigFromSource } from "../src/config.js";
import { getCapabilityCatalog } from "../src/mcp/capabilityCatalog.js";
import { getCodeModeTools } from "../src/mcp/codeMode.js";
import { buildDynamicWorkerExecutorOptions } from "../src/mcp/codeModeRuntime.js";
import { getPrompt, getPrompts } from "../src/mcp/prompts.js";
import { createVibecodrMcpServer } from "../src/mcp/server.js";
import { callTool, getTools, type ToolDeps } from "../src/mcp/tools.js";
import type { ImportOperation, SessionRecord } from "../src/types.js";

type RecommendedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

const testSession: SessionRecord = {
  sessionId: "sess_resume",
  userId: "user_resume",
  userHandle: "resume",
  vibecodrToken: "token_resume",
  createdAt: 1,
  expiresAt: Date.now() + 60_000
};

function assertRecommendedToolCallSatisfiesInputSchema(call: RecommendedToolCall) {
  const tool = getTools({ includeHidden: true }).find((candidate) => candidate.name === call.name);
  assert.ok(tool, call.name + " is not a registered tool");
  assert.equal(typeof call.arguments, "object");

  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(call.arguments, key),
      true,
      call.name + " recommendation missing required argument " + key
    );
  }
}

function resumeDeps(operations: ImportOperation[], liveVibes: unknown[] = []): ToolDeps {
  return {
    appBaseUrl: "https://openai.vibecodr.space",
    vibecodrApiBase: "https://api.vibecodr.space",
    featureFlags: {
      enableCodexImportPath: true,
      enableChatGptImportPath: true,
      enablePublishFromChatGpt: true
    },
    operationStore: {
      async listByUser() {
        return operations;
      }
    },
    importService: {
      async refreshPendingOperations() {
        return operations;
      }
    },
    vibecodr: {
      async listMyLiveVibes() {
        return liveVibes;
      }
    },
    sessionStore: {},
    telemetry: {
      auth() {}
    }
  } as unknown as ToolDeps;
}

async function resumeLatestRecommendation(deps: ToolDeps): Promise<RecommendedToolCall> {
  const result = await callTool(
    new Request("https://openai.vibecodr.space/mcp"),
    deps,
    "resume_latest_publish_flow",
    {},
    testSession
  );
  const structured = result.structuredContent as { recommendedToolCall?: RecommendedToolCall };
  assert.ok(structured.recommendedToolCall);
  return structured.recommendedToolCall;
}

test("default tool list is product-shaped and excludes recovery-only failure explanation", () => {
  const visibleNames = getTools().map((tool) => tool.name);
  const quickPublish = getTools().find((tool) => tool.name === "quick_publish_creation");

  assert.equal(visibleNames.includes("get_guided_publish_requirements"), true);
  assert.equal(visibleNames.includes("prepare_publish_package"), true);
  assert.equal(visibleNames.includes("validate_creation_payload"), true);
  assert.equal(visibleNames.includes("quick_publish_creation"), true);
  assert.equal(visibleNames.includes("get_runtime_readiness"), true);
  assert.equal(visibleNames.includes("resume_latest_publish_flow"), true);
  assert.equal(visibleNames.includes("discover_vibes"), true);
  assert.equal(visibleNames.includes("search_vibecodr"), true);
  assert.equal(visibleNames.includes("get_thread_context"), true);
  assert.equal(visibleNames.includes("build_share_copy"), true);
  assert.equal(visibleNames.includes("get_launch_checklist"), true);
  assert.equal(visibleNames.includes("explain_operation_failure"), false);
  assert.equal(visibleNames.includes("watch_operation"), false);
  assert.equal(visibleNames.includes("get_launch_best_practices"), true);
  assert.equal((quickPublish?.inputSchema.properties as Record<string, unknown> | undefined)?.["confirmed"] !== undefined, true);
});

test("hidden-inclusive tool list preserves compatibility handlers", () => {
  const allNames = getTools({ includeHidden: true }).map((tool) => tool.name);

  assert.equal(allNames.includes("explain_operation_failure"), true);
  assert.equal(allNames.includes("watch_operation"), true);
  assert.equal(allNames.includes("get_guided_publish_requirements"), true);
});

test("capability catalog covers native handlers and future lane-shaped capabilities", () => {
  const catalog = getCapabilityCatalog();
  const ids = catalog.map((entry) => entry.id);
  const nativeHandlerNames = catalog
    .map((entry) => entry.nativeToolName)
    .filter((name): name is string => typeof name === "string");

  for (const tool of getTools({ includeHidden: true })) {
    assert.equal(nativeHandlerNames.includes(tool.name), true, tool.name + " missing from catalog");
  }

  assert.equal(ids.includes("publish.import_package"), true);
  assert.equal(ids.includes("publish.compile_draft"), true);
  assert.equal(ids.includes("publish.publish_capsule"), true);
  assert.equal(ids.includes("runtime.readiness"), true);
  assert.equal(ids.includes("pulses.lifecycle"), true);
  assert.equal(ids.includes("social.read"), true);
  assert.equal(ids.includes("ops.error_triage"), true);
  assert.equal(catalog.find((entry) => entry.id === "native.quick_publish_creation")?.executionStatus, "callable");
  assert.equal(catalog.find((entry) => entry.id === "native.prepare_publish_package")?.executionStatus, "callable");
  assert.equal(catalog.find((entry) => entry.id === "native.resume_latest_publish_flow")?.executionStatus, "callable");
  assert.equal(catalog.find((entry) => entry.id === "native.search_vibecodr")?.executionStatus, "callable");
  assert.equal(catalog.find((entry) => entry.id === "pulses.lifecycle")?.executionStatus, "catalog_only");
  assert.equal(Boolean(catalog.find((entry) => entry.id === "native.quick_publish_creation")?.inputSchema), true);
});

test("capability catalog gives zero-context models exact argument guidance", () => {
  const catalog = getCapabilityCatalog();
  const quickPublish = catalog.find((entry) => entry.id === "native.quick_publish_creation");
  const pulseLifecycle = catalog.find((entry) => entry.id === "pulses.lifecycle");
  const socialRead = catalog.find((entry) => entry.id === "social.read");

  assert.ok(quickPublish);
  assert.equal(quickPublish.confirmationRequired, true);
  assert.equal(Boolean(quickPublish.inputSchema), true);
  assert.equal(Boolean(quickPublish.outputSchema), true);
  assert.equal(Boolean(quickPublish.argumentSummary.some((line) => /confirmed/.test(line))), true);
  assert.equal(Boolean(quickPublish.examples?.some((example) => example.arguments.confirmed === true)), true);

  const preparePackage = catalog.find((entry) => entry.id === "native.prepare_publish_package");
  assert.ok(preparePackage);
  assert.equal(preparePackage.authRequired, false);
  assert.equal(preparePackage.destructive, false);
  assert.equal(Boolean(preparePackage.examples?.some((example) => !("confirmed" in example.arguments))), true);

  const resumeLatest = catalog.find((entry) => entry.id === "native.resume_latest_publish_flow");
  assert.ok(resumeLatest);
  assert.equal(resumeLatest.authRequired, true);
  assert.equal(resumeLatest.destructive, false);

  assert.ok(pulseLifecycle);
  assert.equal(pulseLifecycle.executionStatus, "catalog_only");
  assert.equal(Boolean(pulseLifecycle.inputSchema), true);
  assert.equal(Boolean(pulseLifecycle.argumentSummary.some((line) => /action/.test(line))), true);

  assert.ok(socialRead);
  assert.equal(socialRead.executionStatus, "catalog_only");
  assert.equal(Boolean(socialRead.inputSchema), true);
  assert.equal(Boolean(socialRead.argumentSummary.some((line) => /target/.test(line))), true);
});

test("resume recommendations satisfy the target tool required arguments", async () => {
  const noHistoryRecommendation = await resumeLatestRecommendation(resumeDeps([]));
  assertRecommendedToolCallSatisfiesInputSchema(noHistoryRecommendation);

  const canceledOperation: ImportOperation = {
    operationId: "op_canceled",
    userId: testSession.userId,
    sourceType: "chatgpt_v1",
    status: "canceled",
    currentStage: "canceled",
    diagnostics: [],
    idempotencyKey: "idem_canceled",
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2
  };
  const canceledRecommendation = await resumeLatestRecommendation(resumeDeps([canceledOperation]));
  assertRecommendedToolCallSatisfiesInputSchema(canceledRecommendation);
});

test("Code Mode production config requires Dynamic Worker execution by default", () => {
  const config = loadConfigFromSource({
    NODE_ENV: "production",
    PORT: "8787",
    APP_BASE_URL: "https://openai.vibecodr.space",
    VIBECDR_API_BASE: "https://api.vibecodr.space",
    SESSION_SIGNING_KEY: "x".repeat(32),
    OAUTH_CLIENT_ID: "client-id",
    OAUTH_ISSUER_URL: "https://vibecodr.space/__clerk"
  });

  assert.equal(config.codeMode.enabled, true);
  assert.equal(config.codeMode.requireDynamicWorker, true);
  assert.equal(config.codeMode.maxExecutionMs, 5000);
  assert.equal(config.codeMode.maxOutputBytes, 32768);
  assert.equal(config.codeMode.maxLogBytes, 8192);
  assert.equal(config.codeMode.maxNestedCalls, 5);
});

test("Code Mode Dynamic Worker executor options block outbound network access", () => {
  const loader = { get() {} };
  const options = buildDynamicWorkerExecutorOptions({
    enabled: true,
    defaultEnabled: false,
    requireDynamicWorker: true,
    allowNativeFallback: false,
    maxExecutionMs: 5000,
    maxOutputBytes: 32768,
    maxLogBytes: 8192,
    maxNestedCalls: 5,
    workerLoader: loader
  });

  assert.equal(options.loader, loader);
  assert.equal(options.timeout, 5000);
  assert.equal(options.globalOutbound, null);
});

test("SDK adapter mirrors native tool, prompt, and resource contracts", () => {
  const adapter = createVibecodrMcpServer({ mode: "native" });

  assert.equal(adapter.mode, "native");
  assert.equal(adapter.serverInfo.name, "vibecodr-openai-app");
  assert.equal(adapter.serverInfo.version, "0.2.0");
  assert.equal(typeof adapter.sdkServer.connect, "function");

  assert.deepEqual(
    adapter.listTools({ includeOutputSchema: false }).map((tool) => tool.name),
    getTools({ includeOutputSchema: false }).map((tool) => tool.name)
  );
  assert.deepEqual(adapter.listPrompts(), getPrompts());
  assert.deepEqual(
    adapter.getPrompt("publish_creation_end_to_end", { launch_goal: "ship" }),
    getPrompt("publish_creation_end_to_end", { launch_goal: "ship" })
  );
  assert.deepEqual(adapter.listResources(), []);
  assert.equal(adapter.readResource("ui://widget/publisher-v1"), null);
  assert.equal(adapter.toolRequiresAuth("get_vibecodr_platform_overview"), false);
  assert.equal(adapter.toolRequiresAuth("quick_publish_creation"), true);
});

test("SDK adapter exposes only search and execute in Code Mode", () => {
  const adapter = createVibecodrMcpServer({ mode: "codemode" });
  const searchTool = adapter.listTools().find((tool) => tool.name === "search");

  assert.equal(adapter.mode, "codemode");
  assert.deepEqual(
    adapter.listTools().map((tool) => tool.name),
    getCodeModeTools().map((tool) => tool.name)
  );
  assert.equal(((searchTool?.inputSchema.required as string[] | undefined) || []).includes("code"), false);
  assert.equal(adapter.toolRequiresAuth("search"), false);
  assert.equal(adapter.toolRequiresAuth("execute"), true);
});
