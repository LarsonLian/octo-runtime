import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const buildTime = process.env.OCTO_RUNTIME_BUILD_TIME || new Date().toISOString();
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(buildTime) ||
  !Number.isFinite(Date.parse(buildTime)) ||
  new Date(buildTime).toISOString() !== buildTime
) {
  throw new Error("OCTO_RUNTIME_BUILD_TIME must be a valid UTC timestamp with milliseconds");
}
const git = (args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
let commit = null;
let dirty = null;
try {
  commit = git(["rev-parse", "--verify", "HEAD"]);
  dirty = git(["status", "--porcelain=v1", "--untracked-files=normal"]) !== "";
} catch {
  commit = null;
  dirty = null;
}
const directory = join(root, "apps/cli/dist");
await mkdir(directory, { recursive: true });
await writeFile(
  join(directory, "build-info.json"),
  JSON.stringify({ commit, dirty, buildTime }, null, 2) + "\n"
);
