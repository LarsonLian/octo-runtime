import {
  startDaemonServer as startLocalDaemon,
  type StartDaemonServerOptions
} from "@mininglamp-oss/octo-harness-daemon";
import {
  createWorkerAccessModule,
  type AgentWorkRuntimeOptions
} from "@mininglamp-oss/octo-harness-worker-access";
import { createImModule } from "@mininglamp-oss/octo-harness-channel-im/daemon-module";
import type { ImBotConfig, ImCredentialSource } from "@mininglamp-oss/octo-harness-channel-im";
import { dirname } from "node:path";

export * from "@mininglamp-oss/octo-harness-daemon";
export * from "@mininglamp-oss/octo-harness-worker-access";

export interface StandardDaemonOptions extends StartDaemonServerOptions {
  agentWorks?: AgentWorkRuntimeOptions[];
  imBots?: ImBotConfig[];
  imCredentials?: ImCredentialSource;
}

export function startDaemonServer(options: StandardDaemonOptions) {
  const { agentWorks = [], imBots = [], imCredentials, ...local } = options;
  return startLocalDaemon({
    ...local,
    localRuntimes:
      local.localRuntimes ??
      agentWorks.map((runtime) => ({
        profile: runtime.profile,
        runtimeId: runtime.runtimeId,
        root: dirname(runtime.storePath),
        adapterConfigurations: runtime.adapterConfigurations
      })),
    modules: [
      ...(local.modules ?? []),
      ...(agentWorks.length
        ? [
            {
              id: "worker-access",
              create: createWorkerAccessModule,
              config: { runtimes: agentWorks }
            }
          ]
        : []),
      ...(imBots.length
        ? [
            {
              id: "channel-im",
              create: createImModule,
              config: { bots: imBots, credentials: imCredentials }
            }
          ]
        : [])
    ]
  });
}
