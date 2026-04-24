import { stableHash } from "../config.js";

type MetricTagValue = string | number | boolean;
type MetricTags = Record<string, MetricTagValue | undefined>;
type LogLevel = "info" | "warn" | "error";
type AnalyticsEngineDataPoint = {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
};
type AnalyticsEngineDataset = {
  writeDataPoint: (point: AnalyticsEngineDataPoint) => void;
};

type CounterMetric = {
  name: string;
  tags: Record<string, string>;
  value: number;
};

type DistributionMetric = {
  name: string;
  tags: Record<string, string>;
  values: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
};

type TelemetryEvent = {
  timestamp: string;
  level: LogLevel;
  category: string;
  traceId?: string | undefined;
  operationId?: string | undefined;
  userHash?: string | undefined;
  sourceType?: string | undefined;
  stage?: string | undefined;
  status?: string | undefined;
  endpoint?: string | undefined;
  latencyMs?: number | undefined;
  retryCount?: number | undefined;
  errorCode?: string | undefined;
  details?: Record<string, unknown> | undefined;
};

type TelemetryAlert = {
  severity: "P1" | "P2";
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

type RequestEventInput = {
  traceId: string;
  method: string;
  endpoint: string;
  statusCode: number;
  latencyMs: number;
  userId?: string | undefined;
  errorCode?: string | undefined;
};

type AuthEventInput = {
  traceId?: string | undefined;
  event: string;
  outcome: "success" | "failure" | "challenge";
  provider?: string | undefined;
  userId?: string | undefined;
  endpoint?: string | undefined;
  errorCode?: string | undefined;
  details?: Record<string, unknown> | undefined;
};

type OperationEventInput = {
  traceId?: string | undefined;
  event: string;
  operationId: string;
  userId: string;
  sourceType?: string | undefined;
  stage?: string | undefined;
  status?: string | undefined;
  endpoint?: string | undefined;
  latencyMs?: number | undefined;
  retryCount?: number | undefined;
  errorCode?: string | undefined;
  details?: Record<string, unknown> | undefined;
};

type UpstreamEventInput = {
  traceId?: string | undefined;
  operationId?: string | undefined;
  userId?: string | undefined;
  sourceType?: string | undefined;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  errorCode?: string | undefined;
};

type ToolEventInput = {
  traceId?: string | undefined;
  toolName: string;
  outcome: "success" | "failure" | "challenge";
  userId?: string | undefined;
  latencyMs?: number | undefined;
  errorCode?: string | undefined;
};

type SummaryFilter = {
  userId?: string | undefined;
};

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "access_token",
  "refresh_token",
  "token",
  "client_secret",
  "vibecodrtoken",
  "oauthaccesstoken",
  "code_verifier"
]);

function normalizeTags(tags?: MetricTags): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function metricKey(name: string, tags: Record<string, string>): string {
  const parts = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value);
  return name + "|" + parts.join("&");
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index] ?? 0;
}

function redactString(value: string): string {
  if (/^bearer\s+/i.test(value)) return "[REDACTED_BEARER_TOKEN]";
  if (/(access_token|refresh_token|id_token|authorization|cookie|password|secret)/i.test(value)) return "[REDACTED_SENSITIVE_TEXT]";
  if (/<\/?[a-z][\s\S]*>/i.test(value)) return "[REDACTED_UPSTREAM_BODY]";
  if (value.length > 80 && /^[A-Za-z0-9\-_\.=+/]+$/.test(value)) return "[REDACTED_TOKEN]";
  return value;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (value == null) return value;
  if (key && REDACTED_KEYS.has(key.toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeValue(childValue, childKey);
    }
    return out;
  }
  return String(value);
}

function writeDataPointSafe(dataset: AnalyticsEngineDataset | undefined, point: AnalyticsEngineDataPoint): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint(point);
  } catch {
    // Best-effort only; never let analytics break request handling.
  }
}

export class Telemetry {
  private readonly startedAtMs = Date.now();
  private readonly counters = new Map<string, CounterMetric>();
  private readonly distributions = new Map<string, DistributionMetric>();
  private readonly recentEvents: TelemetryEvent[] = [];

  constructor(
    private readonly opts: {
      hashSalt: string;
      recentEventLimit?: number;
      distributionValueLimit?: number;
      analytics?: AnalyticsEngineDataset;
    }
  ) {}

  userHash(userId?: string): string | undefined {
    if (!userId) return undefined;
    return stableHash(this.opts.hashSalt + ":" + userId).slice(0, 16);
  }

  counter(name: string, tags?: MetricTags, value = 1): void {
    const normalizedTags = normalizeTags(tags);
    const key = metricKey(name, normalizedTags);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.counters.set(key, { name, tags: normalizedTags, value });
  }

