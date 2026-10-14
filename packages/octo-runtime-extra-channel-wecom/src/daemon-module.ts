import type { DaemonModule, DaemonModuleContext } from "@mininglamp-oss/octo-runtime-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import { MemoryImSessionStore } from "./application/session-store.js";
import type { ImBotConfig } from "./contracts.js";
import type { ImCredentialSource } from "./ports.js";

export interface ImModuleConfig {
  bots?: ImBotConfig[];
  credentials?: ImCredentialSource;
}

export function createImModule(context: DaemonModuleContext, input: unknown): DaemonModule {
  const config = input as ImModuleConfig;
  if (
    !config ||
    typeof config !== "object" ||
    (config.bots !== undefined && !Array.isArray(config.bots))
  )
    throw new Error("IM_MODULE_CONFIG_INVALID");
  const sessions = new MemoryImSessionStore();
  const im = new ImChannelManager({
    host: context.host,
    sessions,
    ...(context.account
      ? {
          authorizeSpace: (spaceId: string) => {
            if (!context.account!.profiles.some((profile) => profile.tenantId === spaceId))
              throw new Error("IM_TENANT_NOT_ACTIVE");
          }
        }
      : {}),
    ...(config.credentials ? { credentials: config.credentials } : {})
  });
  let closed = false;
  const upsert = (bot: ImBotConfig) => {
    return im.upsert(bot);
  };
  return {
    get status() {
      return im.status;
    },
    async start() {
      for (const bot of config.bots ?? []) {
        context.signal.throwIfAborted();
        await upsert(bot);
      }
    },
    async handle(request) {
      if (closed) throw new Error("IM_MODULE_STOPPED");
      const params = request.params ?? {};
      switch (request.method) {
        case "status":
          return im.status;
        case "upsert":
          return upsert(params.config as ImBotConfig);
        case "remove":
          if (typeof params.connection_key !== "string" || !params.connection_key)
            throw new Error("IM_CONNECTION_KEY_REQUIRED");
          await im.remove(params.connection_key);
          return { removed: true };
        default:
          throw new Error("IM_MODULE_METHOD_NOT_FOUND");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await im.close();
      sessions.close();
    }
  };
}
