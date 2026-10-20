import {
  createContextLoader,
  type ExtraInitializer,
  type ExtraContext,
  type JsonObject
} from "@mininglamp-oss/octo-runtime-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import {
  validateImBots,
  configuredCredential,
  imBotIdentity,
  IM_MAX_BOTS
} from "./lifecycle/configuration.js";
import type { GatewayDependencies } from "./ports.js";

export const name = "channel-gateway";
export default function load(
  context: ExtraContext,
  config: JsonObject
): ExtraInitializer<GatewayDependencies> {
  // JSON 连接配置与宿主函数分别装配；插件保留 manager，不向宿主开放逐 Bot 控制。
  return (dependencies) => initialize(context, config, dependencies);
}
async function initialize(
  context: ExtraContext,
  config: JsonObject,
  dependencies: Readonly<GatewayDependencies>
): Promise<void> {
  if (
    dependencies.createSessionStore !== undefined &&
    typeof dependencies.createSessionStore !== "function"
  )
    throw new Error("IM_SESSION_STORE_FACTORY_INVALID");
  // 回调池归整个 Extra 所有，所有 Bot 共用额度；逆序清理时先停 manager，再等待业务 IO 退出。
  const contexts = createContextLoader(
    dependencies.loadContexts,
    config.context_loading,
    context.signal
  );
  context.onDispose(() => contexts.close());
  const bots = config.bots ?? [];
  const errors: JsonObject[] = [];
  const invalidBots: JsonObject[] = [];
  let channels: ImChannelManager | undefined = undefined;
  context.onDispose(() => channels?.close());
  context.onStatus(
    () =>
      JSON.parse(
        JSON.stringify({ bots: [...(channels?.status ?? []), ...invalidBots], errors })
      ) as JsonObject
  );
  if (!Array.isArray(bots) || bots.length > IM_MAX_BOTS) {
    errors.push({ error: "IM_CONFIG_LIST_REQUIRED" });
    return;
  }
  const spaces = config.authorized_space_ids;
  if (
    spaces !== undefined &&
    (!Array.isArray(spaces) || spaces.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    errors.push({ error: "IM_AUTHORIZED_SPACES_INVALID" });
    return;
  }
  const allowed = spaces as string[] | undefined;
  channels = new ImChannelManager({
    host: context.adapterHost,
    signal: context.signal,
    log: context.log,
    createSessionStore: dependencies.createSessionStore,
    // 只保存调用入口，不预取提示词；宿主更新业务存储后，下一个接纳的逻辑轮重新读取。
    prepareContexts: (bot, signal) => contexts.load(bot, signal),
    credentials: (bot) => Promise.resolve(configuredCredential(bot)),
    ...(allowed
      ? {
          authorizeSpace: (spaceId: string) => {
            if (!allowed.includes(spaceId)) throw new Error("IM_TENANT_NOT_ACTIVE");
          }
        }
      : {})
  });
  const identities = new Set<string>();
  for (const [index, value] of bots.entries()) {
    context.signal.throwIfAborted();
    try {
      const candidate: unknown = [value];
      validateImBots(candidate);
      const bot = candidate[0];
      const key = imBotIdentity(bot);
      if (identities.has(key)) throw new Error("IM_BOT_DUPLICATED");
      identities.add(key);
      await channels.upsert(bot);
    } catch (error) {
      context.signal.throwIfAborted();
      const code =
        error instanceof Error && /^IM_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "IM_BOT_CONFIG_ERROR";
      errors.push({ config_index: index, error: code });
      invalidBots.push({
        config_index: index,
        state: "config_error",
        connected: false,
        error: code
      });
    }
  }
}