  distribution(name: string, value: number, tags?: MetricTags): void {
    if (!Number.isFinite(value) || value < 0) return;
    const normalizedTags = normalizeTags(tags);
    const key = metricKey(name, normalizedTags);
    const existing = this.distributions.get(key);
    const valueLimit = this.opts.distributionValueLimit ?? 500;

    if (existing) {
      existing.count += 1;
      existing.sum += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
      existing.values.push(value);
      if (existing.values.length > valueLimit) existing.values.shift();
      return;
    }

    this.distributions.set(key, {
      name,
      tags: normalizedTags,
      values: [value],
      count: 1,
      sum: value,
      min: value,
      max: value
    });
  }

  event(category: string, level: LogLevel, event: Omit<TelemetryEvent, "timestamp" | "level" | "category">): void {
    const record: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      level,
      category,
      traceId: event.traceId,
      operationId: event.operationId,
      userHash: event.userHash,
      sourceType: event.sourceType,
      stage: event.stage,
      status: event.status,
      endpoint: event.endpoint,
      latencyMs: event.latencyMs,
      retryCount: event.retryCount,
      errorCode: event.errorCode,
      details: event.details ? (sanitizeValue(event.details) as Record<string, unknown>) : undefined
    };

    this.recentEvents.push(record);
    const recentEventLimit = this.opts.recentEventLimit ?? 200;
    if (this.recentEvents.length > recentEventLimit) {
      this.recentEvents.splice(0, this.recentEvents.length - recentEventLimit);
    }

