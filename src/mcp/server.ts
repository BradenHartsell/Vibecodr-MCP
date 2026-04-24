import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import {
  callCodeModeTool,
  codeModeToolRequiresAuth,
  getCodeModeTools
} from "./codeMode.js";
import { getPrompt, getPrompts, type PromptDescriptor, type PromptResult } from "./prompts.js";
import {
  callTool as callNativeTool,
  getTools,
  toolRequiresAuth as nativeToolRequiresAuth,
  type ToolDeps,
  type ToolDescriptor,
  type ToolResult
} from "./tools.js";
import type { SessionRecord } from "../types.js";

export type McpServerMode = "native" | "codemode";

export const VIBECDR_MCP_SERVER_INFO = {
  name: "vibecodr-openai-app",
  version: "0.2.0"
} as const;

type JsonSchemaRecord = Record<string, unknown>;

type CreateVibecodrMcpServerOptions = {
  mode?: McpServerMode;
  req?: Request;
  deps?: ToolDeps;
  session?: SessionRecord | null;
};

export type VibecodrMcpServer = {
  mode: McpServerMode;
  serverInfo: typeof VIBECDR_MCP_SERVER_INFO;
  sdkServer: McpServer;
  listTools(options?: { includeOutputSchema?: boolean; includeHidden?: boolean }): ToolDescriptor[];
  toolRequiresAuth(name: string): boolean;
  callTool(
    req: Request,
    deps: ToolDeps,
    name: string,
    args: Record<string, unknown>,
    session?: SessionRecord | null
  ): Promise<ToolResult>;
  listPrompts(): PromptDescriptor[];
  getPrompt(name: string, args?: Record<string, unknown>): PromptResult | null;
  listResources(): [];
  readResource(uri: string): null;
};

function isRecord(value: unknown): value is JsonSchemaRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringEnumSchema(values: unknown[]): ZodTypeAny {
  const strings = values.filter((value): value is string => typeof value === "string");
  const first = strings[0];
  if (!first) return z.string();
  return z.enum([first, ...strings.slice(1)]);
}

function zodFromJsonSchema(schema: unknown): ZodTypeAny {
  if (!isRecord(schema)) return z.unknown();
  const type = schema["type"];

  if (Array.isArray(schema["enum"])) {
    return stringEnumSchema(schema["enum"]);
  }

  if (type === "string") {
    let result: ZodTypeAny = z.string();
    if (typeof schema["minLength"] === "number") result = (result as z.ZodString).min(schema["minLength"]);
    if (typeof schema["maxLength"] === "number") result = (result as z.ZodString).max(schema["maxLength"]);
    return result;
  }

  if (type === "number" || type === "integer") {
    let result: ZodTypeAny = type === "integer" ? z.number().int() : z.number();
    if (typeof schema["minimum"] === "number") result = (result as z.ZodNumber).min(schema["minimum"]);
    if (typeof schema["maximum"] === "number") result = (result as z.ZodNumber).max(schema["maximum"]);
    return result;
  }

  if (type === "boolean") {
    return z.boolean();
  }

  if (type === "array") {
    return z.array(zodFromJsonSchema(schema["items"]));
  }

  if (type === "object") {
    return zodObjectFromJsonSchema(schema);
  }

  return z.unknown();
}

function zodObjectFromJsonSchema(schema: JsonSchemaRecord): ZodTypeAny {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const required = Array.isArray(schema["required"])
    ? new Set(schema["required"].filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = zodFromJsonSchema(value);
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
  }

  const objectSchema = z.object(shape);
  return schema["additionalProperties"] === false ? objectSchema.strict() : objectSchema.passthrough();
}

function promptArgsSchema(prompt: PromptDescriptor): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const arg of prompt.arguments || []) {
    const schema = z.string().describe(arg.description);
    shape[arg.name] = arg.required ? schema : schema.optional();
  }
  return shape;
}

function toSdkToolResult(result: ToolResult): CallToolResult {
  const structuredContent = result.structuredContent === undefined
    ? undefined
    : isRecord(result.structuredContent)
      ? result.structuredContent
      : { value: result.structuredContent };
  return {
    content: result.content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(result._meta ? { _meta: result._meta } : {})
  };
}

function sdkUnavailableResult(): CallToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text:
        "This MCP gateway executes tools through its request-bound adapter so auth, sessions, and telemetry stay attached to the original HTTP request."
    }],
    structuredContent: {
      error: "REQUEST_CONTEXT_REQUIRED"
    }
  };
}

function registerTools(sdkServer: McpServer, options: CreateVibecodrMcpServerOptions): void {
  const mode = options.mode || "native";
  const tools = mode === "codemode" ? getCodeModeTools() : getTools({ includeOutputSchema: true });

  for (const tool of tools) {
    const toolConfig = {
      title: tool.title,
      description: tool.description,
      inputSchema: zodObjectFromJsonSchema(tool.inputSchema),
      annotations: tool.annotations,
      ...(tool._meta ? { _meta: tool._meta } : {})
    };
    sdkServer.registerTool(
      tool.name,
      toolConfig,
      async (args: unknown) => {
        if (!options.req || !options.deps) return sdkUnavailableResult();
        const result = mode === "codemode"
          ? callCodeModeTool(options.req, options.deps, tool.name, args as Record<string, unknown>, options.session ?? null)
          : callNativeTool(options.req, options.deps, tool.name, args as Record<string, unknown>, options.session ?? null);
        return toSdkToolResult(await result);
      }
    );
  }
}

function registerPrompts(sdkServer: McpServer): void {
  for (const prompt of getPrompts()) {
    sdkServer.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: promptArgsSchema(prompt)
      },
      (args) => getPrompt(prompt.name, args as Record<string, unknown>) || {
        description: "Unknown prompt.",
        messages: [{
          role: "assistant",
          content: { type: "text", text: "Unknown prompt." }
        }]
      }
    );
  }
}

export function createVibecodrMcpServer(options: CreateVibecodrMcpServerOptions = {}): VibecodrMcpServer {
  const mode = options.mode || "native";
  const sdkServer = new McpServer(VIBECDR_MCP_SERVER_INFO);
  registerTools(sdkServer, { ...options, mode });
  registerPrompts(sdkServer);

  return {
    mode,
    serverInfo: VIBECDR_MCP_SERVER_INFO,
    sdkServer,
    listTools(listOptions) {
      if (mode === "codemode") return getCodeModeTools();
      return getTools(listOptions);
    },
    toolRequiresAuth(name) {
      return mode === "codemode" ? codeModeToolRequiresAuth(name) : nativeToolRequiresAuth(name);
    },
    callTool(req, deps, name, args, session) {
      return mode === "codemode"
        ? callCodeModeTool(req, deps, name, args, session ?? null)
        : callNativeTool(req, deps, name, args, session ?? null);
    },
    listPrompts() {
      return getPrompts();
    },
    getPrompt(name, args) {
      return getPrompt(name, args);
    },
    listResources() {
      return [];
    },
    readResource(_uri) {
      return null;
    }
  };
}
