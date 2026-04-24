import { z } from "zod";
import type { NormalizedCreationPackage } from "../types.js";
import { stableHash } from "../config.js";
import { assertSafePath } from "../lib/pathPolicy.js";

export class PackageResolutionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PackageResolutionError";
    this.code = code;
    this.details = details;
  }
}

const fileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  contentEncoding: z.enum(["utf8", "base64"]).default("utf8")
});

const baseSchema = z.object({
  sourceType: z.enum(["codex_v1", "chatgpt_v1"]),
  sourceReference: z.string().optional(),
  title: z.string().min(1).max(120).optional(),
  runner: z.enum(["client-static", "webcontainer"]).default("client-static"),
  entry: z.string().min(1).optional(),
  files: z.array(fileSchema).default([]),
  importMode: z.enum(["direct_files", "zip_import", "github_import"]).default("direct_files"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
  github: z.object({
    url: z.string().url(),
    branch: z.string().optional(),
    rootHint: z.string().optional(),
    allowModuleScripts: z.boolean().optional(),
    async: z.boolean().optional()
  }).optional(),
  zip: z.object({
    fileName: z.string().min(1),
    fileBase64: z.string().min(1),
    rootHint: z.string().optional(),
    allowModuleScripts: z.boolean().optional(),
    async: z.boolean().optional()
  }).optional()
});

function normalizeFiles(files: Array<{ path: string; content: string; contentEncoding: "utf8" | "base64" }>) {
  const out = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of out) assertSafePath(file.path);
  const totalChars = out.reduce((sum, file) => sum + file.content.length, 0);
  if (out.length > 500) throw new Error("INGEST_FILE_LIMIT_EXCEEDED");
  if (totalChars > 15000000) throw new Error("INGEST_TOTAL_BYTES_LIMIT_EXCEEDED");
  return out;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function humanizeSlug(value: string): string {
  return value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parsePackageJsonTitle(files: Array<{ path: string; content: string; contentEncoding: "utf8" | "base64" }>): string | undefined {
  const packageFile = files.find((file) => normalizePath(file.path).toLowerCase() === "package.json");
  if (!packageFile || packageFile.contentEncoding !== "utf8") return undefined;
  try {
    const parsed = JSON.parse(packageFile.content) as Record<string, unknown>;
    const title = typeof parsed["title"] === "string"
      ? parsed["title"]
      : typeof parsed["name"] === "string"
        ? humanizeSlug(parsed["name"])
        : undefined;
    const trimmed = title?.trim();
    return trimmed ? trimmed.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function inferTitle(
  parsed: z.infer<typeof baseSchema>,
  files: Array<{ path: string; content: string; contentEncoding: "utf8" | "base64" }>
): string {
  const explicit = parsed.title?.trim();
  if (explicit) return explicit.slice(0, 120);

  const fromPackageJson = parsePackageJsonTitle(files);
  if (fromPackageJson) return fromPackageJson;

  const sourceReference = parsed.sourceReference?.trim();
  if (sourceReference) {
    const lastSegment = sourceReference.split(/[\\/]/).filter(Boolean).at(-1);
    if (lastSegment) {
      const humanized = humanizeSlug(lastSegment);
      if (humanized) return humanized.slice(0, 120);
    }
  }

  return "Imported Vibe";
}

function buildEntryCandidates(paths: string[]): string[] {
  const set = new Set(paths.map((value) => value.toLowerCase()));
  const ordered = [
    "index.html",
    "src/index.html",
    "src/main.tsx",
    "src/index.tsx",
    "main.tsx",
    "index.tsx",
    "src/main.jsx",
    "src/index.jsx",
    "main.jsx",
    "index.jsx",
    "src/main.ts",
    "src/index.ts",
    "main.ts",
    "index.ts",
    "src/main.js",
    "src/index.js",
    "main.js",
    "index.js"
  ];

  return ordered.filter((candidate) => set.has(candidate.toLowerCase()));
}

function resolveEntry(
  parsed: z.infer<typeof baseSchema>,
  files: Array<{ path: string; content: string; contentEncoding: "utf8" | "base64" }>
): string {
  const filePaths = files.map((file) => normalizePath(file.path));
  const normalizedSet = new Set(filePaths.map((path) => path.toLowerCase()));
  const explicit = parsed.entry?.trim();
  if (explicit) {
    const normalizedExplicit = normalizePath(explicit);
    const alternate =
      normalizedExplicit.startsWith("src/") ? normalizedExplicit.slice("src/".length) : `src/${normalizedExplicit}`;
    if (normalizedSet.has(normalizedExplicit.toLowerCase()) || normalizedSet.has(alternate.toLowerCase())) {
      return normalizedExplicit;
    }
    throw new PackageResolutionError(
      "INGEST_ENTRY_NOT_FOUND",
      `The supplied entry "${normalizedExplicit}" does not exist in the uploaded files. Retry with payload.entry set to the actual app entry file.`,
      {
        requestedEntry: normalizedExplicit,
        candidateEntries: buildEntryCandidates(filePaths).slice(0, 8)
      }
    );
  }

  const candidates = buildEntryCandidates(filePaths);
  if (candidates.length > 0) return candidates[0]!;

  throw new PackageResolutionError(
    "INGEST_ENTRY_REQUIRED",
    "No runnable entry file could be inferred from the uploaded files. Ask the model that built the app which file starts the app, then retry with payload.entry set to that file.",
    {
      candidateEntries: filePaths
        .filter((path) => /\.(tsx|jsx|ts|js|html)$/i.test(path))
        .filter((path) => !/\.d\.ts$/i.test(path))
        .filter((path) => !/(^|\/)(test|tests|__tests__|spec|stories)\//i.test(path))
        .slice(0, 12)
    }
  );
}

export function parseNormalizedPackage(input: unknown): NormalizedCreationPackage {
  const parsed = baseSchema.parse(input);
  const files = normalizeFiles(parsed.files);
  if (parsed.importMode === "direct_files" && files.length === 0) throw new Error("INGEST_NO_FILES_FOR_DIRECT_IMPORT");
  if (parsed.importMode === "zip_import" && !parsed.zip) throw new Error("INGEST_ZIP_PAYLOAD_REQUIRED");
  if (parsed.importMode === "github_import" && !parsed.github) throw new Error("INGEST_GITHUB_PAYLOAD_REQUIRED");

  const title = inferTitle(parsed, files);
  const entry = parsed.importMode === "direct_files" ? resolveEntry(parsed, files) : parsed.entry?.trim() || "index.tsx";

  const idem = parsed.idempotencyKey?.trim() || stableHash(JSON.stringify({
    sourceType: parsed.sourceType,
    sourceReference: parsed.sourceReference || "",
    title,
    runner: parsed.runner,
    entry,
    importMode: parsed.importMode,
    files: files.map((f) => [f.path, f.contentEncoding, f.content.length])
  }));

  return {
    sourceType: parsed.sourceType,
    title,
    runner: parsed.runner,
    entry,
    files,
    importMode: parsed.importMode,
    idempotencyKey: idem,
    ...(parsed.sourceReference !== undefined ? { sourceReference: parsed.sourceReference } : {}),
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    ...(parsed.github !== undefined ? { github: parsed.github } : {}),
    ...(parsed.zip !== undefined ? { zip: parsed.zip } : {})
  };
}
