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
    const before = Date.now();
    execFileSync(process.execPath, [script, root], {
      env: { ...process.env, OCTO_RUNTIME_BUILD_TIME: "" }
    });
    const { buildTime, ...source } = JSON.parse(
      await readFile(join(root, "apps/cli/dist/build-info.json"), "utf8")
    );
    assert.equal(new Date(buildTime).toISOString(), buildTime);
    assert.ok(Date.parse(buildTime) >= before && Date.parse(buildTime) <= Date.now());
    return source;
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

test("release rebuilds preserve an explicit build timestamp and reject invalid overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "octo-build-time-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buildTime = "2026-10-18T12:34:56.789Z";
  for (const timezone of ["Pacific/Honolulu", "Asia/Shanghai"]) {
    execFileSync(process.execPath, [script, root], {
      env: { ...process.env, TZ: timezone, OCTO_RUNTIME_BUILD_TIME: buildTime }
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "apps/cli/dist/build-info.json"), "utf8")),
      {
        commit: null,
        dirty: null,
        buildTime
      }
    );
  }
  for (const invalid of ["invalid", "2026-02-30T12:34:56.789Z", "2026-10-18T12:34:56+08:00"]) {
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, root], {
          env: { ...process.env, OCTO_RUNTIME_BUILD_TIME: invalid },
          stdio: "pipe"
        }),
      /UTC timestamp/
    );
  }
});
