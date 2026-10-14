import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import { validateImBots, configuredCredential } from "./lifecycle/file-config.js";

export const name = "channel-wecom";
export default async function load(context: ExtraContext, config: JsonObject): Promise<void> {
  const bots = config.bots ?? [];
  validateImBots(bots);
  const channels = new ImChannelManager({ host: context.adapterHost, credentials: async (bot) => configuredCredential(bot) });
  context.onDispose(() => channels.close());
  for (const bot of bots) {
    context.signal.throwIfAborted();
    await channels.upsert(bot);
  }
}
