import { startDaemonServer as startLocalDaemon, type StartDaemonServerOptions } from "@mininglamp-oss/octo-runtime-daemon";
import { createImModule as createGatewayModule } from "@mininglamp-oss/octo-runtime-extra-channel-gateway/daemon-module";
import { createImModule as createWecomModule } from "@mininglamp-oss/octo-runtime-extra-channel-wecom/daemon-module";
import type { ImBotConfig, ImCredentialSource } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import type { ImBotConfig as WecomBotConfig, ImCredentialSource as WecomCredentialSource } from "@mininglamp-oss/octo-runtime-extra-channel-wecom";

export * from "@mininglamp-oss/octo-runtime-daemon";
export interface StandardDaemonOptions extends StartDaemonServerOptions {
  imBots?: ImBotConfig[];
  imCredentials?: ImCredentialSource;
  wecomBots?: WecomBotConfig[];
  wecomCredentials?: WecomCredentialSource;
}

export function startDaemonServer(options: StandardDaemonOptions) {
  const { imBots = [], imCredentials, wecomBots = [], wecomCredentials, ...local } = options;
  return startLocalDaemon({
    ...local,
    modules: [
      ...(local.modules ?? []),
      ...(imBots.length ? [{ id: "channel-gateway", create: createGatewayModule, config: { bots: imBots, credentials: imCredentials } }] : []),
      ...(wecomBots.length ? [{ id: "channel-wecom", create: createWecomModule, config: { bots: wecomBots, credentials: wecomCredentials } }] : [])
    ]
  });
}
