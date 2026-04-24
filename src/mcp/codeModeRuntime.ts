export type CodeModeWorkerLoaderLike = unknown;

export type CodeModeRuntimePolicy = {
  enabled: boolean;
  defaultEnabled: boolean;
  requireDynamicWorker: boolean;
  allowNativeFallback: boolean;
  maxExecutionMs: number;
  maxOutputBytes: number;
  maxLogBytes: number;
  maxNestedCalls: number;
  workerLoader?: CodeModeWorkerLoaderLike;
};

type CodeModeResolvedRuntime =
  | { available: true; mode: "dynamic_worker" | "native_fallback" }
  | { available: false; error: "CODEMODE_DISABLED" | "CODEMODE_DYNAMIC_WORKER_UNAVAILABLE"; message: string };

type DynamicWorkerProvider = {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

type DynamicWorkerExecuteResult = {
  result: unknown;
  error?: string;
  logs?: string[];
};

type DynamicWorkerExecutorCtor = new (options: {
  loader: unknown;
  timeout: number;
  globalOutbound: null;
}) => {
  execute(code: string, providers: DynamicWorkerProvider[]): Promise<DynamicWorkerExecuteResult>;
};

export function buildDynamicWorkerExecutorOptions(policy: CodeModeRuntimePolicy): {
  loader: CodeModeWorkerLoaderLike;
  timeout: number;
  globalOutbound: null;
} {
  if (!policy.workerLoader) {
    throw new Error("CODEMODE_WORKER_LOADER is not configured.");
  }
  return {
    loader: policy.workerLoader,
    timeout: policy.maxExecutionMs,
    globalOutbound: null
  };
}

export function resolveCodeModeRuntime(policy?: CodeModeRuntimePolicy): CodeModeResolvedRuntime {
  if (!policy?.enabled) {
    return {
      available: false,
      error: "CODEMODE_DISABLED",
      message: "Code Mode is disabled for this MCP gateway."
    };
  }
  if (policy.workerLoader) return { available: true, mode: "dynamic_worker" };
  if (policy.requireDynamicWorker) {
    return {
      available: false,
      error: "CODEMODE_DYNAMIC_WORKER_UNAVAILABLE",
      message: "Code Mode requires CODEMODE_WORKER_LOADER, but the binding is not configured."
    };
  }
  if (policy.allowNativeFallback) return { available: true, mode: "native_fallback" };
  return {
    available: false,
    error: "CODEMODE_DYNAMIC_WORKER_UNAVAILABLE",
    message: "Code Mode has no Dynamic Worker loader and native fallback is disabled."
  };
}

export async function executeCodeModeInDynamicWorker(
  code: string,
  policy: CodeModeRuntimePolicy,
  providers: DynamicWorkerProvider[]
): Promise<DynamicWorkerExecuteResult> {
  if (!policy.workerLoader) {
    return {
      result: undefined,
      error: "CODEMODE_WORKER_LOADER is not configured."
    };
  }

  const module = await import("@cloudflare/codemode") as { DynamicWorkerExecutor: DynamicWorkerExecutorCtor };
  const executor = new module.DynamicWorkerExecutor(buildDynamicWorkerExecutorOptions(policy));
  return executor.execute(code, providers);
}

export function limitCodeModeLogs(logs: string[] | undefined, maxBytes: number): string[] | undefined {
  if (!logs?.length) return logs;
  const limited: string[] = [];
  let used = 0;
  for (const line of logs) {
    const bytes = new TextEncoder().encode(line).byteLength;
    if (used + bytes > maxBytes) {
      limited.push("[logs truncated]");
      break;
    }
    limited.push(line);
    used += bytes;
  }
  return limited;
}

export function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
