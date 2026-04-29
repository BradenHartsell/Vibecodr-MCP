export type SourceType = "codex_v1" | "chatgpt_v1";
export type ImportMode = "direct_files" | "zip_import" | "github_import";
export type RunnerType = "client-static" | "webcontainer";
export type PublishVisibility = "public" | "unlisted" | "private";
export type CoverUsage = "app_cover" | "standalone";

export type CurrentUserProfileSummary = {
  id: string;
  handle: string;
  name?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  plan?: string;
  createdAt?: number | string;
  stats?: {
    followers?: number;
    following?: number;
    posts?: number;
    runs?: number;
    remixes?: number;
  };
};

export type VibecodrQuotaSummary = {
  plan: string;
  usage: {
    storage: number;
    runs: number;
    bundleSize: number;
    serverActionRuns?: number;
    serverActionCount?: number;
    webhookCalls?: number;
    privateVibesUsed?: number;
    privatePulsesUsed?: number;
  };
  limits: {
    maxStorage: number;
    maxRuns: number | "unlimited";
    maxPrivateVibes: number | "unlimited";
    maxConnections: number | "unlimited";
    serverActions: {
      maxActions: number;
      maxRunsPerMonth: number;
      maxRuntimeMs: number;
    };
    pulses: {
      maxActions: number;
      maxRunsPerMonth: number;
      maxRuntimeMs: number;
      maxPrivatePulses: number | "unlimited";
      maxSubrequests: number;
      maxVanitySubdomains: number;
      proxyRateLimit: number;
      secretsProxyOwnerRateLimit: number;
      secretsProxyPulseRateLimit: number;
    };
    webhookActions: {
      maxActions: number;
      maxCallsPerMonth: number;
    };
    features: {
      customSeo: boolean;
      serverActionsEnabled: boolean;
      pulsesEnabled: boolean;
      webhookActionsEnabled: boolean;
      embedsUnbranded: boolean;
      customDomains: number;
      d1SqlEnabled: boolean;
      secretsStoreEnabled: boolean;
      canPublishLibraryVibes: boolean;
      advancedZipAnalysis: boolean;
      studioParamsTab: boolean;
      studioFilesTab: boolean;
    };
  };
  percentUsed?: {
    storage: number;
    runs: number;
    bundleSize?: number;
    serverActionRuns?: number;
    webhookCalls?: number;
  };
};

export type AccountCapabilitiesSummary = {
  profile: CurrentUserProfileSummary;
  quota: VibecodrQuotaSummary;
  launchDefaults: {
    visibility: "public";
    shouldOfferCoverGeneration: boolean;
    shouldOfferCustomSeo: boolean;
    shouldOfferPulseGuidance: boolean;
  };
  features: {
    customSeo: boolean;
    canUsePrivateOrUnlisted: boolean;
    pulsesEnabled: boolean;
    serverActionsEnabled: boolean;
    webhookActionsEnabled: boolean;
  };
  remaining: {
    pulseSlots: number;
    pulseRunsThisMonth: number | "unlimited";
    webhookCalls: number;
    privateVibes?: number | "unlimited";
    privatePulses?: number | "unlimited";
  };
  recommendations: string[];
};

export type LaunchBestPractices = {
  headline: string;
  summary: string;
  premiumLaunchChecklist: string[];
  assistantBehavior: string[];
  coverGuidance: {
    shouldOfferGeneration: boolean;
    whenToOffer: string;
    whyItMatters: string;
  };
  seoGuidance: {
    shouldOfferForPublicLaunch: boolean;
    whyItMatters: string;
    requiresCapabilityCheck: boolean;
  };
  polishMoments: string[];
};

export type PulseSetupGuidance = {
  headline: string;
  summary: string;
  descriptorMetadata: PulseDescriptorSetupMetadata;
  descriptorEvaluation: PulseDescriptorSetupEvaluation;
  whenFrontendOnlyIsEnough: string[];
  whenYouNeedPulses: string[];
  runnerGuidance: string[];
  pulseBestPractices: string[];
  accountReminder: string;
};

