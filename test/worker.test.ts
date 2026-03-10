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
    OAUTH_ISSUER_URL: "https://clerk.vibecodr.space",
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
      OAUTH_ISSUER_URL: "https://clerk.vibecodr.space",
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
    };
  };
  assert.equal(body.result?.protocolVersion, "2025-11-25");
  assert.equal(body.result?.capabilities?.tools?.listChanged, false);
  assert.equal(body.result?.capabilities?.prompts?.listChanged, false);
  assert.equal(Object.prototype.hasOwnProperty.call(body.result?.capabilities || {}, "resources"), false);
});

test("production worker hides widget resources and widget metadata from generic MCP clients", async () => {
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
  const quickPublish = toolsBody.result?.tools?.find((tool) => tool.name === "quick_publish_creation");
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

test("production worker exposes widget resources to UI-capable hosts", async () => {
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
  assert.equal(initializeBody.result?.capabilities?.resources?.listChanged, false);

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
  assert.equal(resourcesBody.result?.resources?.[0]?.uri, "ui://widget/publisher-v1");

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
        id: 3,
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
