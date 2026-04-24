import type { PublishThumbnailFile, PublishThumbnailUpload } from "../types.js";

export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
export const MAX_INLINE_THUMBNAIL_BYTES = 900 * 1024;
const THUMBNAIL_SIZE_ERROR = "thumbnail exceeds 5 MB max size.";
const INLINE_THUMBNAIL_SIZE_ERROR =
  "thumbnailUpload exceeds the inline MCP payload limit. Prefer thumbnailFile or keep the raw file under 900 KB.";
const THUMBNAIL_MIME_ERROR =
  "thumbnail.contentType must be one of: image/png, image/jpeg, image/webp, image/avif, image/gif.";

export const ALLOWED_THUMBNAIL_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif"
]);

const ALLOWED_OPENAI_DOWNLOAD_HOST_SUFFIXES = [
  ".openai.com",
  ".chatgpt.com",
  ".oaiusercontent.com",
  ".oaistatic.com",
  ".openaiusercontent.com"
];

export type ResolvedThumbnailUpload = {
  contentType: string;
  fileBytes: Uint8Array;
  fileName?: string;
  source: "openai_file" | "base64";
  fileId?: string;
};

function normalizeContentType(value: string | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() || "";
}

export function isAllowedThumbnailMime(value: string | undefined): boolean {
  return ALLOWED_THUMBNAIL_MIME.has(normalizeContentType(value));
}

function assertAllowedThumbnailMime(value: string | undefined): string {
  const contentType = normalizeContentType(value);
  if (!isAllowedThumbnailMime(contentType)) {
    throw new Error(THUMBNAIL_MIME_ERROR);
  }
  return contentType;
}

function assertThumbnailByteLength(byteLength: number): void {
  if (byteLength > MAX_THUMBNAIL_BYTES) {
    throw new Error(THUMBNAIL_SIZE_ERROR);
  }
}

function assertInlineThumbnailByteLength(byteLength: number): void {
  if (byteLength > MAX_INLINE_THUMBNAIL_BYTES) {
    throw new Error(INLINE_THUMBNAIL_SIZE_ERROR);
  }
}

export function validateOpenAiDownloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("thumbnailFile.downloadUrl must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("thumbnailFile.downloadUrl must use HTTPS.");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = ALLOWED_OPENAI_DOWNLOAD_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
  if (!allowed) {
    throw new Error("thumbnailFile.downloadUrl must point to an OpenAI-hosted file URL.");
  }
  return url;
}

async function resolveHostedThumbnailFile(
  file: PublishThumbnailFile,
  httpFetch: typeof fetch
): Promise<ResolvedThumbnailUpload> {
  const downloadUrl = validateOpenAiDownloadUrl(file.downloadUrl);
  const response = await httpFetch(downloadUrl, {
    method: "GET",
    headers: { accept: file.contentType || "application/octet-stream" }
  });
  if (!response.ok) {
    throw new Error("thumbnailFile download failed with status " + response.status + ".");
  }

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength)) {
    assertThumbnailByteLength(contentLength);
  }

  const responseContentType = assertAllowedThumbnailMime(
    response.headers.get("content-type") || file.contentType
  );

  if (!response.body) {
    throw new Error("thumbnailFile response body was missing.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    assertThumbnailByteLength(totalBytes);
    chunks.push(value);
  }

  if (totalBytes === 0) {
    throw new Error("thumbnailFile downloaded zero bytes.");
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    contentType: responseContentType,
    fileBytes: buffer,
    ...(file.fileName ? { fileName: file.fileName } : {}),
    source: "openai_file",
    fileId: file.fileId
  };
}

async function resolveBase64ThumbnailUpload(
  upload: PublishThumbnailUpload
): Promise<ResolvedThumbnailUpload> {
  const contentType = assertAllowedThumbnailMime(upload.contentType);

  const fileBase64 = upload.fileBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!fileBase64) {
    throw new Error("thumbnailUpload.fileBase64 is empty after normalization.");
  }
  const estimatedBytes = Math.floor((fileBase64.length * 3) / 4);
  assertInlineThumbnailByteLength(estimatedBytes);

  const buffer = new Uint8Array(Buffer.from(fileBase64, "base64"));
  if (buffer.byteLength === 0) {
    throw new Error("thumbnailUpload decoded to zero bytes.");
  }
  assertInlineThumbnailByteLength(buffer.byteLength);

  return {
    contentType,
    fileBytes: buffer,
    ...(upload.fileName ? { fileName: upload.fileName } : {}),
    source: "base64"
  };
}

export async function resolveThumbnailInput(
  input: {
    thumbnailFile?: PublishThumbnailFile | undefined;
    thumbnailUpload?: PublishThumbnailUpload | undefined;
  },
  httpFetch: typeof fetch = fetch
): Promise<ResolvedThumbnailUpload | undefined> {
  if (input.thumbnailFile) {
    return resolveHostedThumbnailFile(input.thumbnailFile, httpFetch);
  }
  if (input.thumbnailUpload) {
    return resolveBase64ThumbnailUpload(input.thumbnailUpload);
  }
  return undefined;
}
