import assert from "node:assert/strict";
import { getCapabilityCatalog } from "../src/mcp/capabilityCatalog.js";
import { getCodeModeTools } from "../src/mcp/codeMode.js";
import { callTool, getTools } from "../src/mcp/tools.js";

const results = [];

async function evaluate(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function publicTool(name) {
  return getTools({ includeOutputSchema: true }).find((tool) => tool.name === name);
}

function allTool(name) {
  return getTools({ includeHidden: true, includeOutputSchema: true }).find((tool) => tool.name === name);
}

function assertToolShape(name, options) {
  const tool = options.publicOnly === false ? allTool(name) : publicTool(name);
  assert.ok(tool, name + " is missing from tool discovery");
  assert.equal(Boolean(tool.annotations.readOnlyHint), options.readOnly, name + " readOnlyHint mismatch");
  assert.equal(Boolean(tool.annotations.destructiveHint), options.destructive, name + " destructiveHint mismatch");
  assert.equal(tool.securitySchemes.some((scheme) => scheme.type === "oauth2"), options.authRequired, name + " auth mismatch");
  assert.ok(tool.inputSchema, name + " is missing inputSchema");
  assert.ok(tool.outputSchema, name + " is missing outputSchema");
}

await evaluate("publish prep tools are noauth read-only and non-destructive", () => {
  assertToolShape("prepare_publish_package", { readOnly: true, destructive: false, authRequired: false });
  assertToolShape("validate_creation_payload", { readOnly: true, destructive: false, authRequired: false });
});

await evaluate("prepare_publish_package validates without echoing raw files or setting confirmed true", async () => {
  const deps = {
    featureFlags: {
      enableCodexImportPath: true,
      enableChatGptImportPath: true,
      enablePublishFromChatGpt: true
    }
  };
  const result = await callTool(
    new Request("https://openai.vibecodr.space/mcp"),
    deps,
    "prepare_publish_package",
    {
      sourceType: "chatgpt_v1",
      payload: {
        importMode: "direct_files",
        title: "Capability Eval Vibe",
        entry: "index.html",
        files: [{ path: "index.html", content: "<main>eval</main>" }]
      }
    }
  );
  const structured = result.structuredContent;
  assert.equal(structured.canPublish, true);
  assert.equal(structured.suggestedArguments.confirmed, false);
  assert.equal(Boolean(structured.suggestedArguments.payload.files), false);
  assert.equal(structured.suggestedArguments.payload.reuseOriginalPayloadFiles, true);
});

await evaluate("resume_latest_publish_flow is OAuth read-only and operation-id-free at input", () => {
  const tool = publicTool("resume_latest_publish_flow");
  assertToolShape("resume_latest_publish_flow", { readOnly: true, destructive: false, authRequired: true });
  const properties = tool.inputSchema.properties || {};
  assert.equal(Boolean(properties.operationId), false);
});

await evaluate("public social read tools are noauth read-only", () => {
  for (const name of [
    "discover_vibes",
    "get_public_post",
    "get_public_profile",
    "search_vibecodr",
    "get_remix_lineage"
  ]) {
    assertToolShape(name, { readOnly: true, destructive: false, authRequired: false });
  }
  assert.equal(publicTool("get_thread_context"), undefined);
  assert.equal(allTool("get_thread_context"), undefined);
});

await evaluate("post-publish polish helpers are OAuth read-only", () => {
  for (const name of [
    "build_share_copy",
    "get_launch_checklist",
    "inspect_social_preview",
    "suggest_post_publish_next_steps",
    "get_engagement_followup_context"
  ]) {
    assertToolShape(name, { readOnly: true, destructive: false, authRequired: true });
  }
});

await evaluate("capability catalog gives callable native tools schemas and argument summaries", () => {
  const catalog = getCapabilityCatalog();
  const nativeEntries = catalog.filter((entry) => entry.kind === "native_tool" && entry.executionStatus === "callable");
  assert.ok(nativeEntries.length > 0);
  for (const entry of nativeEntries) {
    assert.ok(entry.inputSchema, entry.id + " missing inputSchema");
    assert.ok(entry.outputSchema, entry.id + " missing outputSchema");
    assert.ok(entry.argumentSummary.length > 0, entry.id + " missing argumentSummary");
  }
});

await evaluate("capability catalog classifies social and resume capabilities", () => {
  const catalog = getCapabilityCatalog();
  assert.equal(catalog.find((entry) => entry.id === "native.resume_latest_publish_flow")?.namespace, "publish");
  for (const id of [
    "native.discover_vibes",
    "native.get_public_post",
    "native.get_public_profile",
    "native.search_vibecodr",
    "native.get_remix_lineage",
    "native.build_share_copy"
  ]) {
    assert.equal(catalog.find((entry) => entry.id === id)?.namespace, "social", id + " namespace mismatch");
  }
});

await evaluate("Code Mode direct search and execute inputs do not require code", () => {
  const [searchTool, executeTool] = getCodeModeTools();
  assert.equal(searchTool.name, "search");
  assert.equal(executeTool.name, "execute");
  assert.equal(((searchTool.inputSchema.required || [])).includes("code"), false);
  assert.equal(((executeTool.inputSchema.required || [])).includes("code"), false);
  assert.ok(searchTool.inputSchema.properties.query);
  assert.ok(executeTool.inputSchema.properties.capabilityId);
  assert.ok(executeTool.inputSchema.properties.arguments);
  assert.ok(executeTool.inputSchema.properties.confirmed);
});

const ok = results.every((result) => result.ok);
console.log(JSON.stringify({
  ok,
  generatedAt: new Date().toISOString(),
  evals: results
}, null, 2));

if (!ok) {
  process.exitCode = 1;
}
