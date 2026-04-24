import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function productionEnv(overrides: Record<string, unknown> = {}) {
  return {
    NODE_ENV: "production",
    APP_BASE_URL: "https://openai.vibecodr.space",
    VIBECDR_API_BASE: "https://api.vibecodr.space",
    SESSION_SIGNING_KEY: "x".repeat(32),
    OAUTH_PROVIDER_NAME: "clerk",
    OAUTH_CLIENT_ID: "client-id",
    OAUTH_ISSUER_URL: "https://vibecodr.space/__clerk",
    OAUTH_SCOPES: "openid profile email offline_access",
    COOKIE_SECURE: "true",
    OPERATIONS_KV: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {}
    },
    AUTH_CODE_COORDINATOR: {
      idFromName(name: string) {
        return name;
      },
      get() {
        return {
          async fetch() {
            return new Response("not implemented", { status: 501 });
          }
        };
      }
    },
    ...overrides
  };
}

async function jsonRpc(env: Record<string, unknown>, path: string, id: number, method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await worker.fetch(
    new Request("https://openai.vibecodr.space" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        ...headers
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      })
    }),
    env
  );
  return {
    response,
    body: await response.json() as Record<string, any>
  };
}

async function issueManualSession(env: Record<string, unknown>, userId = "user_codemode_test"): Promise<string> {
  const linkResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/auth/link", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: "manual-test-token",
        userId
      })
    }),
    env
  );
  assert.equal(linkResponse.status, 200);
  const setCookie = linkResponse.headers.get("set-cookie") || "";
  const signedValue = /^__Host-vc_session=([^;]+)/.exec(setCookie)?.[1];
  assert.equal(typeof signedValue, "string");
  return "__Host-vc_session=" + signedValue;
}

test("production worker fails closed when persistent bindings are missing", async () => {
  const response = await worker.fetch(
    new Request("https://openai.vibecodr.space/health"),
    {
      NODE_ENV: "production",
      APP_BASE_URL: "https://openai.vibecodr.space",
      VIBECDR_API_BASE: "https://api.vibecodr.space",
      SESSION_SIGNING_KEY: "x".repeat(32),
      OAUTH_PROVIDER_NAME: "clerk",
      OAUTH_CLIENT_ID: "client-id",
      OAUTH_ISSUER_URL: "https://vibecodr.space/__clerk",
      OAUTH_SCOPES: "openid profile email offline_access",
      COOKIE_SECURE: "true"
    }
  );

  assert.equal(response.status, 500);
  const body = await response.json() as { error?: string; traceId?: string };
  assert.equal(body.error, "Internal server error");
  assert.equal(typeof body.traceId, "string");
});

test("production worker initialize responds with the current MCP protocol version", async () => {
  const response = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "vibecodr-mcp",
            version: "0.1.0"
          }
        }
      })
    }),
    productionEnv()
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: {
      protocolVersion?: string;
      capabilities?: { tools?: { listChanged?: boolean }; prompts?: { listChanged?: boolean } };
      instructions?: string;
    };
  };
  assert.equal(body.result?.protocolVersion, "2025-11-25");
  assert.equal(body.result?.capabilities?.tools?.listChanged, false);
  assert.equal(body.result?.capabilities?.prompts?.listChanged, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body.result?.capabilities || {}, "resources"), false);
  assert.match(body.result?.instructions || "", /Start with Vibecodr product intent/);
  assert.match(body.result?.instructions || "", /confirmed: true/);
});

test("production worker does not expose widget resources or widget metadata", async () => {
  const initialize = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "codex",
            version: "1.0.0"
          }
        }
      })
    }),
    productionEnv()
  );

  const sessionId = initialize.headers.get("mcp-session-id");
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);

  const toolsResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    }),
    productionEnv()
  );

  assert.equal(toolsResponse.status, 200);
  const toolsBody = await toolsResponse.json() as {
    result?: {
      tools?: Array<{ name?: string; _meta?: Record<string, unknown> }>;
    };
  };
  const listedTools = toolsBody.result?.tools || [];
  const quickPublish = listedTools.find((tool) => tool.name === "quick_publish_creation");
  assert.equal(listedTools.some((tool) => tool.name === "get_guided_publish_requirements"), true);
  assert.equal(listedTools.some((tool) => tool.name === "get_launch_best_practices"), true);
  assert.equal(listedTools.some((tool) => tool.name === "prepare_publish_package"), true);
  assert.equal(listedTools.some((tool) => tool.name === "resume_latest_publish_flow"), true);
  assert.equal(listedTools.some((tool) => tool.name === "discover_vibes"), true);
  assert.equal(listedTools.some((tool) => tool.name === "search_vibecodr"), true);
  assert.equal(listedTools.some((tool) => tool.name === "build_share_copy"), true);
  assert.equal(listedTools.some((tool) => tool.name === "watch_operation"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(quickPublish?._meta || {}, "openai/outputTemplate"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(quickPublish?._meta || {}, "ui"), false);

  const resourcesResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/list",
        params: {}
      })
    }),
    productionEnv()
  );

  assert.equal(resourcesResponse.status, 200);
  const resourcesBody = await resourcesResponse.json() as {
    result?: { resources?: unknown[] };
  };
  assert.deepEqual(resourcesBody.result?.resources, []);

  const promptsResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "prompts/list",
        params: {}
      })
    }),
    productionEnv()
  );

  assert.equal(promptsResponse.status, 200);
  const promptsBody = await promptsResponse.json() as {
    result?: { prompts?: Array<{ name?: string }> };
  };
  assert.equal(Boolean(promptsBody.result?.prompts?.some((prompt) => prompt.name === "publish_creation_end_to_end")), true);
});

