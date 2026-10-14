export { NodeDaemonRuntime } from "./daemon-runtime.js";
export { prepareRunContext } from "@mininglamp-oss/octo-harness-adapter-host";
export { DaemonRuntimeError } from "./errors.js";
export { DAEMON_RUNTIME_VERSION } from "./version.js";
export { accountKeyFor, daemonHomePaths, profileNameFor, resolveDaemonHome } from "./home.js";
export type {
  AccountSubject,
  AuthorizedTenant,
  DaemonDistribution,
  DaemonRuntime,
  DaemonRuntimeOptions,
  DaemonHealth,
  DaemonPhase,
  DaemonProblem,
  DaemonModuleDescriptor,
  ProfileHealth,
  StartAccountOptions
} from "./types.js";

import { NodeDaemonRuntime } from "./daemon-runtime.js";
import type { DaemonRuntime, DaemonRuntimeOptions } from "./types.js";

export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  return new NodeDaemonRuntime(options);
}
