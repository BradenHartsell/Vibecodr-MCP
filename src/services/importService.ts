import { randomUUID } from "node:crypto";
import type { OperationStorePort } from "../storage/operationStorePort.js";
import { VibecodrClient, coverUsageForVisibility } from "../vibecodr/client.js";
import { Telemetry } from "../observability/telemetry.js";
import { extractFailureDetails, translateDiagnosticForPublic, translateFailure } from "../lib/failureTranslation.js";
import { resolveThumbnailInput } from "../lib/thumbnailInput.js";
import type {
  ImportOperation,
  NormalizedCreationPackage,
  OperationFailureExplanation,
  OperationStatus,
  OperationWatchResult,
  PublishDraftOptions,
  PublishReadinessCheck,
  PublishReadinessResult,
  PublishSeoInput,
  QuickPublishResult,
  QuickPublishStep,
  SessionRecord
} from "../types.js";

type ServiceRequestMeta = {
  traceId?: string | undefined;
  endpoint?: string | undefined;
};

const TERMINAL_STATUSES: OperationStatus[] = [
  "draft_ready",
  "compile_failed",
  "published",
  "published_with_warnings",
  "failed",
  "canceled"
];

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTerminalStatus(status: OperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSeoFields(input: PublishSeoInput | undefined): PublishSeoInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const base: PublishSeoInput = {};

  const title = trimToUndefined(input.title);
  const description = trimToUndefined(input.description);
  const imageKey = trimToUndefined(input.imageKey);
  if (title) base.title = title;
  if (description) base.description = description;
  if (imageKey) base.imageKey = imageKey;

  if (input.og === null) {
    base.og = null;
  } else if (input.og && typeof input.og === "object") {
    const ogTitle = trimToUndefined(input.og.title);
    const ogDescription = trimToUndefined(input.og.description);
    const ogImageKey = trimToUndefined(input.og.imageKey);
    if (ogTitle || ogDescription || ogImageKey) {
      base.og = {};
      if (ogTitle) base.og.title = ogTitle;
      if (ogDescription) base.og.description = ogDescription;
      if (ogImageKey) base.og.imageKey = ogImageKey;
    }
  }

  if (input.twitter === null) {
    base.twitter = null;
  } else if (input.twitter && typeof input.twitter === "object") {
    const twTitle = trimToUndefined(input.twitter.title);
    const twDescription = trimToUndefined(input.twitter.description);
    const twImageKey = trimToUndefined(input.twitter.imageKey);
    if (twTitle || twDescription || twImageKey) {
      base.twitter = {};
      if (twTitle) base.twitter.title = twTitle;
      if (twDescription) base.twitter.description = twDescription;
      if (twImageKey) base.twitter.imageKey = twImageKey;
    }
  }

  return Object.keys(base).length > 0 ? base : undefined;
}

function isPostPublishMetadataWarning(code: string): boolean {
  return code === "POST_METADATA_FAILED" || code === "POST_METADATA_SKIPPED";
}

export class ImportService {
  constructor(
    private readonly store: OperationStorePort,
    private readonly vibecodr: VibecodrClient,
    private readonly telemetry: Telemetry
  ) {}

  private upstreamMeta(session: SessionRecord, operation: Pick<ImportOperation, "operationId" | "sourceType">, meta?: ServiceRequestMeta) {
    return {
      telemetry: this.telemetry,
      traceId: meta?.traceId,
      operationId: operation.operationId,
      sourceType: operation.sourceType,
      userId: session.userId
    };
  }

