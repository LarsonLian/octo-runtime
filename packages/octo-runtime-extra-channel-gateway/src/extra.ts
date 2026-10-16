import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import { validateImBots, configuredCredential, imBotIdentity, IM_MAX_BOTS } from "./lifecycle/configuration.js";

export const name = "channel-gateway";
export default async function load(context: ExtraContext, config: JsonObject): Promise<void> {
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
