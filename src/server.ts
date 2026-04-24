import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { toNodeResponse, jsonResponse } from "./lib/http.js";
import { SessionRevocationStore } from "./auth/sessionRevocationStore.js";
import { SessionStore } from "./auth/sessionStore.js";
import { OauthStateStore } from "./auth/oauthStateStore.js";
import { OperationStore } from "./storage/operationStore.js";
import { VibecodrClient } from "./vibecodr/client.js";
import { ImportService } from "./services/importService.js";
import { createAppRequestHandler } from "./app.js";
import { Telemetry } from "./observability/telemetry.js";
import type { KvNamespaceLike } from "./storage/operationStoreKv.js";

class InMemoryKv implements KvNamespaceLike {
  private readonly map = new Map<string, string>();

  async get(key: string, type?: "text" | "json"): Promise<string | null | unknown> {
    const value = this.map.get(key) ?? null;
    if (value == null) return null;
    if (type === "json") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const config = loadConfig();
const runtimeKv = new InMemoryKv();
const sessionRevocationStore = new SessionRevocationStore(runtimeKv);
const sessionStore = new SessionStore(config.sessionSigningKey, sessionRevocationStore);
const oauthStateStore = new OauthStateStore(config.sessionSigningKey);
const operationStore = new OperationStore(config.dataDir);
const telemetry = new Telemetry({ hashSalt: config.sessionSigningKey });
const vibecodr = new VibecodrClient(config.vibecodrApiBase);
const importService = new ImportService(operationStore, vibecodr, telemetry);
const appHandler = createAppRequestHandler({
  config,
  sessionStore,
  oauthStateStore,
  operationStore,
  importService,
  vibecodr,
  telemetry,
  oauthKv: runtimeKv,
  sessionRevocationStore
});

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const contentLengthRaw = nodeReq.headers["content-length"];
    const contentLength = typeof contentLengthRaw === "string" ? Number(contentLengthRaw) : NaN;
    if (Number.isFinite(contentLength) && contentLength > config.maxRequestBodyBytes) {
      const traceId = randomUUID();
      await toNodeResponse(
        jsonResponse(413, {
          error: "REQUEST_BODY_TOO_LARGE",
          message: "Request body exceeds configured limit.",
          maxBytes: config.maxRequestBodyBytes,
          traceId
        }, { "x-trace-id": traceId }),
        nodeRes
      );
      return;
    }

    const host = nodeReq.headers.host || "localhost:" + config.port;
    const url = new URL(nodeReq.url || "/", "http://" + host);
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for await (const chunk of nodeReq) {
      const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += normalized.byteLength;
      if (totalBytes > config.maxRequestBodyBytes) {
        const traceId = randomUUID();
        await toNodeResponse(
          jsonResponse(413, {
            error: "REQUEST_BODY_TOO_LARGE",
            message: "Request body exceeds configured limit.",
            maxBytes: config.maxRequestBodyBytes,
            traceId
          }, { "x-trace-id": traceId }),
          nodeRes
        );
        return;
      }
      chunks.push(normalized);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const requestInit: RequestInit = {
      method: nodeReq.method || "GET",
      headers: nodeReq.headers as Record<string, string>,
      ...(body && body.length > 0 ? { body } : {})
    };
    const req = new Request(url.toString(), requestInit);
    const res = await appHandler(req);
    await toNodeResponse(res, nodeRes);
  } catch (error) {
    const traceId = randomUUID();
    telemetry.event("server.error", "error", {
      traceId,
      errorCode: "SERVER_UNHANDLED_ERROR",
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    console.error("server.error", {
      traceId,
      error: error instanceof Error ? error.message : String(error)
    });
    await toNodeResponse(jsonResponse(500, { error: "Internal server error", traceId }), nodeRes);
  }
});

server.listen(config.port, () =>
  telemetry.event("server.start", "info", {
    details: {
      port: config.port,
      appBaseUrl: config.appBaseUrl
    }
  })
);