  private async updateStatusObserved(
    operationId: string,
    status: OperationStatus,
    stage: string,
    patch: Partial<Pick<ImportOperation, "capsuleId" | "importJobId" | "sourceReference">> | undefined,
    meta?: ServiceRequestMeta
  ): Promise<ImportOperation> {
    const previous = await this.store.getById(operationId);
    const operation = await this.store.updateStatus(operationId, status, stage, patch);
    const stageLatencyMs = previous ? Math.max(Date.now() - previous.updatedAt, 0) : undefined;
    this.telemetry.operation({
      traceId: meta?.traceId,
      event:
        status === "draft_ready" ? "import_completed"
        : status === "failed" ? "import_failed"
        : status === "compile_failed" ? "compile_failed"
        : status === "published" || status === "published_with_warnings" ? "publish_completed"
        : "status_transition",
      operationId: operation.operationId,
      userId: operation.userId,
      sourceType: operation.sourceType,
      stage,
      status,
      endpoint: meta?.endpoint,
      latencyMs: stageLatencyMs,
      retryCount: operation.diagnostics.length,
      errorCode: status === "failed" || status === "compile_failed" ? operation.diagnostics.at(-1)?.code : undefined,
      details: previous ? { previousStatus: previous.status, previousStage: previous.currentStage } : undefined
    });
    return operation;
  }

  private async addDiagnosticObserved(
    operationId: string,
    diagnostic: ImportOperation["diagnostics"][number],
    meta?: ServiceRequestMeta
  ): Promise<ImportOperation> {
    const operation = await this.store.addDiagnostic(operationId, diagnostic);
    this.telemetry.operation({
      traceId: meta?.traceId,
      event:
        diagnostic.code === "COMPILE_FAILED" ? "compile_failed"
        : diagnostic.code === "PUBLISH_FAILED" ? "publish_failed"
        : diagnostic.code === "INGEST_FAILED" ? "import_failed"
        : "diagnostic_added",
      operationId: operation.operationId,
      userId: operation.userId,
      sourceType: operation.sourceType,
      stage: diagnostic.stage,
      status: operation.status,
      endpoint: meta?.endpoint,
      retryCount: operation.diagnostics.length,
      errorCode: diagnostic.code,
      details: { retryable: diagnostic.retryable, message: diagnostic.message }
    });
    return operation;
  }

  private async requireOwnedOperation(session: SessionRecord, operationId: string): Promise<ImportOperation> {
    const op = await this.store.getById(operationId);
    if (!op || op.userId !== session.userId) throw new Error("Operation not found");
    return op;
  }

  private async resolveCoverUsage(
    session: SessionRecord,
    operation: Pick<ImportOperation, "operationId" | "sourceType">,
    postId: string | undefined,
    requestedVisibility: PublishDraftOptions["visibility"],
    meta?: ServiceRequestMeta
  ) {
    if (requestedVisibility) {
      return coverUsageForVisibility(requestedVisibility);
    }
    if (postId) {
      const vibe = await this.vibecodr.getLiveVibe(
        { userId: session.userId, userHandle: session.userHandle, vibecodrToken: session.vibecodrToken },
        postId,
        this.upstreamMeta(session, operation, meta)
      );
      return coverUsageForVisibility(vibe.visibility);
    }
    return "app_cover";
  }

  private baseOperation(session: SessionRecord, pkg: NormalizedCreationPackage): ImportOperation {
    const now = Date.now();
    return {
      operationId: randomUUID(),
      userId: session.userId,
      sourceType: pkg.sourceType,
      sourceReference: pkg.sourceReference,
      status: "received",
      currentStage: "received",
      diagnostics: [],
      idempotencyKey: pkg.idempotencyKey,
      createdAt: now,
      updatedAt: now
    };
  }

