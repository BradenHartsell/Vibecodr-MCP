import type {
  PulseDescriptorSetupEvaluation,
  PulseDescriptorSetupMetadata,
  PulseDescriptorSetupTaskKind,
  PulseDescriptorSetupTaskSummary,
  PulseSetupGuidance
} from "../types.js";

const PULSE_DESCRIPTOR_SETUP_TASK_KINDS = [
  "pulse",
  "secret",
  "env",
  "connection",
  "database",
  "review",
  "raw_body",
  "state"
] as const satisfies readonly PulseDescriptorSetupTaskKind[];

const PULSE_DESCRIPTOR_SETUP_TASK_KIND_SET = new Set<string>(PULSE_DESCRIPTOR_SETUP_TASK_KINDS);

export const PULSE_DESCRIPTOR_SETUP_METADATA: PulseDescriptorSetupMetadata = {
  sourceOfTruth: "PulseDescriptor",
  apiVersion: "pulse/v1",
  normalizedDescriptorVersion: 1,
  stateProtocolVersion: "pulse-state/1",
  resourceConfigVersion: 1,
  apiProjection: {
    openApiSchema: "PulseDescriptorSetupProjection",
    responseField: "descriptorSetup"
  },
  setupTaskKinds: [...PULSE_DESCRIPTOR_SETUP_TASK_KINDS],
  activeSetupTaskKinds: [],
  requiresBackendSetup: false,
  guidanceSource: "general_contract",
  compatibility: {
    blockerCount: 0,
    warningCount: 0
  },
  runtimeEnv: {
    pulse: "env.pulse.*",
    fetch: "env.fetch",
    log: "env.log",
    request: "env.request",
    runtime: "env.runtime",
    waitUntil: "env.waitUntil"
  },
  runtimeSemantics: {
    fetch: "env.fetch is Vibecodr policy-mediated fetch, not raw platform fetch.",
    log: "env.log accepts structured event records instead of raw variadic logging.",
    request: "env.request is sanitized by default; raw-body access is explicit, bounded, and still sanitized.",
    runtime: "env.runtime carries safe correlation metadata only, not authorization or owner identity.",
    waitUntil: "env.waitUntil is best-effort after-response work, not durable jobs or state completion.",
    database: "env.db, when present, is advanced compatibility SQL guidance, not the beginner backend story.",
    cleanupAuthority: "Cleanup lifecycle authority belongs to platform owners and is not a creator runtime capability."
  },
  descriptorOwnedSurfaces: [
    "setup tasks",
    "runtime validation",
    "generated examples",
    "local replay fixtures",
    "cost and limit previews",
    "route identity",
    "API projection",
    "deployment compatibility checks"
  ],
  advancedCompatibility: [
    "Database access belongs to advanced compatibility guidance.",
    "Raw platform bindings are internal implementation details, not beginner setup instructions."
  ]
};

