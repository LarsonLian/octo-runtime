import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResolvedExecutionPlan } from "@mininglamp-oss/octo-harness-protocol";
import { TaskMcpClient, taskMcpServer } from "./task-materials.js";

export const TASK_OUTPUT_SCHEMA = "octo.task-output-manifest/v1";
export const TASK_OUTPUT_LIMITS = Object.freeze({ maxFiles: 32, maxFileBytes: 128 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxManifestBytes: 64 * 1024 });

export interface TaskOutputManifestEntry {
  output_id: string;
  relative_path: string;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  role: "output";
}

export interface TaskOutputReceipt {
  output_id: string;
  status: "saved" | "failed";
  attachment_id?: string;
  file_id?: string;
  file_version_id?: string;
  error_code?: string;
}

export function taskOutputManifestPath(runId: string): string {
  return `.octo/task-outputs/${encodeURIComponent(runId)}.json`;
}

export function taskOutputInstructions(runId: string): string {
  return [
    "Task output files must be saved through the Runtime uploader before being described as saved to the shared drive.",
    `When this Run produces deliverable files, write ${taskOutputManifestPath(runId)} under the frozen workdir before finishing.`,
    `Use JSON ${JSON.stringify({ schema: TASK_OUTPUT_SCHEMA, outputs: [{ output_id: "unique-stable-id", relative_path: "path/from/workdir", name: "filename", media_type: "text/html", size: 123, sha256: "64 lowercase hex characters", role: "output" }] })}.`,
    "Compute size and SHA-256 from the actual files. Use a new output_id for changed contents. Only include deliverables you intend to share; exclude credentials and unrelated project files.",
    "Do not send absolute local paths or run capability credentials through Team handoff. Use attachment_id and file_version_id after saving. Run success does not complete the business task."
  ].join("\n");
}

export function assertTaskOutputManifest(value: unknown): asserts value is { schema: typeof TASK_OUTPUT_SCHEMA; outputs: TaskOutputManifestEntry[] } {
  const manifest = object(value);
  if (manifest.schema !== TASK_OUTPUT_SCHEMA || Object.keys(manifest).some(key => !["schema", "outputs"].includes(key))
    || !Array.isArray(manifest.outputs) || manifest.outputs.length > TASK_OUTPUT_LIMITS.maxFiles) throw new TypeError("TASK_OUTPUT_MANIFEST_INVALID");
  const ids = new Set<string>();
  let total = 0;
  for (const raw of manifest.outputs) {
    const entry = object(raw);
    if (Object.keys(entry).some(key => !["output_id", "relative_path", "name", "media_type", "size", "sha256", "role"].includes(key))
      || typeof entry.output_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.output_id) || ids.has(entry.output_id)
      || typeof entry.name !== "string" || !entry.name || entry.name.length > 255 || hasControl(entry.name) || /[/\\]/.test(entry.name)
      || typeof entry.media_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(entry.media_type)
      || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > TASK_OUTPUT_LIMITS.maxFileBytes
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.role !== "output") throw new TypeError("TASK_OUTPUT_MANIFEST_INVALID");
    assertRelativePath(entry.relative_path);
    ids.add(entry.output_id);
    total += Number(entry.size);
  }
  if (total > TASK_OUTPUT_LIMITS.maxTotalBytes) throw new TypeError("TASK_OUTPUT_SIZE_EXCEEDED");
}

/** Reject symlinks throughout the path, then check the open file identity before using its bytes. */
export async function readTaskOutput(workdir: string, path: string, maxBytes: number): Promise<Buffer> {
  assertRelativePath(path);
  if (!isAbsolute(workdir)) throw new TypeError("TASK_OUTPUT_WORKDIR_INVALID");
  const root = await realpath(workdir);
  let cursor = root;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new TypeError("TASK_OUTPUT_SYMLINK_REJECTED");
  }
  const full = resolve(root, path);
  const resolved = await realpath(full);
  if (!contained(root, resolved)) throw new TypeError("TASK_OUTPUT_PATH_INVALID");
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const current = await lstat(full);
    if (!info.isFile() || !current.isFile() || info.dev !== current.dev || info.ino !== current.ino || !contained(root, await realpath(full))) {
      throw new TypeError("TASK_OUTPUT_PATH_INVALID");
    }
    if (info.size > maxBytes) throw new TypeError("TASK_OUTPUT_SIZE_EXCEEDED");
    // A growing file must not bypass the initial stat bound.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError("TASK_OUTPUT_READ_FAILED");
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) throw new TypeError("TASK_OUTPUT_SIZE_EXCEEDED");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

