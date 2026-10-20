// Transitional transport entry point; execution has exactly one implementation.
export {
  AgentExecutor as AdapterHost,
  type HostedAdapter,
  type HostedAdapterMetadata,
  DEFAULT_RUNTIME_LIMITS,
  prepareRunContext,
  type PreparedRunContext,
  type WorkspaceAssignments
} from "@mininglamp-oss/octo-runtime-executor-core";
export { HostRunService } from "./host-run-service.js";
export { readAdapterConfigurations } from "./runtime-configuration.js";
export { startHostSocketServer, streamHostRun, type HostSocketRequest } from "./socket-server.js";
export { spawnAdapterHost } from "./process.js";
export { serveAdapterHost } from "./serve.js";
export type { AdapterHostProcess, SpawnAdapterHostOptions } from "./process.js";
export {
  AdapterHostRpcClient,
  AdapterHostRpcServer,
  type AdapterHostRpc,
  type RpcTrace,
  type RpcTraceDirection
} from "./rpc.js";
