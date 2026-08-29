import { createJsonCliAdapter, probeCommand, type CanonicalEvent, type InvokeRequest } from "@orbtex-ai/adapter-sdk";
import { parse, stringify } from "smol-toml";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

interface CodexNativeEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    id?: string;
    text?: string;
    command?: unknown;
    status?: string;
    aggregated_output?: unknown;
    output?: unknown;
  };
  error?: { message?: string };
  usage?: Record<string, unknown>;
}

async function readOptional(file: string): Promise<string> { try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; } }
async function linkOptional(source: string, target: string, type: Parameters<typeof symlink>[2]): Promise<void> { try { await symlink(source, target, type); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

export async function createCodexInvocationHome(instructions: string, env: NodeJS.ProcessEnv = process.env): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const real = env.CODEX_HOME || join(homedir(), ".codex");
  const shadow = await mkdtemp(join(tmpdir(), "orbtex-codex-"));
  // 临时 CODEX_HOME 只覆盖本次 developer instructions；认证和 session 仍复用真实目录。
  const configText = await readOptional(join(real, "config.toml"));
  const config = configText ? parse(configText) : {};
  config.developer_instructions = instructions;
  await writeFile(join(shadow, "config.toml"), stringify(config), { mode: 0o600 });
  await mkdir(join(real, "sessions"), { recursive: true });
  await Promise.all([
    linkOptional(join(real, "auth.json"), join(shadow, "auth.json"), "file"),
    linkOptional(join(real, "sessions"), join(shadow, "sessions"), "dir"),
    linkOptional(join(real, "skills"), join(shadow, "skills"), "dir"),
    linkOptional(join(real, "rules"), join(shadow, "rules"), "dir")
  ]);
  return { home: shadow, cleanup: () => rm(shadow, { recursive: true, force: true }) };
}

export async function buildCodexCommand(req: InvokeRequest, command = "codex") {
  const privateHome = await createCodexInvocationHome(req.appendInstructions);
  const common = ["--json", "--skip-git-repo-check"];
  if (req.agentConfig?.model) common.push("--model", req.agentConfig.model);
  if (req.agentConfig?.dangerouslyBypassPermissions) common.push("--dangerously-bypass-approvals-and-sandbox");
  else if (!req.providerSession?.sessionId) common.push("--sandbox", req.agentConfig?.sandbox ?? "workspace-write");
  const args = req.providerSession?.sessionId
    ? ["exec", "resume", req.providerSession.sessionId, ...common, "-"]
    : ["exec", ...common, "-"];
  return { command, args, input: req.prompt, env: { CODEX_HOME: privateHome.home }, cleanup: privateHome.cleanup };
}

export function normalizeCodexEvent(native: CodexNativeEvent): CanonicalEvent[] {
  if (native.type === "thread.started" && native.thread_id) return [{ type: "session.update", payload: { providerSession: { sessionId: native.thread_id, resumable: true } } }];
  if (native.type === "item.completed" && native.item?.type === "agent_message") return [{ type: "message.delta", payload: { text: native.item.text ?? "" } }];
  if (native.type === "item.started" && native.item?.type && native.item.type !== "agent_message") return [{ type: "tool_call.create", payload: { id: native.item.id, name: native.item.type, args: native.item.command ? { command: native.item.command } : {} } }];
  if (native.type === "item.completed" && native.item?.type && native.item.type !== "agent_message") return [{ type: "tool_call.update", payload: { id: native.item.id, status: native.item.status ?? "completed", output: native.item.aggregated_output ?? native.item.output } }];
  if (native.type === "turn.failed") return [{ type: "message.update", payload: { role: "assistant", status: "failed" } }, { type: "run.error", payload: { message: native.error?.message ?? "Codex turn failed" } }];
  if (native.type === "turn.completed") return [
    { type: "usage.update", payload: native.usage ?? {} },
    { type: "message.update", payload: { role: "assistant", status: "completed" } },
    { type: "run.finished", payload: {} }
  ];
  return [];
}

export function createCodexAdapter({ command = "codex" }: { command?: string } = {}) {
  return createJsonCliAdapter<CodexNativeEvent>({
    metadata: { type: "codex", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command),
    buildCommand: req => buildCodexCommand(req, command), normalize: normalizeCodexEvent
  });
}

export const codexAdapter = createCodexAdapter();
export default codexAdapter;
