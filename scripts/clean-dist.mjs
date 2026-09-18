import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

for (const workspaceRoot of ["apps", "packages"]) {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await rm(join(workspaceRoot, entry.name, "dist"), { recursive: true, force: true });
  }
}