test("production worker exposes opt-in Code Mode search and execute tools", async () => {
  const env = productionEnv({ CODEMODE_REQUIRE_DYNAMIC_WORKER: "false" });
  const toolsResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    }),
    env
  );

  assert.equal(toolsResponse.status, 200);
  const toolsBody = await toolsResponse.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.deepEqual((toolsBody.result?.tools || []).map((tool) => tool.name), ["search", "execute"]);

  const searchResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "search",
          arguments: {
            code: "async catalog => catalog.filter((capability) => capability.namespace === 'pulses')"
          }
        }
      })
    }),
    env
  );

  assert.equal(searchResponse.status, 200);
  const searchBody = await searchResponse.json() as {
    result?: { structuredContent?: { results?: Array<{ id?: string; namespace?: string }> } };
  };
  assert.equal(Boolean(searchBody.result?.structuredContent?.results?.some((entry) => entry.namespace === "pulses")), true);

  const executeResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "execute",
          arguments: {
            code: "async ({ vibecodr }) => vibecodr.quick_publish_creation({})",
            capabilityId: "native.quick_publish_creation"
          }
        }
      })
    }),
    env
  );

  assert.equal(executeResponse.status, 401);
  const authenticate = executeResponse.headers.get("www-authenticate") || "";
  assert.match(authenticate, /scope="openid profile email offline_access"/);
});

test("authenticated native destructive tools require explicit confirmation", async () => {
  let upstreamCalls = 0;
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    VIBE_API: {
      async fetch() {
        upstreamCalls += 1;
        return Response.json({ error: "write path should not be reached" }, { status: 500 });
      }
    }
  });
  const cookie = await issueManualSession(env, "user_native_confirmation_test");
  const { response, body } = await jsonRpc(
    env,
    "/mcp",
    1,
    "tools/call",
    {
      name: "quick_publish_creation",
      arguments: {
        sourceType: "chatgpt_v1",
        payload: {
          importMode: "direct_files",
          files: [{ path: "index.html", content: "<h1>hi</h1>" }]
        }
      }
    },
    { cookie }
  );

  assert.equal(response.status, 200);
  assert.equal(body.result?.structuredContent?.error, "CONFIRMATION_REQUIRED");
  assert.equal(body.result?.structuredContent?.confirmationRequired, true);
  assert.equal(body.result?.structuredContent?.requiredArgument, "confirmed");
  assert.equal(body.result?.structuredContent?.toolName, "quick_publish_creation");
  assert.match(body.result?.structuredContent?.action || "", /publishing this creation/);
  assert.match(body.result?.structuredContent?.message || "", /confirmed: true/);
  assert.equal(upstreamCalls, 0);
});

