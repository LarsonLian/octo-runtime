import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  assertResolvedExecutionPlan,
  type ResolvedExecutionPlan
} from "@mininglamp-oss/octo-runtime-protocol";
export interface WorkspaceAssignments {
  conversationWorkspace(key: string, candidate: string): { path: string; created: boolean };
}

export interface WorkspacePreparationReceipt {
  workspace_mode: "fixed" | "random" | "none";
  workspace_path: string;
  provider_state_dir: string;
  warnings: string[];
}

export interface PreparedRunContext {
  workdir: string;
  providerStateDir: string;
  receipt: WorkspacePreparationReceipt;
}

/**
 * 按冻结计划准备实际工作区、Provider 状态目录。
 * random 在 Agent Session 首次运行时创建工作区，后续运行复用；已分配目录丢失时拒绝续接。
 * 返回的路径属于 Runtime 私有视图；本地准备完成不表示 Worker 已确认或 Provider 已应用。
 */
export async function prepareRunContext(
  plan: ResolvedExecutionPlan,
  options: {
    stateRoot: string;
    agentSessionId: string;
    agentId: string;
    store: WorkspaceAssignments;
    signal?: AbortSignal;
    registerCleanup?: (path: string) => void;
    workspaceRoot?: string;
    workspace?: boolean;
  }
): Promise<PreparedRunContext> {
  assertResolvedExecutionPlan(plan);
  options.signal?.throwIfAborted();
  if (options.workspace === false) {
    return {
      workdir: plan.workdir,
      providerStateDir: "",
      receipt: {
        workspace_mode: "none",
        workspace_path: "",
        provider_state_dir: "",
        warnings:
          plan.workspace?.mode === "none" || (!plan.workspace && !plan.workdir)
            ? []
            : ["CONTEXT_WORKSPACE_IGNORED"]
      }
    };
  }
  const stateRoot = await privateDirectory(options.stateRoot);
  const workspace =
    plan.workspace ??
    (plan.agent_source === "preset" && !plan.workdir
      ? { mode: "none" as const }
      : { mode: "fixed" as const, path: plan.workdir });
  let workdir: string;
  if (workspace.mode === "none") {
    if (plan.agent_source !== "preset" || plan.workdir)
      throw new TypeError("CONTEXT_WORKSPACE_INVALID");
    return {
      workdir: "",
      providerStateDir: "",
      receipt: { workspace_mode: "none", workspace_path: "", provider_state_dir: "", warnings: [] }
    };
  }
  if (workspace.mode === "random") {
    const workspaces = await privateDirectory(options.workspaceRoot ?? join(homedir(), "OctoWork"));
    const proposed = join(workspaces, `agent-${randomUUID()}`, "workdir");
    const chosen = options.store.conversationWorkspace(options.agentSessionId, proposed);
    if (chosen.created) {
      await privateDirectory(dirname(chosen.path));
      await mkdir(chosen.path, { mode: 0o700 });
    }
    // 续接必须保留原工作区事实；目录丢失时失败，不能静默创建同路径的空目录。
    workdir = await realDirectory(chosen.path);
    // Previously allocated session directories remain valid; never relocate a live session.
    const legacyRoot = join(stateRoot, "workspaces");
    inside(workdir.startsWith(legacyRoot + sep) ? legacyRoot : workspaces, workdir);
  } else {
    if (!isAbsolute(workspace.path)) throw new TypeError("CONTEXT_WORKSPACE_INVALID");
    await realDirectory(workspace.path);
    // 保留请求中的固定路径写法，以便 Worker 按冻结合同比较。
    workdir = workspace.path;
  }
  const scope = createHash("sha256").update(options.agentSessionId).digest("hex");
  const providerStateDir = await privateDirectory(join(stateRoot, "providers", scope));
  const prepared: PreparedRunContext = {
    workdir,
    providerStateDir,
    receipt: {
      workspace_mode: workspace.mode,
      workspace_path: workdir,
      provider_state_dir: providerStateDir,
      warnings: []
    }
  };
  options.signal?.throwIfAborted();
  return prepared;
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realDirectory(path);
}
async function realDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("CONTEXT_DIRECTORY_UNAVAILABLE");
  return realpath(path);
}
function inside(root: string, path: string): void {
  const part = relative(root, path);
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part))
    throw new TypeError("CONTEXT_PACKAGE_PATH_ESCAPE");
}
