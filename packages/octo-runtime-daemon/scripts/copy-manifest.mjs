import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(packageRoot, "dist", "runtime", "config", "adapters.json");
mkdirSync(dirname(target), { recursive: true });
cpSync(resolve(packageRoot, "..", "..", "config", "adapters.json"), target);
