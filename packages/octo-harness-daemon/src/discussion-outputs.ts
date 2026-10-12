import type { ResolvedExecutionPlan } from "@mininglamp-oss/octo-harness-protocol";
import { TaskMcpClient } from "./task-materials.js";
import { archiveOutputEntries, assertTaskOutputManifest, readTaskOutput, TASK_OUTPUT_LIMITS, TASK_OUTPUT_SCHEMA, type TaskOutputReceipt } from "./task-outputs.js";

export const DISCUSSION_OUTPUT_SCHEMA = "octo.discussion-output-manifest/v1";
export function discussionOutputManifestPath(runId: string): string { return `.octo/discussion-outputs/${encodeURIComponent(runId)}.json`; }

/** 只共享显式声明的交付文件；纯文本结果不要求文件清单或 MCP 调用。 */
export function discussionOutputInstructions(runId: string): string {
  return [
    "本次为协作空间 Discussion 执行。最终文本会共享给空间成员，工具过程只对发起人可见。",
    "如产生需要共享的文件，必须在结束前写入以下交付清单；未声明的本地文件不会发布。纯文本无需清单。",
    `清单路径（相对冻结工作目录）：${discussionOutputManifestPath(runId)}`,
    `格式：${JSON.stringify({ schema: DISCUSSION_OUTPUT_SCHEMA, outputs: [{ output_id: "stable-output-id", relative_path: "deliverable.txt", name: "deliverable.txt", media_type: "text/plain", size: 123, sha256: "64 lowercase hex characters", role: "output" }] })}`,
    "size、sha256 必须来自真实文件。只包含本次允许共享的交付物，不包含凭据或其他私有文件。Runtime 会验证并上传至当前协作空间，保存失败则不会宣称共享成功。"
  ].join("\n");
}

export async function archiveDiscussionOutputs(plan: ResolvedExecutionPlan, runId: string, signal: AbortSignal): Promise<TaskOutputReceipt[]> {
  let bytes: Buffer;
  try { bytes = await readTaskOutput(plan.workdir, discussionOutputManifestPath(runId), TASK_OUTPUT_LIMITS.maxManifestBytes); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new TypeError("DISCUSSION_OUTPUT_MANIFEST_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("DISCUSSION_OUTPUT_MANIFEST_INVALID");
  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== DISCUSSION_OUTPUT_SCHEMA || Object.keys(manifest).some(key => !["schema", "outputs"].includes(key))) throw new TypeError("DISCUSSION_OUTPUT_MANIFEST_INVALID");
  const validated = { ...manifest, schema: TASK_OUTPUT_SCHEMA };
  assertTaskOutputManifest(validated);
  if (validated.outputs.length === 0) return [];
  // 资源安装时使用 p_<installation>_ 名称隔离；只接受唯一准备好的 Discussion 组件。
  const candidates = Object.entries(plan.mcp_servers ?? {}).filter(([name]) => name === "octo_discussion" || /^p_[a-f0-9]{12}_octo_discussion$/.test(name));
  const server = candidates.length === 1 ? candidates[0]?.[1] : undefined;
  if (!server || server.type !== "streamable_http") throw new TypeError("DISCUSSION_OUTPUT_PLUGIN_REQUIRED");
  return archiveOutputEntries(plan.workdir, validated.outputs, new TaskMcpClient(server, signal), "discussion", {}, signal);
}
