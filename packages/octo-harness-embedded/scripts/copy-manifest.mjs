import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "..", "..", "config", "adapters.json");
const target = resolve(packageRoot, "dist", "config", "adapters.json");
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target);
