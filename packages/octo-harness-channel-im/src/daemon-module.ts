import { join } from "node:path";
import type { DaemonModule, DaemonModuleContext } from "@mininglamp-oss/octo-harness-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import { SqliteImSessionStore } from "./application/session-store.js";
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
  const sessions = new SqliteImSessionStore(join(context.homePath, "im-sessions.db"));
  const im = new ImChannelManager({
    host: context.host,
    sessions,
    ...(config.credentials ? { credentials: config.credentials } : {})
  });
  let closed = false;
  const upsert = (bot: ImBotConfig) => {
    if (
      context.account &&
      bot?.type === "octo" &&
      !context.account.profiles.some((profile) => profile.tenantId === bot.spaceId)
    )
      throw new Error("TENANT_NOT_ACTIVE");
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
          if (typeof params.id !== "string" || !params.id) throw new Error("IM_ID_REQUIRED");
          await im.remove(params.id);
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
