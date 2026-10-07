import { createHash } from "node:crypto";
import type { InvokeRequestWire, ModelInputPart } from "./generated/protocol-types.js";

export const IMAGE_INPUT_LIMITS = Object.freeze({ maxCount: 4, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });
export const IMAGE_INPUT_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"] as const);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("INPUT_PART_INVALID");
  return value as Record<string, unknown>;
}

export function assertModelInputParts(value: unknown): asserts value is ModelInputPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new TypeError("INPUT_PARTS_INVALID");
  let count = 0;
  let total = 0;
  const ids = new Set<string>();
  for (const item of value) {
    const part = record(item);
    if (part.id !== undefined && (typeof part.id !== "string" || !part.id)) throw new TypeError("INPUT_PART_INVALID");
    if (typeof part.id === "string") {
      if (ids.has(part.id)) throw new TypeError("INPUT_PART_INVALID");
      ids.add(part.id);
    }
    const allowed = part.type === "text" ? ["id", "type", "text"] : ["id", "type", "mimeType", "data", "byteSize", "sha256"];
    if (Object.keys(part).some(key => !allowed.includes(key))) throw new TypeError("INPUT_PART_INVALID");
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new TypeError("INPUT_PART_INVALID");
      continue;
    }
    if (part.type !== "image") throw new TypeError("UNSUPPORTED_INPUT_MODALITY");
    if (!(IMAGE_INPUT_MIME_TYPES as readonly unknown[]).includes(part.mimeType)) throw new TypeError("UNSUPPORTED_INPUT_MODALITY");
    if (!Number.isSafeInteger(part.byteSize) || Number(part.byteSize) < 1 || Number(part.byteSize) > IMAGE_INPUT_LIMITS.maxBytes
      || typeof part.data !== "string" || part.data.length > Math.ceil(IMAGE_INPUT_LIMITS.maxBytes / 3) * 4) throw new TypeError("IMAGE_LIMIT_EXCEEDED");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) throw new TypeError("ARTIFACT_INTEGRITY_MISMATCH");
    const bytes = Buffer.from(part.data, "base64");
    if (bytes.length !== part.byteSize || bytes.toString("base64") !== part.data
      || typeof part.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(part.sha256)
      || createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new TypeError("ARTIFACT_INTEGRITY_MISMATCH");
    const validHeader = part.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : part.mimeType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!validHeader) throw new TypeError("ARTIFACT_INTEGRITY_MISMATCH");
    count += 1;
    total += bytes.length;
    if (count > IMAGE_INPUT_LIMITS.maxCount || total > IMAGE_INPUT_LIMITS.maxTotalBytes) throw new TypeError("IMAGE_LIMIT_EXCEEDED");
  }
}

/** Never fall back to the display string when an invocation contains images. */
export function providerInputParts(request: InvokeRequestWire, freshFallback = false): ModelInputPart[] {
  if (freshFallback && request.freshFallbackImagesUnavailable) throw new TypeError("ARTIFACT_UNAVAILABLE: historical images cannot be restored");
  assertImageRecoveryParts(request);
  const parts = freshFallback ? request.freshFallbackModelInputParts ?? request.modelInputParts : request.modelInputParts;
  if (parts) {
    assertModelInputParts(parts);
    return structuredClone(parts);
  }
  return [{ type: "text", text: freshFallback ? request.freshFallbackModelInput ?? request.modelInput : request.modelInput }];
}

/** Current-turn images must survive recovery, even when historical images are prepended. */
export function assertImageRecoveryParts(request: Pick<InvokeRequestWire, "modelInputParts" | "freshFallbackModelInputParts" | "freshFallbackModelInput">): void {
  const current = request.modelInputParts?.filter(part => part.type === "image") ?? [];
  if (!current.length) return;
  if (request.freshFallbackModelInput !== undefined && request.freshFallbackModelInputParts === undefined) throw new TypeError("IMAGE_RECOVERY_INPUT_REQUIRED");
  if (request.freshFallbackModelInputParts === undefined) return;
  const recovery = request.freshFallbackModelInputParts.filter(part => part.type === "image");
  const key = (part: Extract<ModelInputPart, { type: "image" }>): string => part.id ?? `${part.mimeType}:${part.byteSize}:${part.sha256}`;
  for (const part of current) {
    if (current.filter(item => key(item) === key(part)).length !== recovery.filter(item => key(item) === key(part)).length) throw new TypeError("IMAGE_RECOVERY_INPUT_REQUIRED");
  }
  let index = 0;
  for (const part of recovery) {
    const expected = current[index];
    if (expected && expected.sha256 === part.sha256 && expected.byteSize === part.byteSize && expected.mimeType === part.mimeType && (expected.id === undefined || expected.id === part.id)) index += 1;
  }
  if (index !== current.length) throw new TypeError("IMAGE_RECOVERY_INPUT_REQUIRED");
}

export function hasImageInput(request: Pick<InvokeRequestWire, "modelInputParts" | "freshFallbackModelInputParts">): boolean {
  return [...request.modelInputParts ?? [], ...request.freshFallbackModelInputParts ?? []].some(part => part.type === "image");
}

/** Artifact sources must already have been fetched under the Run's authorization. */
export function modelPartsFromInput(input: Record<string, unknown>, prefix = ""): ModelInputPart[] | undefined {
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (!parts.some(part => part && typeof part === "object" && (part as Record<string, unknown>).type === "image")) return undefined;
  const output: ModelInputPart[] = prefix ? [{ type: "text", text: prefix }] : [];
  for (const value of parts) {
    const part = record(value);
    const id = typeof part.id === "string" ? { id: part.id } : {};
    if (part.type === "text") {
      if (typeof part.text !== "string") throw new TypeError("INPUT_PART_INVALID");
      output.push({ type: "text", text: part.text, ...id });
    } else if (part.type === "image") {
      if (!part.source) throw new TypeError("ARTIFACT_UNAVAILABLE");
      const source = record(part.source);
      if (Object.keys(source).some(key => !["mimeType", "data", "byteSize", "sha256"].includes(key))) throw new TypeError("INPUT_PART_INVALID");
      const image = { ...source, type: "image", ...id };
      assertModelInputParts([image]);
      if (part.artifact !== undefined) {
        const artifact = record(part.artifact);
        if (artifact.mediaType !== source.mimeType || artifact.byteSize !== source.byteSize || artifact.sha256 !== source.sha256) throw new TypeError("ARTIFACT_INTEGRITY_MISMATCH");
      }
      output.push(image as ModelInputPart);
    } else {
      throw new TypeError("UNSUPPORTED_INPUT_MODALITY");
    }
  }
  assertModelInputParts(output);
  return output;
}