  async startImport(session: SessionRecord, pkg: NormalizedCreationPackage, meta?: ServiceRequestMeta): Promise<ImportOperation> {
    const existing = await this.store.getByIdempotency(session.userId, pkg.idempotencyKey);
    if (existing) {
      this.telemetry.operation({
        traceId: meta?.traceId,
        event: "idempotency_hit",
        operationId: existing.operationId,
        userId: existing.userId,
        sourceType: existing.sourceType,
        stage: existing.currentStage,
        status: existing.status,
        endpoint: meta?.endpoint,
        retryCount: existing.diagnostics.length
      });
      return existing;
    }

    const op = await this.store.create(this.baseOperation(session, pkg));
    this.telemetry.operation({
      traceId: meta?.traceId,
      event: "import_started",
      operationId: op.operationId,
      userId: op.userId,
      sourceType: op.sourceType,
      stage: op.currentStage,
      status: op.status,
      endpoint: meta?.endpoint
    });
    await this.updateStatusObserved(op.operationId, "validating", "validating", undefined, meta);
    await this.updateStatusObserved(op.operationId, "normalized", "normalized", undefined, meta);
    const ctx = { userId: session.userId, vibecodrToken: session.vibecodrToken };

    try {
      if (pkg.importMode === "direct_files") {
        await this.updateStatusObserved(op.operationId, "ingesting", "creating_draft", undefined, meta);
        const created = await this.vibecodr.createEmptyCapsule(ctx, {
          title: pkg.title,
          entry: pkg.entry,
          runner: pkg.runner,
          idempotencyKey: pkg.idempotencyKey
        }, this.upstreamMeta(session, op, meta));

        await this.updateStatusObserved(op.operationId, "ingesting", "uploading_files", { capsuleId: created.capsuleId }, meta);

        for (const file of pkg.files) {
          const content = file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
          await this.vibecodr.putCapsuleFile(ctx, created.capsuleId, file.path, content, this.upstreamMeta(session, op, meta));
        }

        return this.updateStatusObserved(op.operationId, "draft_ready", "draft_ready", { capsuleId: created.capsuleId }, meta);
      }

      if (pkg.importMode === "zip_import" && pkg.zip) {
        await this.updateStatusObserved(op.operationId, "ingesting", "import_zip", undefined, meta);
        const zipBytes = Buffer.from(pkg.zip.fileBase64, "base64");
        const result = await this.vibecodr.importZip(ctx, {
          fileName: pkg.zip.fileName,
          fileBytes: zipBytes,
          rootHint: pkg.zip.rootHint,
          allowModuleScripts: pkg.zip.allowModuleScripts,
          async: pkg.zip.async ?? true
        }, this.upstreamMeta(session, op, meta)) as Record<string, unknown>;

        const jobId = typeof result["jobId"] === "string" ? result["jobId"] : undefined;
        const capsuleId = typeof result["capsuleId"] === "string" ? result["capsuleId"] : undefined;
        if (jobId) {
          await this.updateStatusObserved(op.operationId, "waiting_on_import_job", "waiting_on_import_job", { importJobId: jobId, capsuleId }, meta);
          return (await this.store.getById(op.operationId))!;
        }
        if (capsuleId) return this.updateStatusObserved(op.operationId, "draft_ready", "draft_ready", { capsuleId }, meta);
        throw new Error("ZIP_IMPORT_NO_JOB_OR_CAPSULE");
      }

      if (pkg.importMode === "github_import" && pkg.github) {
        await this.updateStatusObserved(op.operationId, "ingesting", "import_github", undefined, meta);
        const result = await this.vibecodr.importGithub(ctx, pkg.github, this.upstreamMeta(session, op, meta)) as Record<string, unknown>;
        const jobId = typeof result["jobId"] === "string" ? result["jobId"] : undefined;
        const capsuleId = typeof result["capsuleId"] === "string" ? result["capsuleId"] : undefined;
        if (jobId) {
          await this.updateStatusObserved(op.operationId, "waiting_on_import_job", "waiting_on_import_job", { importJobId: jobId, capsuleId }, meta);
          return (await this.store.getById(op.operationId))!;
        }
        if (capsuleId) return this.updateStatusObserved(op.operationId, "draft_ready", "draft_ready", { capsuleId }, meta);
        throw new Error("GITHUB_IMPORT_NO_JOB_OR_CAPSULE");
      }

      throw new Error("UNSUPPORTED_IMPORT_MODE");
    } catch (error) {
      await this.addDiagnosticObserved(op.operationId, {
        at: Date.now(),
        stage: "ingest",
        code: "INGEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        details: extractFailureDetails(error)
      }, meta);
      return this.updateStatusObserved(op.operationId, "failed", "failed", undefined, meta);
    }
  }

  async refreshImportJobStatus(session: SessionRecord, operationId: string, meta?: ServiceRequestMeta): Promise<ImportOperation | undefined> {
    const op = await this.store.getById(operationId);
    if (!op || op.userId !== session.userId) return undefined;
    return this.refreshOperationFromImportJob(session, op, meta);
  }

