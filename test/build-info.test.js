import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/write-build-info.mjs", import.meta.url));

test("build metadata records source commit and dirty state; absent Git stays unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "octo-build-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = async () => {
    execFileSync(process.execPath, [script, root]);
    return JSON.parse(await readFile(join(root, "apps/cli/dist/build-info.json"), "utf8"));
  };
  assert.deepEqual(await build(), { commit: null, dirty: null });
  await writeFile(join(root, ".gitignore"), "apps/cli/dist/\n");
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  git(["init"]);
  git(["add", ".gitignore"]);
  git([
    "-c",
    "user.name=Build Test",
    "-c",
    "user.email=build-test@example.invalid",
    "commit",
    "-m",
    "fixture"
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  assert.deepEqual(await build(), { commit, dirty: false });
  await writeFile(join(root, "source.txt"), "untracked change\n");
  assert.deepEqual(await build(), { commit, dirty: true });
  git(["add", "source.txt"]);
  assert.deepEqual(await build(), { commit, dirty: true });
  git([
    "-c",
    "user.name=Build Test",
    "-c",
    "user.email=build-test@example.invalid",
    "commit",
    "-m",
    "source"
  ]);
  const nextCommit = git(["rev-parse", "HEAD"]);
  assert.notEqual(nextCommit, commit);
  assert.deepEqual(await build(), { commit: nextCommit, dirty: false });
});