test("runtime readiness supports live vibe and draft targets without operation ids", async () => {
  const upstreamPaths: string[] = [];
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    VIBE_API: {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(String(input));
        upstreamPaths.push(url.pathname);
        if (url.pathname === "/posts/post_live") {
          return Response.json({
            post: {
              id: "post_live",
              title: "Launch Board",
              visibility: "public",
              author: { handle: "braden" },
              capsule: {
                id: "cap_live",
                runner: "client-static",
                entry: "index.html"
              },
              stats: {
                runs: 12,
                likes: 3,
                comments: 1,
                remixes: 2
              }
            }
          });
        }
        if (url.pathname === "/capsules/cap_draft/files-summary") {
          return Response.json({
            id: "cap_draft",
            title: "Draft Board",
            publishState: "draft",
            package: {
              runner: "client-static",
              entry: "src/main.tsx",
              files: [{ path: "src/main.tsx" }, { path: "package.json" }]
            }
          });
        }
        return Response.json({ error: "unexpected path", path: url.pathname }, { status: 404 });
      }
    }
  });
  const cookie = await issueManualSession(env, "user_runtime_targets_test");

  const live = await jsonRpc(
    env,
    "/mcp",
    1,
    "tools/call",
    {
      name: "get_runtime_readiness",
      arguments: { postId: "post_live" }
    },
    { cookie }
  );
  assert.equal(live.response.status, 200);
  assert.equal(live.body.result?.structuredContent?.state, "ready");
  assert.deepEqual(live.body.result?.structuredContent?.subject, { type: "live_vibe", id: "post_live" });
  assert.equal(Boolean(live.body.result?.structuredContent?.evidence?.some((item: string) => /Launch Board/.test(item))), true);

  const draft = await jsonRpc(
    env,
    "/mcp",
    2,
    "tools/call",
    {
      name: "get_runtime_readiness",
      arguments: { capsuleId: "cap_draft" }
    },
    { cookie }
  );
  assert.equal(draft.response.status, 200);
  assert.equal(draft.body.result?.structuredContent?.state, "unknown");
  assert.deepEqual(draft.body.result?.structuredContent?.subject, { type: "draft", id: "cap_draft" });
  assert.match(draft.body.result?.structuredContent?.nextAction || "", /publish flow/i);
  assert.deepEqual(upstreamPaths, ["/posts/post_live", "/capsules/cap_draft/files-summary"]);
});

test("production Code Mode fails closed when Dynamic Worker execution is required without a loader", async () => {
  const response = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp?codemode=search_and_execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: {
            code: "async catalog => catalog.filter((capability) => capability.namespace === 'publish')"
          }
        }
      })
    }),
    productionEnv({ CODEMODE_REQUIRE_DYNAMIC_WORKER: "true" })
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    result?: {
      structuredContent?: {
        error?: string;
        dynamicWorkerRequired?: boolean;
      };
    };
  };
  assert.equal(body.result?.structuredContent?.error, "CODEMODE_DYNAMIC_WORKER_UNAVAILABLE");
  assert.equal(body.result?.structuredContent?.dynamicWorkerRequired, true);
});

test("production Code Mode enforces output caps in fallback search", async () => {
  const env = productionEnv({
    CODEMODE_REQUIRE_DYNAMIC_WORKER: "false",
    CODEMODE_ALLOW_NATIVE_FALLBACK: "true",
    CODEMODE_MAX_OUTPUT_BYTES: "256"
  });
  const { response, body } = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    1,
    "tools/call",
    {
      name: "search",
      arguments: {
        code: "async catalog => catalog.filter((capability) => capability)"
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(body.result?.structuredContent?.error, "CODEMODE_OUTPUT_TOO_LARGE");
  assert.equal(body.result?.structuredContent?.maxOutputBytes, 1024);
});

test("authenticated Code Mode execute rejects catalog-only capabilities as non-callable", async () => {
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    CODEMODE_REQUIRE_DYNAMIC_WORKER: "false",
    CODEMODE_ALLOW_NATIVE_FALLBACK: "true"
  });
  const cookie = await issueManualSession(env, "user_catalog_only_test");
  const { response, body } = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    1,
    "tools/call",
    {
      name: "execute",
      arguments: {
        code: "async ({ vibecodr }) => vibecodr.execute({ capabilityId: 'publish.publish_capsule', confirmed: true })",
        capabilityId: "publish.publish_capsule",
        confirmed: true
      }
    },
    { cookie }
  );

  assert.equal(response.status, 200);
  assert.equal(body.result?.structuredContent?.error, "CATALOG_ONLY_CAPABILITY");
  assert.equal(body.result?.structuredContent?.capability?.id, "publish.publish_capsule");
});

test("Code Mode search can return exact schema detail for a capability", async () => {
  const env = productionEnv({
    CODEMODE_REQUIRE_DYNAMIC_WORKER: "false",
    CODEMODE_ALLOW_NATIVE_FALLBACK: "true"
  });
  const { response, body } = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    1,
    "tools/call",
    {
      name: "search",
      arguments: {
        code: "async ({ codemode }) => codemode.search({ capabilityId: 'native.quick_publish_creation' })",
        capabilityId: "native.quick_publish_creation"
      }
    }
  );

  assert.equal(response.status, 200);
  const result = body.result?.structuredContent?.results?.[0];
  assert.equal(result?.id, "native.quick_publish_creation");
  assert.equal(result?.executionStatus, "callable");
  assert.equal(result?.inputSchema?.properties?.confirmed?.const, true);
  assert.equal(Boolean(result?.argumentSummary?.some((line: string) => /confirmed/.test(line))), true);
  assert.equal(Array.isArray(result?.examples), true);
});

