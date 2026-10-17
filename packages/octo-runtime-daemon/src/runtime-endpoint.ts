import { createHash } from "node:crypto";
import { join } from "node:path";

/** Resolve the resident Runtime control endpoint for an already-normalized Home. */
export function runtimeControlEndpoint(
  home: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return join(home, "sockets", "octo-runtime-daemon.sock");
  const homeId = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\octo-runtime-${homeId}`;
}
