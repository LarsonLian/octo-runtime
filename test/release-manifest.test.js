import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
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