test("Code Mode Dynamic Worker fast path honors top-level arguments without generated code", async () => {
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    CODEMODE_REQUIRE_DYNAMIC_WORKER: "true",
    CODEMODE_WORKER_LOADER: {}
  });
  const cookie = await issueManualSession(env, "user_dynamic_top_level_test");

  const search = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    1,
    "tools/call",
    {
      name: "search",
      arguments: {
        capabilityId: "native.quick_publish_creation"
      }
    }
  );
  assert.equal(search.response.status, 200);
  assert.equal(search.body.result?.structuredContent?.runtime, "dynamic_worker");
  assert.equal(search.body.result?.structuredContent?.results?.[0]?.id, "native.quick_publish_creation");

  const execute = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    2,
    "tools/call",
    {
      name: "execute",
      arguments: {
        capabilityId: "native.quick_publish_creation",
        arguments: {
          sourceType: "chatgpt_v1",
          payload: {
            importMode: "direct_files",
            files: [{ path: "index.html", content: "<h1>hi</h1>" }]
          }
        }
      }
    },
    { cookie }
  );
  assert.equal(execute.response.status, 200);
  assert.equal(execute.body.result?.structuredContent?.runtime, "dynamic_worker");
  assert.equal(execute.body.result?.structuredContent?.confirmationRequired, true);
  assert.equal(execute.body.result?.structuredContent?.capability?.id, "native.quick_publish_creation");
});

test("authenticated Code Mode execute records nested telemetry without generated code", async () => {
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    CODEMODE_REQUIRE_DYNAMIC_WORKER: "false",
    CODEMODE_ALLOW_NATIVE_FALLBACK: "true"
  });
  const cookie = await issueManualSession(env, "user_nested_telemetry_test");
  const secretMarker = "super_secret_generated_code_marker";
  const { response } = await jsonRpc(
    env,
    "/mcp?codemode=search_and_execute",
    1,
    "tools/call",
    {
      name: "execute",
      arguments: {
        code: `async ({ vibecodr }) => { const token = "${secretMarker}"; return vibecodr.execute({ capabilityId: "native.get_vibecodr_platform_overview" }); }`,
        capabilityId: "native.get_vibecodr_platform_overview"
      }
    },
    { cookie }
  );
  assert.equal(response.status, 200);

  const summaryResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/observability/summary", {
      headers: { cookie }
    }),
    env
  );
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json() as {
    recentEvents?: Array<{ category?: string; details?: Record<string, unknown> }>;
  };
  assert.equal(Boolean(summary.recentEvents?.some((event) => event.category === "codemode.nested_call")), true);
  assert.equal(JSON.stringify(summary).includes(secretMarker), false);
});

test("production worker rejects removed widget route and UI resources", async () => {
  const widgetResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/widget"),
    productionEnv()
  );
  assert.equal(widgetResponse.status, 404);

  const initialize = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html"]
              }
            }
          },
          clientInfo: {
            name: "chatgpt",
            version: "1.0.0"
          }
        }
      })
    }),
    productionEnv()
  );

  const initializeBody = await initialize.json() as {
    result?: { capabilities?: { prompts?: { listChanged?: boolean }; resources?: { listChanged?: boolean } } };
  };
  assert.equal(initializeBody.result?.capabilities?.prompts?.listChanged, false);
  assert.equal(Object.prototype.hasOwnProperty.call(initializeBody.result?.capabilities || {}, "resources"), false);

  const sessionId = initialize.headers.get("mcp-session-id");
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId);

  const resourcesResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list",
        params: {}
      })
    }),
    productionEnv()
  );

  assert.equal(resourcesResponse.status, 200);
  const resourcesBody = await resourcesResponse.json() as {
    result?: {
      resources?: Array<{ uri?: string }>;
    };
  };
  assert.deepEqual(resourcesBody.result?.resources, []);

  const resourceReadResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: {
          uri: "ui://widget/publisher-v1"
        }
      })
    }),
    productionEnv()
  );
  assert.equal(resourceReadResponse.status, 200);
  const resourceReadBody = await resourceReadResponse.json() as {
    error?: { code?: number; message?: string };
  };
  assert.equal(resourceReadBody.error?.code, -32002);

  const promptResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId!
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "prompts/get",
        params: {
          name: "publish_creation_end_to_end",
          arguments: {
            creation_summary: "An AI-built app bundle"
          }
        }
      })
    }),
    productionEnv()
  );

  assert.equal(promptResponse.status, 200);
  const promptBody = await promptResponse.json() as {
    result?: { messages?: Array<{ content?: { text?: string } }> };
  };
  assert.match(String(promptBody.result?.messages?.[0]?.content?.text || ""), /SEO and social preview polish/i);
});