  async refreshPendingOperations(session: SessionRecord, operations: ImportOperation[], meta?: ServiceRequestMeta): Promise<ImportOperation[]> {
    const refreshed: ImportOperation[] = [];
    for (const operation of operations) {
      if (operation.userId !== session.userId) continue;
      const next = await this.refreshOperationFromImportJob(session, operation, meta);
      refreshed.push(next);
    }
    return refreshed;
  }

  async watchOperation(
    session: SessionRecord,
    operationId: string,
    options?: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      targetStatuses?: OperationStatus[];
    },
    meta?: ServiceRequestMeta
  ): Promise<OperationWatchResult> {
    await this.requireOwnedOperation(session, operationId);

    const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 90_000, 1_000), 10 * 60 * 1_000);
    const pollIntervalMs = Math.min(Math.max(options?.pollIntervalMs ?? 1_500, 250), 10_000);
    const targetStatuses = options?.targetStatuses?.length
      ? options.targetStatuses
      : [...TERMINAL_STATUSES];

    const start = Date.now();
    let pollCount = 0;
    let current = (await this.refreshImportJobStatus(session, operationId, meta)) || (await this.requireOwnedOperation(session, operationId));

    while (true) {
      pollCount += 1;
      if (targetStatuses.includes(current.status)) {
        return {
          operation: current,
          reachedTarget: true,
          timedOut: false,
          elapsedMs: Date.now() - start,
          pollCount,
          targetStatuses
        };
      }

      const elapsedMs = Date.now() - start;
      if (elapsedMs >= timeoutMs) {
        return {
          operation: current,
          reachedTarget: false,
          timedOut: true,
          elapsedMs,
          pollCount,
          targetStatuses
        };
      }

      await delay(pollIntervalMs);
      const refreshed = await this.refreshImportJobStatus(session, operationId, meta);
      current = refreshed || (await this.requireOwnedOperation(session, operationId));
    }
  }

  async getPublishReadiness(
    session: SessionRecord,
    operationId: string,
    capsuleIdInput?: string,
    meta?: ServiceRequestMeta
  ): Promise<PublishReadinessResult> {
    const op = (await this.refreshImportJobStatus(session, operationId, meta)) || (await this.requireOwnedOperation(session, operationId));
    const capsuleId = trimToUndefined(capsuleIdInput) || op.capsuleId;
    const checks: PublishReadinessCheck[] = [];

    checks.push({
      id: "operation_exists",
      level: "pass",
      message: "Operation exists and belongs to current user.",
      details: { operationId: op.operationId }
    });

    if (!capsuleId) {
      checks.push({
        id: "capsule_id",
        level: "blocking",
        message: "No capsuleId is associated with this operation yet.",
        details: { status: op.status, currentStage: op.currentStage }
      });
    } else {
      checks.push({
        id: "capsule_id",
        level: "pass",
        message: "Capsule id is available for publish.",
        details: { capsuleId }
      });
    }

    if (op.status === "failed" || op.status === "canceled" || op.status === "compile_failed") {
      checks.push({
        id: "operation_status",
        level: "blocking",
        message: "Operation is in a failed terminal status and cannot be published.",
        details: { status: op.status }
      });
    } else if (op.status === "published" || op.status === "published_with_warnings") {
      checks.push({
        id: "operation_status",
        level: "warning",
        message: "Operation is already published.",
        details: { status: op.status }
      });
    } else if (op.status === "draft_ready") {
      checks.push({
        id: "operation_status",
        level: "pass",
        message: "Draft is ready for compile/publish.",
        details: { status: op.status, currentStage: op.currentStage }
      });
    } else if (op.status === "compile_running" || op.status === "publish_running") {
      checks.push({
        id: "operation_status",
        level: "warning",
        message: "Operation is already running a mutation step.",
        details: { status: op.status }
      });
    } else {
      checks.push({
        id: "operation_status",
        level: "blocking",
        message: "Import is not finished yet. Wait until draft_ready before publish.",
        details: { status: op.status, currentStage: op.currentStage }
      });
    }

    if (op.status === "draft_ready" && op.currentStage !== "compiled") {
      checks.push({
        id: "compile_recommended",
        level: "warning",
        message: "Compile has not been confirmed for this draft yet.",
        details: { currentStage: op.currentStage }
      });
    } else if (op.status === "draft_ready" && op.currentStage === "compiled") {
      checks.push({
        id: "compile_recommended",
        level: "pass",
        message: "Compile has already completed for this draft."
      });
    }

    const readyToPublish = checks.every((check) => check.level !== "blocking");
    const recommendedActions: string[] = [];

    if (!capsuleId) {
      recommendedActions.push("Stay in the thread until Vibecodr finishes creating the draft.");
    }
    if (op.status !== "draft_ready" && !isTerminalStatus(op.status)) {
      recommendedActions.push("Wait for the draft to finish preparing before trying to launch it.");
    }
    if (op.status === "draft_ready" && op.currentStage !== "compiled") {
      recommendedActions.push("Run a compile check before launch for a safer first impression.");
    }
    if (op.status === "failed" || op.status === "compile_failed") {
      const latest = op.diagnostics.at(-1);
      recommendedActions.push(...translateFailure(latest?.code, op.status, latest?.details).nextActions);
    }

    return { readyToPublish, operation: op, capsuleId, checks, recommendedActions };
  }

  async explainOperationFailure(
    session: SessionRecord,
    operationId: string,
    meta?: ServiceRequestMeta
  ): Promise<OperationFailureExplanation> {
    const op = (await this.refreshImportJobStatus(session, operationId, meta)) || (await this.requireOwnedOperation(session, operationId));
    const latestDiagnostics = [...op.diagnostics]
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
      .map((item) => translateDiagnosticForPublic(item, op.status));

    const failed = op.status === "failed" || op.status === "compile_failed" || op.status === "canceled";
    const primary = latestDiagnostics[0];
    const rootCauseCode = primary?.code;
    const translation = translateFailure(rootCauseCode, op.status, op.diagnostics.at(-1)?.details);
    const rootCauseMessage = translation.rootCauseSummary;
    const retryable = failed ? Boolean(primary?.retryable) : false;
    const userMessage = translation.userMessage;
    const nextActions = failed
      ? translation.nextActions
      : [
          "The launch is still moving. Stay in the thread and keep guiding the publish flow instead of switching into recovery."
        ];

    return {
      operationId: op.operationId,
      status: op.status,
      failed,
      ...(rootCauseCode ? { rootCauseCode } : {}),
      ...(rootCauseMessage ? { rootCauseMessage } : {}),
      retryable,
      userMessage,
      nextActions,
      latestDiagnostics
    };
  }

  async quickPublishCreation(
    session: SessionRecord,
    pkg: NormalizedCreationPackage,
    options?: {
      autoCompile?: boolean;
      timeoutMs?: number;
      pollIntervalMs?: number;
      publish?: PublishDraftOptions;
    },
    meta?: ServiceRequestMeta
  ): Promise<QuickPublishResult> {
    const steps: QuickPublishStep[] = [];
    const recommendedActions: string[] = [];
    const autoCompile = options?.autoCompile !== false;

    let op = await this.startImport(session, pkg, meta);
    steps.push({
      step: "import",
      status: op.status === "failed" || op.status === "canceled" ? "failed" : "completed",
      message: "Import operation created.",
      at: Date.now(),
      details: { operationId: op.operationId, status: op.status }
    });

    if (op.status === "failed" || op.status === "canceled") {
      const latest = op.diagnostics.at(-1);
      const translation = translateFailure(latest?.code, op.status, latest?.details);
      const importStep = steps[steps.length - 1];
      if (importStep) importStep.message = translation.diagnosticMessage;
      recommendedActions.push(...translateFailure(latest?.code, op.status, latest?.details).nextActions);
      return { operation: op, published: false, timedOut: false, steps, recommendedActions };
    }

    if (op.status !== "draft_ready") {
      const watchOptions = {
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
        targetStatuses: ["draft_ready", "failed", "canceled"] satisfies OperationStatus[]
      };
      const watch = await this.watchOperation(session, op.operationId, watchOptions, meta);
      op = watch.operation;

      if (watch.timedOut) {
        steps.push({
          step: "wait_for_draft",
          status: "timed_out",
          message: "Timed out while waiting for draft readiness.",
          at: Date.now(),
          details: { elapsedMs: watch.elapsedMs, pollCount: watch.pollCount, status: op.status }
        });
        recommendedActions.push("Stay in the thread while Vibecodr keeps preparing the draft, then launch it once the draft is ready.");
        return { operation: op, published: false, timedOut: true, steps, recommendedActions };
      }

      if (op.status !== "draft_ready") {
        const latest = op.diagnostics.at(-1);
        const translation = translateFailure(latest?.code, op.status, latest?.details);
        steps.push({
          step: "wait_for_draft",
          status: "failed",
          message: translation.diagnosticMessage,
          at: Date.now(),
          details: { status: op.status }
        });
        recommendedActions.push(...translateFailure(latest?.code, op.status, latest?.details).nextActions);
        return { operation: op, published: false, timedOut: false, steps, recommendedActions };
      }

      steps.push({
        step: "wait_for_draft",
        status: "completed",
        message: "Draft is ready.",
        at: Date.now(),
        details: { capsuleId: op.capsuleId }
      });
    }

    const capsuleId = op.capsuleId;
    if (!capsuleId) {
      steps.push({
        step: "wait_for_draft",
        status: "failed",
        message: "Draft ready status returned without a capsuleId.",
        at: Date.now(),
        details: { status: op.status, currentStage: op.currentStage }
      });
      recommendedActions.push("Try the draft creation step again once ChatGPT confirms the package still points to a real app.");
      return { operation: op, published: false, timedOut: false, steps, recommendedActions };
    }

    if (autoCompile) {
      op = await this.compileDraft(session, op.operationId, capsuleId, meta);
      if (op.status === "compile_failed" || op.status === "failed") {
        const latest = op.diagnostics.at(-1);
        const translation = translateFailure(latest?.code, op.status, latest?.details);
        steps.push({
          step: "compile",
          status: "failed",
          message: translation.diagnosticMessage,
          at: Date.now()
        });
        recommendedActions.push(...translateFailure(latest?.code, op.status, latest?.details).nextActions);
        return { operation: op, published: false, timedOut: false, steps, recommendedActions };
      }
      steps.push({
        step: "compile",
        status: "completed",
        message: "Compile completed.",
        at: Date.now(),
        details: { status: op.status, currentStage: op.currentStage }
      });
    } else {
      steps.push({
        step: "compile",
        status: "skipped",
        message: "Compile skipped by caller.",
        at: Date.now()
      });
    }

    op = await this.publishDraft(session, op.operationId, capsuleId, options?.publish, meta);
    const metadataWarnings = op.diagnostics.filter((diagnostic) => isPostPublishMetadataWarning(diagnostic.code));
    if (op.status === "published" || op.status === "published_with_warnings") {
      if (metadataWarnings.length > 0) {
        recommendedActions.push("The vibe is live. Retry the cover image or SEO metadata update to finish launch polish.");
      }
      steps.push({
        step: "publish",
        status: "completed",
        message: metadataWarnings.length > 0
          ? "Publish completed, but launch polish still needs a follow-up step."
          : "Publish completed.",
        at: Date.now()
      });
      return { operation: op, published: true, timedOut: false, steps, recommendedActions };
    }

    const latest = op.diagnostics.at(-1);
    steps.push({
      step: "publish",
      status: "failed",
      message: translateFailure(latest?.code, op.status, latest?.details).diagnosticMessage,
      at: Date.now(),
      details: { status: op.status }
    });
    recommendedActions.push(...translateFailure(latest?.code, op.status, latest?.details).nextActions);
    return { operation: op, published: false, timedOut: false, steps, recommendedActions };
  }

  private async refreshOperationFromImportJob(
    session: SessionRecord,
    operation: ImportOperation,
    meta?: ServiceRequestMeta
  ): Promise<ImportOperation> {
    if (!operation.importJobId || operation.status !== "waiting_on_import_job") return operation;

    try {
      const job = await this.vibecodr.getImportJob(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        operation.importJobId,
        this.upstreamMeta(session, operation, meta)
      ) as Record<string, unknown>;
      const nested = job["job"] as Record<string, unknown> | undefined;
      const status = typeof nested?.["status"] === "string" ? String(nested?.["status"]) : "";
      const capsuleId = typeof nested?.["capsuleId"] === "string"
        ? String(nested?.["capsuleId"])
        : typeof job["capsuleId"] === "string"
          ? String(job["capsuleId"])
          : operation.capsuleId;

      if (status === "completed" || status === "done" || capsuleId) {
        return this.updateStatusObserved(operation.operationId, "draft_ready", "draft_ready", { capsuleId }, meta);
      }

      if (status === "failed" || status === "canceled") {
        await this.addDiagnosticObserved(operation.operationId, {
          at: Date.now(),
          stage: "import_job",
          code: status.toUpperCase(),
          message: "Import job " + status,
          retryable: status !== "canceled",
          details: { job }
        }, meta);
        return this.updateStatusObserved(
          operation.operationId,
          status === "canceled" ? "canceled" : "failed",
          status,
          undefined,
          meta
        );
      }
    } catch (error) {
      await this.addDiagnosticObserved(operation.operationId, {
        at: Date.now(),
        stage: "import_job",
        code: "IMPORT_JOB_POLL_ERROR",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        details: extractFailureDetails(error)
      }, meta);
    }

    const fresh = await this.store.getById(operation.operationId);
    return fresh || operation;
  }

  async compileDraft(
    session: SessionRecord,
    operationId: string,
    capsuleId: string,
    meta?: ServiceRequestMeta
  ): Promise<ImportOperation> {
    const operation = await this.requireOwnedOperation(session, operationId);
    await this.updateStatusObserved(operationId, "compile_running", "compile_running", { capsuleId }, meta);
    try {
      await this.vibecodr.compileDraft(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        capsuleId,
        this.upstreamMeta(session, operation, meta)
      );
      return this.updateStatusObserved(operationId, "draft_ready", "compiled", { capsuleId }, meta);
    } catch (error) {
      await this.addDiagnosticObserved(operationId, {
        at: Date.now(),
        stage: "compile",
        code: "COMPILE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        details: extractFailureDetails(error)
      }, meta);
      return this.updateStatusObserved(operationId, "compile_failed", "compile_failed", { capsuleId }, meta);
    }
  }

  async publishDraft(
    session: SessionRecord,
    operationId: string,
    capsuleId: string,
    options?: PublishDraftOptions,
    meta?: ServiceRequestMeta
  ): Promise<ImportOperation> {
    const operation = await this.requireOwnedOperation(session, operationId);
    await this.updateStatusObserved(operationId, "publish_running", "publish_running", { capsuleId }, meta);
    try {
      const result = await this.vibecodr.publishDraft(
        { userId: session.userId, vibecodrToken: session.vibecodrToken },
        capsuleId,
        { visibility: options?.visibility },
        this.upstreamMeta(session, operation, meta)
      ) as Record<string, unknown>;
      const postId = typeof result["postId"] === "string" ? result["postId"] : undefined;

      const requestedCoverKey = trimToUndefined(options?.coverKey);
      const requestedSeo = trimSeoFields(options?.seo);
      const thumbnailInput = {
        ...(options?.thumbnailFile ? { thumbnailFile: options.thumbnailFile } : {}),
        ...(options?.thumbnailUpload ? { thumbnailUpload: options.thumbnailUpload } : {})
      };
      const shouldApplyMetadata = Boolean(
        requestedCoverKey || requestedSeo || thumbnailInput.thumbnailFile || thumbnailInput.thumbnailUpload
      );
      let metadataWarning = false;

      if (shouldApplyMetadata && postId) {
        try {
          let effectiveCoverKey = requestedCoverKey;
          const resolvedThumbnail = await resolveThumbnailInput(thumbnailInput);
          if (resolvedThumbnail) {
            const usage = await this.resolveCoverUsage(
              session,
              operation,
              postId,
              options?.visibility,
              meta
            );
            const uploaded = await this.vibecodr.uploadCover(
              { userId: session.userId, vibecodrToken: session.vibecodrToken },
              {
                contentType: trimToUndefined(resolvedThumbnail.contentType) || "application/octet-stream",
                fileBytes: resolvedThumbnail.fileBytes,
                usage
              },
              this.upstreamMeta(session, operation, meta)
            );
            effectiveCoverKey = uploaded.key;
            await this.addDiagnosticObserved(operationId, {
              at: Date.now(),
              stage: "publish",
              code: "THUMBNAIL_UPLOADED",
              message: "App thumbnail uploaded",
              details: {
                coverKey: uploaded.key,
                usage: uploaded.usage,
                source: resolvedThumbnail.source,
                ...(resolvedThumbnail.fileId ? { fileId: resolvedThumbnail.fileId } : {})
              }
            }, meta);
          }

          let effectiveSeo = requestedSeo;
          if (effectiveCoverKey && effectiveSeo && !trimToUndefined(effectiveSeo.imageKey)) {
            effectiveSeo = { ...effectiveSeo, imageKey: effectiveCoverKey };
          }

          if (effectiveCoverKey || effectiveSeo) {
            await this.vibecodr.updatePostMetadata(
              { userId: session.userId, vibecodrToken: session.vibecodrToken },
              postId,
              {
                ...(effectiveCoverKey ? { coverKey: effectiveCoverKey } : {}),
                ...(effectiveSeo ? { seo: effectiveSeo } : {})
              },
              this.upstreamMeta(session, operation, meta)
            );
            await this.addDiagnosticObserved(operationId, {
              at: Date.now(),
              stage: "publish",
              code: "POST_METADATA_APPLIED",
              message: "Post thumbnail/SEO metadata updated",
              details: {
                postId,
                coverKey: effectiveCoverKey,
                hasSeo: Boolean(effectiveSeo)
              }
            }, meta);
          }
        } catch (error) {
          metadataWarning = true;
          await this.addDiagnosticObserved(operationId, {
            at: Date.now(),
            stage: "publish",
            code: "POST_METADATA_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            details: { postId }
          }, meta);
        }
      } else if (shouldApplyMetadata && !postId) {
        metadataWarning = true;
        await this.addDiagnosticObserved(operationId, {
          at: Date.now(),
          stage: "publish",
          code: "POST_METADATA_SKIPPED",
          message: "Publish response missing postId; thumbnail/SEO update skipped",
          details: { result }
        }, meta);
      }

      await this.addDiagnosticObserved(operationId, {
        at: Date.now(),
        stage: "publish",
        code: "PUBLISHED",
        message: "Publish completed",
        details: {
          artifactUrl: result["artifactUrl"],
          postUrl: result["postUrl"],
          postId
        }
      }, meta);
      return this.updateStatusObserved(
        operationId,
        "published",
        metadataWarning ? "published_with_warnings" : "published",
        { capsuleId },
        meta
      );
    } catch (error) {
      await this.addDiagnosticObserved(operationId, {
        at: Date.now(),
        stage: "publish",
        code: "PUBLISH_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        details: extractFailureDetails(error)
      }, meta);
      return this.updateStatusObserved(operationId, "failed", "failed", { capsuleId }, meta);
    }
  }

  async cancelImport(session: SessionRecord, operationId: string, meta?: ServiceRequestMeta): Promise<ImportOperation> {
    const op = await this.store.getById(operationId);
    if (!op || op.userId !== session.userId) throw new Error("Operation not found");
    if (op.importJobId) {
      try {
        await this.vibecodr.cancelImportJob(
          { userId: session.userId, vibecodrToken: session.vibecodrToken },
          op.importJobId,
          this.upstreamMeta(session, op, meta)
        );
      } catch {
        // best effort upstream cancel
      }
    }
    return this.updateStatusObserved(operationId, "canceled", "canceled", undefined, meta);
  }
}
