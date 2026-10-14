import { join } from "node:path";
import { assertExtraName, assertStoredExtra } from "@mininglamp-oss/octo-runtime-daemon";
import { withSetupLock, writeJsonAtomic, type RuntimePaths } from "./state.js";

/** Generic full replacement: no platform-specific CLI fields or validation. */
export async function setExtra(
  paths: RuntimePaths,
  name: string,
  input: NodeJS.ReadableStream
): Promise<unknown> {
  assertExtraName(name);
  if ((input as NodeJS.ReadStream).isTTY)
    throw new Error("extraset requires one JSON object on stdin");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new Error("EXTRA_CONFIG_TOO_LARGE");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("extraset stdin must contain one valid JSON object");
  }
  assertStoredExtra(value);
  const file = join(paths.home, "default", "extra", name, "config.json");
  return withSetupLock(paths, async () => {
    await writeJsonAtomic(file, value);
    return { saved: true, name, file, restart_required: true };
  });
}
