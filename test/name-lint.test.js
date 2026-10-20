import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/lint-names.mjs", import.meta.url));
const previous = ["octo", "harness"].join("-");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "runtime-names-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    run() {
      const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
      assert.equal(result.error, undefined);
      return { code: result.status, report: JSON.parse(result.stdout) };
    }
  };
}

test("name lint accepts current names and rejects case variants without echoing source contents", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, "package.json"), '{"name":"octo-runtime-adapter-codex"}');
  assert.equal(run().code, 0);
  await writeFile(
    join(root, "source.ts"),
    `const secret = "DO_NOT_ECHO_${previous.toUpperCase()}";`
  );
  const result = run();
  assert.equal(result.code, 1);
  assert.equal(result.report.findings.length, 1);
  assert.equal(result.report.findings[0].line, 1);
  assert.ok(!JSON.stringify(result.report).includes("DO_NOT_ECHO"));
});

test("name lint rejects old filenames even when their contents use only new names", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, `${previous}.md`), "Octo Runtime");
  assert.equal(run().code, 1);
  assert.equal(run().report.findings[0].kind, "path");
});

test("only the exact architecture-review explanation is reported as an exception", async (t) => {
  const { root, run } = await fixture(t);
  await mkdir(join(root, "docs"));
  const file = join(root, "docs/octo-runtime-rename-ipd-se.md");
  const explanation = `架构评审指出：\`${previous}\` 命名有歧义，容易被理解为自研 ReAct 框架。`;
  await writeFile(file, explanation);
  assert.equal(run().code, 0);
  assert.equal(run().report.exceptions.length, 1);
  await writeFile(file, `${explanation}\nimport '${previous}-protocol';`);
  assert.equal(run().code, 1);
  assert.equal(run().report.findings.length, 1);
});

test("name lint does not read dependencies, independent worktrees, credentials or binary contents", async (t) => {
  const { root, run } = await fixture(t);
  for (const directory of ["node_modules", ".worktree"]) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, `${previous}.js`), previous);
  }
  await writeFile(join(root, "secret.md"), previous);
  await writeFile(join(root, "binary.dat"), Buffer.from(`\0${previous}`));
  assert.equal(run().code, 0);
});

const historyFiles = [".gitleaksignore", ".octospec/tasks/gitleaks-history-triage/findings.md"];

test("name lint accepts reviewed historical evidence with LF and CRLF line endings", async (t) => {
  for (const file of historyFiles) {
    const { root, run } = await fixture(t);
    await mkdir(join(root, ".octospec/tasks/gitleaks-history-triage"), { recursive: true });
    const original = await readFile(new URL("../" + file, import.meta.url), "utf8");
    for (const newline of ["\n", "\r\n"]) {
      await writeFile(
        join(root, file),
        original.replaceAll("\r\n", "\n").replaceAll("\n", newline)
      );
      const result = run();
      assert.equal(result.code, 0);
      assert.equal(result.report.findings.length, 0);
      assert.ok(result.report.exceptions.length > 0);
    }
  }
});

test("name lint rejects edits and appended legacy uses in historical evidence", async (t) => {
  for (const file of historyFiles) {
    const { root, run } = await fixture(t);
    await mkdir(join(root, ".octospec/tasks/gitleaks-history-triage"), { recursive: true });
    const original = await readFile(new URL("../" + file, import.meta.url), "utf8");
    for (const changed of [
      original.replace(previous + "-protocol", previous + "-other"),
      original + "\nimport '" + previous + "-protocol';\n"
    ]) {
      assert.notEqual(changed, original);
      await writeFile(join(root, file), changed);
      const result = run();
      assert.equal(result.code, 1);
      assert.ok(result.report.findings.length > 0);
      assert.equal(result.report.exceptions.length, 0);
    }
  }
});

test("name lint rejects copied history elsewhere and legacy uses beside approved evidence", async (t) => {
  const { root, run } = await fixture(t);
  const original = await readFile(new URL("../.gitleaksignore", import.meta.url), "utf8");
  await writeFile(join(root, ".gitleaksignore"), original);
  await writeFile(join(root, "copied-history.md"), original);
  await writeFile(join(root, "source.ts"), "import '" + previous + "-protocol';");
  await writeFile(join(root, previous + ".md"), "Octo Runtime");
  const result = run();
  assert.equal(result.code, 1);
  assert.ok(result.report.exceptions.length > 0);
  assert.deepEqual(
    [...new Set(result.report.findings.map((finding) => finding.file))].sort(),
    ["copied-history.md", "source.ts", previous + ".md"].sort()
  );
});
