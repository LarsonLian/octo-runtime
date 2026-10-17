import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const readManifest = async (path) => JSON.parse(await readFile(path, "utf8"));

test("发行源码清单保持非发行占位版本，内部 workspace 全部禁止独立发布", async () => {
  const rootManifest = await readManifest(join(root, "package.json"));
  assert.equal(rootManifest.version, "0.0.0");
  assert.notEqual(rootManifest.private, true);

  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = await readManifest(join(root, parent, entry.name, "package.json"));
      assert.equal(manifest.version, "0.0.0", manifest.name);
      assert.equal(manifest.private, true, manifest.name);
    }
  }
});

test("发行打包只接受不带 v 前缀的稳定 SemVer", async () => {
  await assert.rejects(
    execute(process.execPath, ["scripts/pack-release.mjs", "--version", "v1.0.0"], {
      cwd: root
    }),
    /发行版本必须是稳定 SemVer/
  );
  await assert.rejects(
    execute(process.execPath, ["scripts/pack-release.mjs", "--unknown", "1.0.0"], {
      cwd: root
    }),
    /用法/
  );
  await assert.rejects(
    execute(process.execPath, ["scripts/pack-release.mjs", "--version", "0.0.0"], {
      cwd: root
    }),
    /仅用于源码占位/
  );
});

test("发行校验在 checkout 压平本地 ref 后恢复远端 annotated tag 对象", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orc-release-tag-"));
  const remote = join(directory, "remote.git");
  const source = join(directory, "source");
  const runner = join(directory, "runner");
  try {
    await execute("git", ["init", "--bare", remote]);
    await execute("git", ["init", "-b", "main", source]);
    await execute("git", [
      "-C",
      source,
      "-c",
      "user.name=Release Fixture",
      "-c",
      "user.email=release-fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture"
    ]);
    await execute("git", ["-C", source, "tag", "-a", "v1.0.0", "-m", "fixture"]);
    await execute("git", ["-C", source, "remote", "add", "origin", remote]);
    await execute("git", ["-C", source, "push", "origin", "main", "refs/tags/v1.0.0"]);

    await execute("git", ["init", runner]);
    await execute("git", ["-C", runner, "remote", "add", "origin", remote]);
    await execute("git", ["-C", runner, "fetch", "origin", "main"]);
    const commit = (await execute("git", ["-C", runner, "rev-parse", "FETCH_HEAD"])).stdout.trim();
    assert.match(commit, /^[a-f0-9]{40,64}$/);

    await execute("git", ["-C", runner, "update-ref", "refs/tags/v1.0.0", commit]);
    assert.equal(
      (await execute("git", ["-C", runner, "cat-file", "-t", "refs/tags/v1.0.0"])).stdout.trim(),
      "commit"
    );
    await execute("git", [
      "-C",
      runner,
      "fetch",
      "--force",
      "--no-tags",
      "origin",
      "refs/tags/v1.0.0:refs/tags/v1.0.0"
    ]);
    assert.equal(
      (await execute("git", ["-C", runner, "cat-file", "-t", "refs/tags/v1.0.0"])).stdout.trim(),
      "tag"
    );

    const workflow = await readFile(join(root, ".github/workflows/npm-publish.yml"), "utf8");
    assert.match(
      workflow,
      /git fetch --force --no-tags origin "refs\/tags\/\$TAG:refs\/tags\/\$TAG"/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
