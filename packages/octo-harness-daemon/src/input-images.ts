import { IMAGE_INPUT_LIMITS, modelPartsFromInput } from "@mininglamp-oss/octo-harness-protocol";

export interface RuntimeImageReadOptions {
  baseUrl: string;
  headers: Record<string, string>;
  runKey: string;
  leaseId: string;
  fencingToken: number;
  signal: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ARTIFACT_UNAVAILABLE");
  return value as Record<string, unknown>;
}

/** Keep durable envelopes as references; image bytes live only in the invocation. */
export async function resolveRuntimeInputImages(input: Record<string, unknown>, options: RuntimeImageReadOptions): Promise<Record<string, unknown>> {
  if (!Array.isArray(input.parts)) return input;
  const images = input.parts.filter(value => value && typeof value === "object" && (value as Record<string, unknown>).type === "image");
  if (!images.length) return input;
  if (images.length > IMAGE_INPUT_LIMITS.maxCount) throw new TypeError("IMAGE_LIMIT_EXCEEDED");
  const output = structuredClone(input);
  const parts = output.parts as unknown[];
  for (const value of parts) {
    const part = record(value);
    if (part.type !== "image") continue;
    const artifact = record(part.artifact);
    if (typeof artifact.artifact_key !== "string" || !artifact.artifact_key) throw new TypeError("ARTIFACT_UNAVAILABLE");
    if (!Number.isSafeInteger(artifact.byteSize) || Number(artifact.byteSize) < 1 || Number(artifact.byteSize) > IMAGE_INPUT_LIMITS.maxBytes) throw new TypeError("IMAGE_LIMIT_EXCEEDED");
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/v1/runtime/input_artifact/read`, {
      method: "POST", headers: options.headers,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
      redirect: "error",
      body: JSON.stringify({ run_key: options.runKey, artifact_key: artifact.artifact_key, lease_id: options.leaseId, fencing_token: options.fencingToken })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 403 ? "ARTIFACT_ACCESS_DENIED" : "ARTIFACT_UNAVAILABLE");
    }
    // Enforce the body bound while streaming, even without Content-Length.
    const maxResponseBytes = Math.ceil(IMAGE_INPUT_LIMITS.maxBytes / 3) * 4 + 16_384;
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("ARTIFACT_UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new TypeError("ARTIFACT_UNAVAILABLE");
        size += chunk.length;
        if (size > maxResponseBytes) throw new TypeError("IMAGE_LIMIT_EXCEEDED");
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const data = record(body.data);
    const resolved = record(data.artifact);
    if (resolved.artifact_key !== artifact.artifact_key || resolved.mediaType !== artifact.mediaType || resolved.byteSize !== artifact.byteSize || resolved.sha256 !== artifact.sha256) throw new TypeError("ARTIFACT_INTEGRITY_MISMATCH");
    part.source = record(data.source);
  }
  modelPartsFromInput(output);
  return output;
}
