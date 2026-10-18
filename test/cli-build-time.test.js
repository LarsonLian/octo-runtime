import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("artifact help metadata is stable across cwd/timezones and tolerates legacy or invalid build times", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "octo-cli-build-time-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "apps/cli/dist");
  await mkdir(dist, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", version: "1.0.1" })
  );
  await writeFile(
    join(dist, "help.js"),
    await readFile(new URL("../apps/cli/dist/help.js", import.meta.url))
  );
  const metadataPath = join(dist, "build-info.json");
  const readInfo = (timezone) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const help = await import(${JSON.stringify(pathToFileURL(join(dist, "help.js")).href)}); console.log(JSON.stringify([help.cliVersionInfo, help.helpText()]));`
        ],
        { cwd: tmpdir(), env: { ...process.env, TZ: timezone }, encoding: "utf8" }
      )
    );
  const commit = "1234567890abcdef1234567890abcdef12345678";
  for (const buildTime of ["2026-10-18T12:34:56.789Z", "2026-10-18T12:34:56Z"]) {
    await writeFile(metadataPath, JSON.stringify({ commit, dirty: true, buildTime }));
    const expected = `1.0.1\ncommit:${commit.slice(0, 12)} (dirty)\nbuild:${buildTime}`;
    for (const timezone of ["Asia/Shanghai", "Pacific/Honolulu"]) {
      const [versionInfo, help] = readInfo(timezone);
      assert.equal(versionInfo, expected);
      assert.ok(help.includes(`\nbuild:${buildTime}\n`));
    }
  }
  for (const buildTime of [
    undefined,
    null,
    123,
    {},
    "invalid",
    "2026-02-30T12:34:56.000Z",
    "2026-10-18T12:34:56+08:00"
  ]) {
    await writeFile(metadataPath, JSON.stringify({ commit, dirty: false, buildTime }));
    assert.equal(readInfo("UTC")[0], `1.0.1\ncommit:${commit.slice(0, 12)}\nbuild:unknown`);
  }
  for (const content of ["{invalid", "null", "[]", "true", '{"commit":42}']) {
    await writeFile(metadataPath, content);
    assert.equal(readInfo("UTC")[0], "1.0.1\ncommit:unknown\nbuild:unknown");
  }
  await rm(metadataPath);
  assert.equal(readInfo("UTC")[0], "1.0.1\ncommit:unknown\nbuild:unknown");
});