export type PulseDescriptorSetupTaskKind =
  | "pulse"
  | "secret"
  | "env"
  | "connection"
  | "database"
  | "review"
  | "raw_body"
  | "state";

export type PulseDescriptorSetupTaskSummary = {
  kind: PulseDescriptorSetupTaskKind;
  name?: string;
  label?: string;
  description?: string;
  required?: boolean;
};

export type PulseDescriptorSetupEvaluation = {
  status: "general_contract" | "descriptor_evaluated" | "blocked";
  guidanceSource: "general_contract" | "descriptor_setup";
  requiresBackendSetup: boolean;
  activeSetupTaskKinds: PulseDescriptorSetupTaskKind[];
  setupTasks: PulseDescriptorSetupTaskSummary[];
  blockers: string[];
  warnings: string[];
};

export type PulseDescriptorSetupMetadata = {
  sourceOfTruth: "PulseDescriptor";
  apiVersion: "pulse/v1";
  normalizedDescriptorVersion: number;
  stateProtocolVersion: string;
  resourceConfigVersion: number;
  apiProjection: {
    openApiSchema: "PulseDescriptorSetupProjection";
    responseField: "descriptorSetup";
  };
  setupTaskKinds: PulseDescriptorSetupTaskKind[];
  activeSetupTaskKinds: PulseDescriptorSetupTaskKind[];
  requiresBackendSetup: boolean;
  guidanceSource: PulseDescriptorSetupEvaluation["guidanceSource"];
  compatibility: {
    blockerCount: number;
    warningCount: number;
  };
  runtimeEnv: {
    pulse: "env.pulse.*";
    fetch: "env.fetch";
    log: "env.log";
    request: "env.request";
    runtime: "env.runtime";
    waitUntil: "env.waitUntil";
  };
  runtimeSemantics: {
    fetch: string;
    log: string;
    request: string;
    runtime: string;
    waitUntil: string;
    database: string;
    cleanupAuthority: string;
  };
  descriptorOwnedSurfaces: string[];
  advancedCompatibility: string[];
};

export type EncodedFile = {
  path: string;
  content: string;
  contentEncoding: "utf8" | "base64";
};

export type NormalizedCreationPackage = {
  sourceType: SourceType;
  sourceReference?: string | undefined;
  title: string;
  runner: RunnerType;
  entry: string;
  files: EncodedFile[];
  importMode: ImportMode;
  metadata?: Record<string, unknown> | undefined;
  idempotencyKey: string;
  github?: {
    url: string;
    branch?: string | undefined;
    rootHint?: string | undefined;
    allowModuleScripts?: boolean | undefined;
    async?: boolean | undefined;
  };
  zip?: {
    fileName: string;
    fileBase64: string;
    rootHint?: string | undefined;
    allowModuleScripts?: boolean | undefined;
    async?: boolean | undefined;
  };
};

export type OperationStatus =
  | "received"
  | "validating"
  | "normalized"
  | "ingesting"
  | "waiting_on_import_job"
  | "draft_ready"
  | "compile_running"
  | "compile_failed"
  | "publish_running"
  | "published"
  | "published_with_warnings"
  | "failed"
  | "canceled";

export type ImportOperation = {
  operationId: string;
  userId: string;
  sourceType: SourceType;
  sourceReference?: string | undefined;
  status: OperationStatus;
  currentStage: string;
  capsuleId?: string | undefined;
  importJobId?: string | undefined;
  diagnostics: Array<{
    at: number;
    stage: string;
    code: string;
    message: string;
    retryable?: boolean | undefined;
    details?: Record<string, unknown> | undefined;
  }>;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
};

export type SessionRecord = {
  sessionId: string;
  userId: string;
  userHandle?: string | undefined;
  vibecodrToken: string;
  createdAt: number;
  expiresAt: number;
};

export type VibeClientUserContext = {
  userId: string;
  userHandle?: string | undefined;
  vibecodrToken: string;
};

export type PublishSeoFieldsInput = {
  title?: string | undefined;
  description?: string | undefined;
  imageKey?: string | undefined;
};

