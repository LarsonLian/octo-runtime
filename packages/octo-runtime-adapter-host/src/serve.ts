import { AdapterHost, type HostedAdapter } from "./index.js";
import { AdapterHostRpcServer } from "./rpc.js";
import { hostLog } from "./host-log.js";

/**
 * 在当前独立 Host 子进程中提供执行服务。调用方已经决定加载集合：
 * CLI 可从自己的 JSON 动态加载，SDK 可直接 import；这里不扫描或补齐任何 Adapter。
 * 该函数必须放在 Host 入口调用，不应在宿主 main 或 daemon 控制进程中调用。
 */
export function serveAdapterHost(adapters: readonly HostedAdapter[]): void {
  process.on("uncaughtExceptionMonitor", (error) =>
    hostLog("error", { message: error.message, stack: error.stack })
  );
  const host = new AdapterHost();
  for (const adapter of adapters) {
    // 注册阶段保留协议校验和重复类型检查，失败时不建立就绪的 RPC 服务。
    host.register(adapter);
    hostLog("lifecycle", {
      level: "info", scope: "adapter.registry", event: "adapter.registered",
      message: "adapter registered", adapterType: adapter.metadata.type,
      data: { agentSources: adapter.metadata.agentSources }
    });
  }

  // 仅服务已注册集合；daemon 仍通过首次 list 握手确认就绪。
  // 注册不代表 Provider 已安装或认证，实际可用性由 probe 和调用结果说明。
  new AdapterHostRpcServer({
    host, output: process.stdout,
    trace: (direction, frame) => hostLog(direction, frame)
  }).listen(process.stdin);
  hostLog("lifecycle", {
    level: "info", scope: "adapter-host.lifecycle", event: "adapter-host.ready",
    message: "adapter host ready", data: { adapters: host.list().map((adapter) => adapter.type) }
  });

  // 父进程断开或停止时等待 Host 取消和清理；重启由 daemon 重新启动同一个入口。
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void host.shutdown().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
}