    const logLine = JSON.stringify(record);
    writeDataPointSafe(this.opts.analytics, {
      indexes: [
        category,
        level,
        event.endpoint || "",
        event.status || "",
        event.errorCode || "",
        event.sourceType || ""
      ],
      blobs: [
        event.traceId || "",
        event.operationId || "",
        event.userHash || "",
        logLine
      ],
      doubles: [
        Date.parse(record.timestamp),
        event.latencyMs ?? 0,
        event.retryCount ?? 0
      ]
    });
    if (level === "error") {
      console.error(logLine);
      return;
    }
    if (level === "warn") {
      console.warn(logLine);
      return;
    }
    console.log(logLine);
  }

  request(input: RequestEventInput): void {
    const statusFamily = Math.floor(input.statusCode / 100) + "xx";
    this.counter("http_requests_total", {
      endpoint: input.endpoint,
      method: input.method,
      status: input.statusCode,
      statusFamily
    });
    this.distribution("http_request_latency_ms", input.latencyMs, {
      endpoint: input.endpoint,
      method: input.method
    });
    this.event("http.request", input.statusCode >= 500 ? "error" : input.statusCode >= 400 ? "warn" : "info", {
      traceId: input.traceId,
      endpoint: input.endpoint,
      latencyMs: input.latencyMs,
      userHash: this.userHash(input.userId),
      status: String(input.statusCode),
      errorCode: input.errorCode,
      details: { method: input.method, statusCode: input.statusCode }
    });
  }

  auth(input: AuthEventInput): void {
    this.counter("auth_events_total", {
      event: input.event,
      outcome: input.outcome,
      provider: input.provider
    });
    if (input.outcome === "failure") this.counter("auth_failure_total", { provider: input.provider });
    if (input.outcome === "challenge") this.counter("auth_challenge_total", { provider: input.provider });
    this.event(input.outcome === "failure" ? "auth.audit.failure" : "auth.audit", input.outcome === "failure" ? "warn" : "info", {
      traceId: input.traceId,
      endpoint: input.endpoint,
      userHash: this.userHash(input.userId),
      errorCode: input.errorCode,
      details: {
        event: input.event,
        outcome: input.outcome,
        provider: input.provider,
        ...(input.details || {})
      }
    });
  }

  operation(input: OperationEventInput): void {
    this.counter("operation_events_total", {
      event: input.event,
      status: input.status,
      sourceType: input.sourceType
    });
    if (input.event === "import_started") this.counter("imports_started_total", { sourceType: input.sourceType });
    if (input.event === "idempotency_hit") this.counter("duplicate_idempotency_hits_total", { sourceType: input.sourceType });
    if (input.event === "import_completed") this.counter("imports_completed_total", { sourceType: input.sourceType });
    if (input.event === "import_failed") this.counter("imports_failed_total", { sourceType: input.sourceType, errorCode: input.errorCode });
    if (input.event === "compile_failed") this.counter("compile_failures_total", { sourceType: input.sourceType, errorCode: input.errorCode });
    if (input.event === "publish_failed") this.counter("publish_failures_total", { sourceType: input.sourceType, errorCode: input.errorCode });
    if (input.latencyMs !== undefined) {
      this.distribution("import_stage_duration_ms", input.latencyMs, {
        stage: input.stage,
        sourceType: input.sourceType
      });
    }
    this.event(input.errorCode ? "operation.lifecycle.failure" : "operation.lifecycle", input.errorCode ? "warn" : "info", {
      traceId: input.traceId,
      operationId: input.operationId,
      userHash: this.userHash(input.userId),
      sourceType: input.sourceType,
      stage: input.stage,
      status: input.status,
      endpoint: input.endpoint,
      latencyMs: input.latencyMs,
      retryCount: input.retryCount,
      errorCode: input.errorCode,
      details: { event: input.event, ...(input.details || {}) }
    });
  }

  upstream(input: UpstreamEventInput): void {
    this.counter("upstream_requests_total", {
      endpoint: input.endpoint,
      method: input.method,
      status: input.statusCode
    });
    this.distribution("upstream_request_latency_ms", input.latencyMs, {
      endpoint: input.endpoint,
      method: input.method
    });
    this.event(input.statusCode >= 500 ? "upstream.request.failure" : "upstream.request", input.statusCode >= 400 ? "warn" : "info", {
      traceId: input.traceId,
      operationId: input.operationId,
      userHash: this.userHash(input.userId),
      sourceType: input.sourceType,
      endpoint: input.endpoint,
      latencyMs: input.latencyMs,
      status: String(input.statusCode),
      errorCode: input.errorCode,
      details: { method: input.method, statusCode: input.statusCode }
    });
  }

  tool(input: ToolEventInput): void {
    this.counter("tool_calls_total", {
      toolName: input.toolName,
      outcome: input.outcome
    });
    this.event(input.outcome === "failure" ? "tool.call.failure" : "tool.call", input.outcome === "failure" ? "warn" : "info", {
      traceId: input.traceId,
      userHash: this.userHash(input.userId),
      latencyMs: input.latencyMs,
      errorCode: input.errorCode,
      details: { toolName: input.toolName, outcome: input.outcome }
    });
  }

  summary(filter?: SummaryFilter): {
    generatedAt: string;
    uptimeMs: number;
    counters: Array<{ name: string; tags: Record<string, string>; value: number }>;
    distributions: Array<{
      name: string;
      tags: Record<string, string>;
      count: number;
      min: number;
      max: number;
      avg: number;
      p95: number;
    }>;
    alerts: TelemetryAlert[];
    recentEvents: TelemetryEvent[];
  } {
    const userHash = this.userHash(filter?.userId);
    const recentEvents = userHash
      ? this.recentEvents.filter((event) => !event.userHash || event.userHash === userHash)
      : [...this.recentEvents];

    const counters = [...this.counters.values()].sort((a, b) => a.name.localeCompare(b.name));
    const distributions = [...this.distributions.values()]
      .map((distribution) => ({
        name: distribution.name,
        tags: distribution.tags,
        count: distribution.count,
        min: distribution.min,
        max: distribution.max,
        avg: distribution.count > 0 ? Number((distribution.sum / distribution.count).toFixed(2)) : 0,
        p95: percentile(distribution.values, 0.95)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      generatedAt: new Date().toISOString(),
      uptimeMs: Date.now() - this.startedAtMs,
      counters,
      distributions,
      alerts: this.detectAlerts(counters, recentEvents),
      recentEvents
    };
  }

  private detectAlerts(
    counters: Array<{ name: string; tags: Record<string, string>; value: number }>,
    recentEvents: TelemetryEvent[]
  ): TelemetryAlert[] {
    const alerts: TelemetryAlert[] = [];
    const counterValue = (name: string, predicate?: (tags: Record<string, string>) => boolean): number =>
      counters
        .filter((counter) => counter.name === name && (!predicate || predicate(counter.tags)))
        .reduce((sum, counter) => sum + counter.value, 0);

    const authFailures = counterValue("auth_failure_total");
    const authChallenges = counterValue("auth_challenge_total");
    const publishFailures = counterValue("publish_failures_total");
    const importPollErrors = recentEvents.filter((event) => event.errorCode === "IMPORT_JOB_POLL_ERROR").length;
    const recentRetryStorm = recentEvents.some((event) => (event.retryCount || 0) >= 4);

    if (publishFailures >= 5) {
      alerts.push({
        severity: "P1",
        code: "PUBLISH_FAILURE_SPIKE",
        message: "Publish failures exceeded threshold in recent telemetry.",
        details: { publishFailures }
      });
    }

    if (authFailures >= 5 || (authChallenges >= 10 && authFailures >= 3)) {
      alerts.push({
        severity: "P1",
        code: "AUTH_FAILURE_SPIKE",
        message: "Authentication failures/challenges indicate a possible auth outage or loop.",
        details: { authFailures, authChallenges }
      });
    }

    if (importPollErrors >= 3) {
      alerts.push({
        severity: "P2",
        code: "IMPORT_JOB_TIMEOUT_CLUSTER",
        message: "Repeated import job polling errors detected.",
        details: { importPollErrors }
      });
    }

    if (recentRetryStorm) {
      alerts.push({
        severity: "P2",
        code: "RETRY_STORM",
        message: "One or more operations show repeated retries or diagnostic accumulation.",
        details: { recentRetryStorm }
      });
    }

    return alerts;
  }
}
