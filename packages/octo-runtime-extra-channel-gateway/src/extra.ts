import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import { ImChannelManager } from "./lifecycle/manager.js";
import { validateImBots, configuredCredential } from "./lifecycle/file-config.js";
import { imBotIdentity } from "./lifecycle/configuration.js";
import type { ImBotConfig } from "./contracts.js";

export const name = "channel-gateway";
export default async function load(context: ExtraContext, config: JsonObject): Promise<void> {
  let channels: ImChannelManager | undefined;
  let scope: string | undefined;
  const applied = new Map<string, string>();
  const configure = async (value: JsonObject): Promise<void> => {
    const bots = value.bots ?? [];
    validateImBots(bots);
    const spaces = value.authorized_space_ids;
    if (spaces !== undefined && (!Array.isArray(spaces) || spaces.some(id => typeof id !== "string" || !id.trim())))
      throw new Error("IM_AUTHORIZED_SPACES_INVALID");
    const allowed = spaces as string[] | undefined;
    const nextScope = allowed === undefined ? undefined : JSON.stringify([...new Set(allowed)].sort());
    context.signal.throwIfAborted();
    if (!channels || scope !== nextScope) {
      await channels?.close();
      applied.clear();
      channels = new ImChannelManager({
        host: context.adapterHost,
        credentials: (bot) => Promise.resolve(configuredCredential(bot)),
        ...(allowed ? { authorizeSpace: (spaceId: string) => {
          if (!allowed.includes(spaceId)) throw new Error("IM_TENANT_NOT_ACTIVE");
        } } : {})
      });
      scope = nextScope;
    }
    const desired = new Set(bots.map(imBotIdentity));
    for (const key of applied.keys()) {
      if (!desired.has(key)) {
        await channels.remove(key);
        applied.delete(key);
      }
    }
    for (const bot of bots as ImBotConfig[]) {
      context.signal.throwIfAborted();
      const key = imBotIdentity(bot);
      const fingerprint = JSON.stringify(bot);
      const state = channels.status.find(item => item.connection_key === key)?.state;
      if (applied.get(key) === fingerprint && !["authentication_failed", "waiting_credentials"].includes(String(state))) continue;
      await channels.upsert(bot);
      applied.set(key, fingerprint);
    }
  };
  context.onDispose(() => channels?.close());
  context.onStatus(() => JSON.parse(JSON.stringify({ bots: channels?.status ?? [], errors: [] })) as JsonObject);
  context.onConfigure(configure);
  context.onRequest((method) => {
    if (method !== "status") throw new Error("IM_EXTRA_METHOD_NOT_FOUND");
    return channels?.status ?? [];
  });
  await configure(config);
}
