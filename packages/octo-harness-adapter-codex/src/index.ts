/**
 * Codex adapter 的装配入口。
 *
 * 这个文件只处理“如何准备一次 invocation”：构造隔离的 CODEX_HOME、声明
 * adapter metadata，并把执行委托给 app-server transport。JSON-RPC 状态机、
 * 原生事件解析和子进程生命周期集中在 app-server.ts，避免入口层同时承担协议逻辑。
 */
import { defineAdapter, probeCommand, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { parse, stringify } from "smol-toml";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexAppServerArgs,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerSpawn
} from "./app-server.js";

export {
  buildCodexAppServerArgs,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  normalizeCodexEvent,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerNotification,
  type CodexAppServerSpawn
} from "./app-server.js";

/** 读取可选资源；只忽略“不存在”，权限和 I/O 错误必须暴露给调用方。 */
async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * 把真实 CODEX_HOME 中存在的资源链接进临时目录。
 *
 * 只容忍源文件不存在；EACCES、目标冲突等错误不能静默吞掉，否则会得到一个看似
 * 可启动、实际缺少认证或会话状态的 Codex 进程。
 */
async function linkOptional(
  source: string,
  target: string,
  type: Parameters<typeof symlink>[2]
): Promise<void> {
  try {
    await symlink(source, target, type);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * 为单次 invocation 构造 shadow CODEX_HOME。
 *
 * 设计目标：
 * 1. harness instructions 只影响本轮，不改写用户真实 config.toml；
 * 2. 认证、session rollout、skills 和 rules 仍由真实 HOME 提供；
 * 3. 无论正常、失败还是取消，调用方都能通过 cleanup 删除临时目录。
 *
 * 当前实现是配置覆盖层，不是文件系统或安全隔离：symlink 对真实资源是 live alias，
 * Codex 对这些路径的写入会落到真实 HOME。它也不等价于 Aily 的 per-session state
 * 镜像：state SQLite、hooks、MCP bridge 和 skill allowlist 尚未复制，具体边界见 README。
 */
export async function createCodexInvocationHome(
  instructions: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const real = env.CODEX_HOME || join(homedir(), ".codex");
  const shadow = await mkdtemp(join(tmpdir(), "octo-harness-codex-"));

  // 复制配置后只覆盖 private developer instructions，真实 config.toml 保持只读。
  const configText = await readOptional(join(real, "config.toml"));
  const config = configText ? parse(configText) : {};
  config.developer_instructions = instructions;
  await writeFile(join(shadow, "config.toml"), stringify(config), { mode: 0o600 });

  // sessions 需要稳定真实路径，才能让 thread/resume 找到上一轮 rollout。
  await mkdir(join(real, "sessions"), { recursive: true });
  await Promise.all([
    linkOptional(join(real, "auth.json"), join(shadow, "auth.json"), "file"),
    linkOptional(join(real, "sessions"), join(shadow, "sessions"), "dir"),
    linkOptional(join(real, "skills"), join(shadow, "skills"), "dir"),
    linkOptional(join(real, "rules"), join(shadow, "rules"), "dir")
  ]);
  return { home: shadow, cleanup: () => rm(shadow, { recursive: true, force: true }) };
}

/**
 * 把 Octo Harness InvokeRequest 转换为可启动的 app-server 进程规格。
 *
 * 用户 prompt 不会出现在 argv；它稍后通过 turn/start 写入 stdin。这里把父进程环境
 * 完整继承后仅替换 CODEX_HOME，使 PATH、provider token 等运行配置仍然可用。
 */
export async function buildCodexCommand(
  req: InvokeRequest,
  command = "codex",
  appServerArgs = buildCodexAppServerArgs()
): Promise<CodexAppServerCommand> {
  const privateHome = await createCodexInvocationHome(req.appendInstructions);
  return {
    command,
    args: [...appServerArgs],
    cwd: req.workdir,
    env: { ...process.env, CODEX_HOME: privateHome.home },
    cleanup: privateHome.cleanup
  };
}

/**
 * 创建 Codex adapter。
 *
 * command/appServerArgs/spawnFn 都可注入，主要用于测试真实 stdin/stdout JSON-RPC，
 * 而不需要在测试环境连接真实 Codex 服务。生产默认值固定走
 * `codex app-server --listen stdio://`。
 */
export function createCodexAdapter({
  command = "codex",
  appServerArgs = buildCodexAppServerArgs(),
  spawnFn
}: {
  command?: string;
  appServerArgs?: string[];
  spawnFn?: CodexAppServerSpawn;
} = {}) {
  return defineAdapter({
    metadata: {
      type: "codex",
      // Thread serialization and same-turn fresh fallback are end-to-end supported.
      capabilities: ["session.serialize", "session.resume_recovery"],
      processModel: "subprocess-per-invocation",
      transport: "json-rpc-2.0/stdio"
    },
    probe: () => probeCommand(command),
    async *invoke(request: InvokeRequest) {
      // spec.cleanup 由 runCodexAppServerTurn 的 finally 统一调用。
      const spec = await buildCodexCommand(request, command, appServerArgs);
      yield* runCodexAppServerTurn({ request, spec, ...(spawnFn ? { spawnFn } : {}) });
    }
  });
}

export const codexAdapter = createCodexAdapter();
export default codexAdapter;