export function buildPulseSetupGuidance(input?: { descriptorSetup?: unknown }): PulseSetupGuidance {
  const descriptorEvaluation = evaluatePulseDescriptorSetup(input?.descriptorSetup);
  const activeKindSummary = formatSetupTaskKinds(descriptorEvaluation.activeSetupTaskKinds);
  const descriptorMetadata: PulseDescriptorSetupMetadata = {
    ...PULSE_DESCRIPTOR_SETUP_METADATA,
    activeSetupTaskKinds: descriptorEvaluation.activeSetupTaskKinds,
    requiresBackendSetup: descriptorEvaluation.requiresBackendSetup,
    guidanceSource: descriptorEvaluation.guidanceSource,
    compatibility: {
      blockerCount: descriptorEvaluation.blockers.length,
      warningCount: descriptorEvaluation.warnings.length
    }
  };
  const isBlocked = descriptorEvaluation.status === "blocked";
  const hasDescriptor = descriptorEvaluation.guidanceSource === "descriptor_setup";
  const hasBackendSetup = descriptorEvaluation.requiresBackendSetup;

  return {
    headline: isBlocked
      ? "Fix descriptor blockers before promising Pulse setup."
      : hasDescriptor && hasBackendSetup
        ? `Pulse setup is required for ${activeKindSummary}.`
        : hasDescriptor
          ? "The descriptor has no backend setup tasks; keep the vibe frontend-only unless product intent changes."
          : "Choose frontend-only by default, then pass descriptorSetup when Pulse setup needs to be evaluated.",
    summary: isBlocked
      ? `The supplied PulseDescriptor setup projection is blocked: ${descriptorEvaluation.blockers.join("; ")}`
      : hasDescriptor
        ? hasBackendSetup
          ? `The supplied PulseDescriptor setup projection declares ${activeKindSummary}. Use those setup tasks as the MCP setup contract.`
          : "The supplied PulseDescriptor setup projection has no backend setup tasks. Do not invent secret, raw body, connection, or state guidance."
        : "A zero-context agent should treat normalized PulseDescriptor metadata as the setup contract. Pass the descriptorSetup projection when available so this guidance reflects the actual pulse instead of general rules.",
    descriptorMetadata,
    descriptorEvaluation,
    whenFrontendOnlyIsEnough: buildFrontendGuidance(descriptorEvaluation),
    whenYouNeedPulses: buildPulseEscalationGuidance(descriptorEvaluation),
    runnerGuidance: [
      "Use client-static for normal feed apps that only need frontend code.",
      "Use webcontainer when the package needs richer browser-based runtime tooling on the client side.",
      "Use pulses for trusted backend actions and follow descriptor-derived setup tasks."
    ],
    pulseBestPractices: [
      "Keep the pulse surface narrow and name exactly what the backend action does.",
      "Pass only the minimum data from the vibe into the pulse.",
      "Use descriptor setup tasks for pulse values, secrets, connections, raw body, and state placeholders.",
      ...descriptorEvaluation.setupTasks.map((task) => formatSetupTaskPractice(task)),
      "Use policy fetch, structured logging, sanitized requests, safe runtime correlation ids, and best-effort waitUntil language.",
      "Check account capabilities before promising additional pulses or private pulses."
    ],
    accountReminder:
      "Before promising pulse-backed behavior, call get_account_capabilities so the model knows the user's plan, pulse slot availability, and whether backend features are available."
  };
}

function evaluatePulseDescriptorSetup(raw: unknown): PulseDescriptorSetupEvaluation {
  if (raw === undefined) {
    return {
      status: "general_contract",
      guidanceSource: "general_contract",
      requiresBackendSetup: false,
      activeSetupTaskKinds: [],
      setupTasks: [],
      blockers: [],
      warnings: []
    };
  }

  const descriptor = readRecord(raw);
  if (!descriptor) {
    return blockedDescriptorEvaluation(["descriptorSetup must be a PulseDescriptorSetupProjection object."]);
  }

  const blockers: string[] = [];
  const setupTasks = normalizeSetupTasks(descriptor["setupTasks"], blockers);
  const compatibility = readRecord(descriptor["compatibility"]);
  if (descriptor["compatibility"] !== undefined && !compatibility) {
    blockers.push("descriptorSetup.compatibility must be an object when provided.");
  }
  blockers.push(...readStringArrayField(compatibility?.["blockers"], "descriptorSetup.compatibility.blockers"));
  const warnings = readStringArrayField(compatibility?.["warnings"], "descriptorSetup.compatibility.warnings");
  const activeSetupTaskKinds = uniqueSetupTaskKinds(setupTasks);

  return {
    status: blockers.length > 0 ? "blocked" : "descriptor_evaluated",
    guidanceSource: "descriptor_setup",
    requiresBackendSetup: activeSetupTaskKinds.length > 0,
    activeSetupTaskKinds,
    setupTasks,
    blockers,
    warnings
  };
}

function blockedDescriptorEvaluation(blockers: string[]): PulseDescriptorSetupEvaluation {
  return {
    status: "blocked",
    guidanceSource: "descriptor_setup",
    requiresBackendSetup: false,
    activeSetupTaskKinds: [],
    setupTasks: [],
    blockers,
    warnings: []
  };
}

