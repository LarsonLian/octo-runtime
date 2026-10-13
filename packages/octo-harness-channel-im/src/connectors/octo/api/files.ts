/**
 * 文件 API：提供类型/尺寸识别和上传基础能力，供授权 IM 投递使用。
 * API 存在不代表产物回复流程已经实现；不扫描工作区或判断业务产物是否完成。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import path from "node:path";
import { open } from "node:fs/promises";

/**
 * Infer MIME type from filename extension. Returns a sensible default if unknown.
 */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".json": "application/json"
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Ensure text/* content types include a charset parameter.
 * If the content type starts with "text/" and has no charset, appends "; charset=utf-8".
 */
export function ensureTextCharset(contentType: string): string {
  if (contentType.startsWith("text/") && !contentType.includes("charset")) {
    return contentType + "; charset=utf-8";
  }
  return contentType;
}

/**
 * Parse image dimensions from buffer (PNG/JPEG/GIF/WebP).
 * Lightweight — reads only the header bytes, no external dependencies.
 */
export function parseImageDimensions(
  buf: Buffer,
  mime: string
): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && buf.length > 2) {
      // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === "image/gif" && buf.length > 10) {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buf.length > 30) {
      // WebP VP8: width at offset 26, height at offset 28 (both 2 bytes LE)
      if (buf.toString("ascii", 12, 16) === "VP8 " && buf.length > 29) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * Parse image dimensions from a file path by reading only the first 64KB.
 * Avoids loading the entire file into memory.
 */
export async function parseImageDimensionsFromFile(
  filePath: string,
  mime: string
): Promise<{ width: number; height: number } | null> {
  const HEADER_SIZE = 65536; // 64KB — enough for PNG/JPEG/GIF/WebP headers
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch {
    /* ignore read/parse errors */
  } finally {
    await fh?.close();
  }
  return null;
}

/**
 * Get a presigned PUT URL for direct, backend-agnostic file upload.
 *
 * Calls the server's `GET /v1/bot/upload/presigned` route, which signs a PUT
 * URL against whatever object storage the deployment is configured with
 * (MinIO / COS / S3 / OSS). This replaces the old COS-only STS-credentials
 * path so self-hosted Docker+MinIO deployments (no Tencent COS config) can
 * upload too — same presigned link the web/iOS/Android clients use.
 *
 * `fileSize` is REQUIRED and must be the exact byte count of the body the
 * caller is about to PUT: on SigV4 backends (MinIO/COS) it is signed into the
 * canonical headers as Content-Length, so any mismatch at PUT time returns
 * 403 SignatureDoesNotMatch. Callers MUST pass `statSync().size` of the real
 * payload, never a HEAD Content-Length guess.
 */
export async function getUploadPresign(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  fileSize: number;
  contentType?: string;
  signal?: AbortSignal;
}): Promise<{
  uploadUrl: string;
  downloadUrl: string;
  contentType: string;
  contentDisposition?: string;
}> {
  if (!Number.isInteger(params.fileSize) || params.fileSize <= 0) {
    throw new Error(
      `getUploadPresign requires a positive integer fileSize (got ${params.fileSize})`
    );
  }
  const query = new URLSearchParams({
    filename: params.filename,
    fileSize: String(params.fileSize)
  });
  if (params.contentType) query.set("contentType", params.contentType);
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/upload/presigned?${query.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`
    },
    signal: params.signal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Octo API /v1/bot/upload/presigned failed (${response.status}): ${text || response.statusText}`
    );
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.uploadUrl !== "string" || typeof data.downloadUrl !== "string") {
    throw new Error(
      `Octo API /v1/bot/upload/presigned returned incomplete response: missing ${[
        "uploadUrl",
        "downloadUrl"
      ]
        .filter((k) => typeof data[k] !== "string")
        .join(", ")}`
    );
  }
  return {
    uploadUrl: data.uploadUrl,
    downloadUrl: data.downloadUrl,
    contentType:
      typeof data.contentType === "string" ? data.contentType : "application/octet-stream",
    contentDisposition:
      typeof data.contentDisposition === "string" ? data.contentDisposition : undefined
  };
}

/**
 * Upload a file body with a single PUT to a server-issued presigned URL.
 *
 * The body must be exactly `fileSize` bytes — the same value passed to
 * {@link getUploadPresign} so the signed Content-Length matches (SigV4
 * backends 403 otherwise). `contentType` and `contentDisposition` are
 * replayed verbatim from the presign response: both are folded into the
 * canonical headers on MinIO/COS, so omitting or altering them returns
 * 403 SignatureDoesNotMatch.
 *
 * Returns `{ url }` = the presign response's `downloadUrl`, ready to drop
 * into a message payload.
 */
export async function uploadFileToPresignedUrl(params: {
  uploadUrl: string;
  downloadUrl: string;
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize: number;
  contentType: string;
  contentDisposition?: string;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const headers: Record<string, string> = {
    "Content-Type": params.contentType,
    "Content-Length": String(params.fileSize)
  };
  if (params.contentDisposition) {
    headers["Content-Disposition"] = params.contentDisposition;
  }

  const response = await fetch(params.uploadUrl, {
    method: "PUT",
    headers,
    body: params.fileBody as unknown as RequestInit["body"],
    // Required by undici when streaming a request body.
    duplex: "half",
    signal: params.signal
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Presigned PUT upload failed (${response.status}): ${text || response.statusText}`
    );
  }
  return { url: params.downloadUrl };
}
