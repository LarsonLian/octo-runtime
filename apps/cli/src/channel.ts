import { join } from "node:path";
import {
  imBotIdentity,
  readImBots,
  validateImConfig,
  validateImBots,
  type ImBotConfig
} from "@mininglamp-oss/octo-runtime-channel-im";
import { withSetupLock, writeJsonAtomic, type RuntimePaths } from "./state.js";

/** One complete Bot object per invocation; im.json is a list of these objects. */
export async function configureChannel(
  paths: RuntimePaths,
  input: NodeJS.ReadableStream
): Promise<unknown> {
  if ((input as NodeJS.ReadStream).isTTY)
    throw new Error("channel configure requires one JSON object on stdin");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("IM_CONFIG_INPUT_TOO_LARGE");
    chunks.push(bytes);
  }
  let config: ImBotConfig;
  try {
    config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("channel configure stdin must contain one valid JSON object");
  }
  validateImConfig(config);
  return withSetupLock(paths, async () => {
    const bots = readImBots(paths.home);
    const key = imBotIdentity(config);
    const index = bots.findIndex((bot) => imBotIdentity(bot) === key);
    if (index < 0) bots.push(config);
    else bots[index] = config;
    validateImBots(bots);
    const file = join(paths.home, "im.json");
    await writeJsonAtomic(file, bots);
    return {
      saved: true,
      file,
      bot_id: config.bot_id,
      count: bots.length,
      action: index < 0 ? "added" : "updated",
      restart_required: true
    };
  });
}
