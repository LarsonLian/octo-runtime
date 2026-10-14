import {
  startDaemonServer as startLocalDaemon,
  type StartDaemonServerOptions
} from "@mininglamp-oss/octo-runtime-daemon";
import {
  createWorkerAccessModule,
  type AgentWorkRuntimeOptions
} from "@mininglamp-oss/octo-runtime-worker-access";
import { createImModule } from "@mininglamp-oss/octo-runtime-channel-im/daemon-module";
import type { ImBotConfig, ImCredentialSource } from "@mininglamp-oss/octo-runtime-channel-im";

export * from "@mininglamp-oss/octo-runtime-daemon";
export * from "@mininglamp-oss/octo-runtime-worker-access";

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
        root: runtime.root,
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