function normalizeSetupTasks(raw: unknown, blockers: string[]): PulseDescriptorSetupTaskSummary[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    blockers.push("descriptorSetup.setupTasks must be an array.");
    return [];
  }

  const setupTasks: PulseDescriptorSetupTaskSummary[] = [];
  for (const [index, item] of raw.entries()) {
    const task = readRecord(item);
    if (!task) {
      blockers.push(`descriptorSetup.setupTasks[${index}] must be an object.`);
      continue;
    }
    const kind = typeof task["kind"] === "string" ? task["kind"] : "";
    if (!PULSE_DESCRIPTOR_SETUP_TASK_KIND_SET.has(kind)) {
      blockers.push(`descriptorSetup.setupTasks[${index}].kind is unsupported.`);
      continue;
    }
    setupTasks.push({
      kind: kind as PulseDescriptorSetupTaskKind,
      ...optionalStringProperty(task, "name"),
      ...optionalStringProperty(task, "label"),
      ...optionalStringProperty(task, "description"),
      ...(typeof task["required"] === "boolean" ? { required: task["required"] } : {})
    });
  }
  return setupTasks;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readStringArrayField(raw: unknown, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${label} must be an array.`];
  const strings = raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return strings.length === raw.length ? strings : [`${label} must contain only non-empty strings.`];
}

function optionalStringProperty(record: Record<string, unknown>, key: "name" | "label" | "description"): Partial<Record<typeof key, string>> {
  const value = record[key];
  return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
}

function uniqueSetupTaskKinds(tasks: readonly PulseDescriptorSetupTaskSummary[]): PulseDescriptorSetupTaskKind[] {
  const selected: PulseDescriptorSetupTaskKind[] = [];
  for (const task of tasks) {
    if (!selected.includes(task.kind)) selected.push(task.kind);
  }
  return selected;
}

function formatSetupTaskKinds(kinds: readonly PulseDescriptorSetupTaskKind[]): string {
  if (kinds.length === 0) return "no backend setup tasks";
  return kinds.map((kind) => kind.replace(/_/g, " ")).join(", ");
}

function buildFrontendGuidance(evaluation: PulseDescriptorSetupEvaluation): string[] {
  if (evaluation.status === "blocked") {
    return [
      "Do not treat this pulse as frontend-only while descriptor blockers are present.",
      "Repair the descriptor/source mismatch first, then regenerate descriptor-derived setup guidance."
    ];
  }
  if (evaluation.guidanceSource === "descriptor_setup" && !evaluation.requiresBackendSetup) {
    return [
      "The descriptor has no backend setup tasks.",
      "The app is purely interactive UI, local state, or deterministic client-side logic.",
      "All required data can be bundled with the app or fetched from public endpoints safely in the browser."
    ];
  }
  return [
    "The app is purely interactive UI, local state, or deterministic client-side logic.",
    "All required data can be bundled with the app or fetched from public endpoints safely in the browser.",
    "The normalized descriptor has no pulse, secret, connection, raw body, or state setup tasks."
  ];
}

function buildPulseEscalationGuidance(evaluation: PulseDescriptorSetupEvaluation): string[] {
  if (evaluation.status === "blocked") {
    return [
      `Fix descriptor blockers before promising pulse setup: ${evaluation.blockers.join("; ")}`,
      "Do not deploy or present setup guidance from a blocked descriptor projection."
    ];
  }
  if (evaluation.guidanceSource === "descriptor_setup" && evaluation.requiresBackendSetup) {
    return [
      `The descriptor declares ${formatSetupTaskKinds(evaluation.activeSetupTaskKinds)} setup tasks.`,
      "Use only those descriptor-derived setup tasks when explaining secrets, raw body handling, state, connections, env values, or database guidance.",
      "Check account capabilities before promising additional pulses or private pulses."
    ];
  }
  return [
    "The descriptor declares pulse values, secrets, connections, raw body handling, or future state resources.",
    "The app needs provider credentials, signed requests, webhooks, scheduled work, or trusted side effects.",
    "The product requirement cannot safely run as browser-only vibe code."
  ];
}

function formatSetupTaskPractice(task: PulseDescriptorSetupTaskSummary): string {
  const label = task.label || task.name || task.kind.replace(/_/g, " ");
  return `Descriptor setup task: ${task.kind.replace(/_/g, " ")}${label ? ` - ${label}` : ""}.`;
}

export function pulseDescriptorDecisionRequirements(): string[] {
  return [
    "Start with get_pulse_setup_guidance, pass descriptorSetup when available, and use descriptorEvaluation plus descriptorMetadata as the setup contract.",
    "If the user is connected, call get_account_capabilities before promising pulse-backed behavior.",
    "Default to frontend-only when the descriptor has no backend setup tasks and the app does not need trusted side effects.",
    "Recommend pulses only when product requirements or descriptor setup metadata clearly need trusted server-side work.",
    `Use ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.pulse}, ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.fetch}, ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.log}, ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.request}, ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.runtime}, and ${PULSE_DESCRIPTOR_SETUP_METADATA.runtimeEnv.waitUntil} vocabulary for Pulse authoring guidance.`,
    ...Object.values(PULSE_DESCRIPTOR_SETUP_METADATA.runtimeSemantics)
  ];
}