test("production worker writes __Host session cookies and reads legacy session cookies", async () => {
  const env = productionEnv({ ALLOW_MANUAL_TOKEN_LINK: "true" });
  const linkResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/auth/link", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: "manual-test-token",
        userId: "user_cookie_test"
      })
    }),
    env
  );

  assert.equal(linkResponse.status, 200);
  const setCookie = linkResponse.headers.get("set-cookie") || "";
  assert.match(setCookie, /^__Host-vc_session=/);
  assert.match(setCookie, /;\s*Secure\b/);
  assert.match(setCookie, /;\s*Path=\//);

  const signedValue = /^__Host-vc_session=([^;]+)/.exec(setCookie)?.[1];
  assert.equal(typeof signedValue, "string");

  const currentCookieResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/auth/session", {
      headers: {
        cookie: `__Host-vc_session=${signedValue}`
      }
    }),
    env
  );
  assert.equal(currentCookieResponse.status, 200);
  const currentCookieBody = await currentCookieResponse.json() as { authenticated?: boolean; userId?: string };
  assert.equal(currentCookieBody.authenticated, true);
  assert.equal(currentCookieBody.userId, "user_cookie_test");

  const legacyCookieResponse = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/auth/session", {
      headers: {
        cookie: `vc_session=${signedValue}`
      }
    }),
    env
  );
  assert.equal(legacyCookieResponse.status, 200);
  const legacyCookieBody = await legacyCookieResponse.json() as { authenticated?: boolean; userId?: string };
  assert.equal(legacyCookieBody.authenticated, true);
  assert.equal(legacyCookieBody.userId, "user_cookie_test");
});

test("production worker rejects protected MCP tools after session logout", async () => {
  const kv = new Map<string, string>();
  const env = productionEnv({
    ALLOW_MANUAL_TOKEN_LINK: "true",
    SESSION_SIGNING_KEY: "revocation-test-session-signing-key-32",
    OPERATIONS_KV: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      }
    }
  });
  const cookie = await issueManualSession(env, "user_revoked_tool");

  const beforeLogout = await jsonRpc(env, "/mcp", 71, "tools/call", {
    name: "quick_publish_creation",
    arguments: {}
  }, { cookie });
  assert.equal(beforeLogout.response.status, 200);
  assert.equal(beforeLogout.body.result?.structuredContent?.error, "CONFIRMATION_REQUIRED");

  const logout = await worker.fetch(
    new Request("https://openai.vibecodr.space/api/auth/logout", {
      method: "POST",
      headers: { cookie }
    }),
    env
  );
  assert.equal(logout.status, 200);

  const afterLogout = await jsonRpc(env, "/mcp", 72, "tools/call", {
    name: "quick_publish_creation",
    arguments: {}
  }, { cookie });
  assert.equal(afterLogout.response.status, 401);
  assert.equal(afterLogout.body.error?.data?.authChallenge?.resourceMetadataUri, "https://openai.vibecodr.space/.well-known/oauth-protected-resource/mcp");
});

test("production worker returns a structured auth challenge for protected tool calls without a session", async () => {
  const response = await worker.fetch(
    new Request("https://openai.vibecodr.space/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "quick_publish_creation",
          arguments: {}
        }
      })
    }),
    productionEnv()
  );

  assert.equal(response.status, 401);
  const authenticate = response.headers.get("www-authenticate") || "";
  assert.match(authenticate, /resource_metadata="https:\/\/openai\.vibecodr\.space\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(authenticate, /scope="openid profile email offline_access"/);
  const body = await response.json() as {
    error?: {
      data?: {
        authChallenge?: {
          authorizationUri?: string;
          resourceMetadataUri?: string;
          requiredScopes?: string[];
        };
      };
    };
  };
  assert.equal(body.error?.data?.authChallenge?.authorizationUri, "https://openai.vibecodr.space/authorize");
  assert.equal(body.error?.data?.authChallenge?.resourceMetadataUri, "https://openai.vibecodr.space/.well-known/oauth-protected-resource/mcp");
  assert.deepEqual(body.error?.data?.authChallenge?.requiredScopes, ["openid", "profile", "email", "offline_access"]);
});