export async function loadTaskOutputs(workdir: string, runId: string): Promise<TaskOutputManifestEntry[]> {
  let bytes: Buffer;
  try { bytes = await readTaskOutput(workdir, taskOutputManifestPath(runId), TASK_OUTPUT_LIMITS.maxManifestBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let manifest: unknown;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new TypeError("TASK_OUTPUT_MANIFEST_INVALID"); }
  assertTaskOutputManifest(manifest);
  return manifest.outputs;
}

export async function archiveTaskOutputs(plan: ResolvedExecutionPlan, taskId: string, runId: string, signal: AbortSignal): Promise<TaskOutputReceipt[]> {
  const outputs = await loadTaskOutputs(plan.workdir, runId);
  if (outputs.length === 0) return [];
  const client = new TaskMcpClient(taskMcpServer(plan), signal);
  await client.initialize();
  const receipts: TaskOutputReceipt[] = [];
  for (const output of outputs) {
    try {
      const bytes = await readTaskOutput(plan.workdir, output.relative_path, TASK_OUTPUT_LIMITS.maxFileBytes);
      if (bytes.length !== output.size || createHash("sha256").update(bytes).digest("hex") !== output.sha256) throw new TypeError("TASK_OUTPUT_INTEGRITY_MISMATCH");
      const ticket = await client.call("task_prepare_output", { task_id: taskId, manifest: output });
      if (ticket.status === "saved") {
        receipts.push(savedReceipt(output.output_id, ticket));
        continue;
      }
      if (typeof ticket.ticket_id !== "string" || !ticket.ticket_id || typeof ticket.upload_url !== "string" || ticket.upload_method !== "PUT") throw new TypeError("TASK_OUTPUT_TICKET_INVALID");
      const url = new URL(ticket.upload_url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError("TASK_OUTPUT_TICKET_INVALID");
      const headers = ticket.upload_headers === undefined ? {} : object(ticket.upload_headers);
      if (Object.values(headers).some(value => typeof value !== "string")) throw new TypeError("TASK_OUTPUT_TICKET_INVALID");
      const response = await fetch(url, {
        method: "PUT", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        headers: headers as Record<string, string>, body: new Uint8Array(bytes)
      });
      await response.body?.cancel();
      if (!response.ok) throw new TypeError("TASK_OUTPUT_UPLOAD_FAILED");
      const saved = await client.call("task_commit_output", { task_id: taskId, ticket_id: ticket.ticket_id, manifest: output });
      receipts.push(savedReceipt(output.output_id, saved));
    } catch (error) {
      if (signal.aborted) throw error;
      receipts.push({ output_id: output.output_id, status: "failed", error_code: safeOutputError(error) });
    }
  }
  return receipts;
}

export function safeOutputError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^TASK_[A-Z_]+$/.test(message) ? message : "TASK_OUTPUT_SAVE_FAILED";
}

function savedReceipt(id: string, value: Record<string, unknown>): TaskOutputReceipt {
  if (value.status !== "saved" || ![value.attachment_id, value.file_id, value.file_version_id].every(item => typeof item === "string" && item)) throw new TypeError("TASK_OUTPUT_CONFIRMATION_INVALID");
  return { output_id: id, status: "saved", attachment_id: String(value.attachment_id), file_id: String(value.file_id), file_version_id: String(value.file_version_id) };
}

function assertRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value) || hasControl(value) || /\\/.test(value)
    || /^[A-Za-z]:/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) throw new TypeError("TASK_OUTPUT_PATH_INVALID");
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function hasControl(value: string): boolean { return Array.from(value).some(char => char.charCodeAt(0) < 32); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("TASK_OUTPUT_MANIFEST_INVALID");
  return value as Record<string, unknown>;
}