export type PublishSeoInput = PublishSeoFieldsInput & {
  og?: PublishSeoFieldsInput | null | undefined;
  twitter?: PublishSeoFieldsInput | null | undefined;
};

export type PublishThumbnailUpload = {
  contentType: string;
  fileBase64: string;
  fileName?: string | undefined;
};

export type PublishThumbnailFile = {
  fileId: string;
  downloadUrl: string;
  contentType: string;
  fileName?: string | undefined;
};

export type PublishDraftOptions = {
  visibility?: PublishVisibility | undefined;
  coverKey?: string | undefined;
  thumbnailFile?: PublishThumbnailFile | undefined;
  thumbnailUpload?: PublishThumbnailUpload | undefined;
  seo?: PublishSeoInput | undefined;
};

export type LiveVibeSummary = {
  postId: string;
  title: string;
  description?: string | null | undefined;
  visibility: PublishVisibility;
  authorHandle?: string | undefined;
  authorName?: string | null | undefined;
  coverKey?: string | null | undefined;
  createdAt?: number | string | undefined;
  updatedAt?: number | string | undefined;
  playerUrl: string;
  postUrl: string;
  capsuleId?: string | null | undefined;
  stats: {
    runs: number;
    likes: number;
    comments: number;
    remixes: number;
    views?: number | undefined;
    embedViews?: number | undefined;
  };
  packageSummary?: {
    runner?: string | undefined;
    entry?: string | undefined;
    artifactId?: string | null | undefined;
  } | undefined;
};

export type VibeEngagementSummary = {
  postId: string;
  title: string;
  visibility: PublishVisibility;
  playerUrl: string;
  postUrl: string;
  stats: {
    runs: number;
    likes: number;
    comments: number;
    remixes: number;
    views?: number | undefined;
    embedViews?: number | undefined;
  };
  summary: string;
};

export type VibeShareSummary = {
  postId: string;
  title: string;
  visibility: PublishVisibility;
  postUrl: string;
  playerUrl: string;
  shareCta: string;
};

export type SocialProfileSummary = CurrentUserProfileSummary & {
  profileUrl: string;
};

export type SocialSearchResult = {
  type: "post" | "profile" | "tag" | "unknown";
  id: string;
  title: string;
  url?: string | undefined;
  description?: string | undefined;
  authorHandle?: string | undefined;
};

export type RemixLineageSummary = {
  capsuleId?: string | undefined;
  postId?: string | undefined;
  remixes: Array<{
    id: string;
    title?: string | undefined;
    postId?: string | undefined;
    capsuleId?: string | undefined;
    authorHandle?: string | undefined;
    createdAt?: number | string | undefined;
  }>;
};

export type OperationWatchResult = {
  operation: ImportOperation;
  reachedTarget: boolean;
  timedOut: boolean;
  elapsedMs: number;
  pollCount: number;
  targetStatuses: OperationStatus[];
};

export type PublishReadinessLevel = "pass" | "warning" | "blocking";

export type PublishReadinessCheck = {
  id: string;
  level: PublishReadinessLevel;
  message: string;
  details?: Record<string, unknown> | undefined;
};

export type PublishReadinessResult = {
  readyToPublish: boolean;
  operation: ImportOperation;
  capsuleId?: string | undefined;
  checks: PublishReadinessCheck[];
  recommendedActions: string[];
};

export type QuickPublishStep = {
  step: "import" | "wait_for_draft" | "compile" | "publish";
  status: "completed" | "skipped" | "failed" | "timed_out";
  message: string;
  at: number;
  details?: Record<string, unknown> | undefined;
};

export type QuickPublishResult = {
  operation: ImportOperation;
  published: boolean;
  timedOut: boolean;
  steps: QuickPublishStep[];
  recommendedActions: string[];
};

export type OperationFailureExplanation = {
  operationId: string;
  status: OperationStatus;
  failed: boolean;
  rootCauseCode?: string | undefined;
  rootCauseMessage?: string | undefined;
  retryable: boolean;
  userMessage: string;
  nextActions: string[];
  latestDiagnostics: Array<{
    at: number;
    stage: string;
    code: string;
    message: string;
    retryable?: boolean | undefined;
  }>;
};
