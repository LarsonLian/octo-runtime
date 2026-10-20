import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.indexOf("--root");
if (rootArg >= 0 && !process.argv[rootArg + 1]) throw new Error("--root requires a directory");
const root = resolve(
  rootArg >= 0 ? process.argv[rootArg + 1] : fileURLToPath(new URL("..", import.meta.url))
);
const legacy = [
  ["octo", "harness"].join("-"),
  ["OCTO", "HARNESS"].join("_"),
  ["Octo", "Harness"].join(""),
  ["Octo", "Harness"].join(" ")
];
function containsLegacy(value, name) {
  // Environment prefixes are case-sensitive; historical database names are not package names.
  return name === legacy[1]
    ? value.includes(name)
    : value.toLowerCase().includes(name.toLowerCase());
}
// Issue #22 的原始路径属于不可改写的历史证据。仅允许已核验的完整内容快照；
// 任意内容变更都须重新审核，不能把文件或目录整体排除于命名检查之外。
// 统一 CRLF/LF 后校验，以兼容 Windows checkout；此例外不改变 Gitleaks 扫描规则。
const historicalEvidence = new Map([
  [".gitleaksignore", "9261fbfaaa21f314aad7641eb9f3779adbc7649dc627e591699d12766814d736"],
  [
    ".octospec/tasks/gitleaks-history-triage/findings.md",
    "df331c61f2eaea9e18a36ae2150ff053f56bd555c11e57df0c2653e809ed7d70"
  ]
]);
const excluded = [".git", "node_modules", "dist", "out", "release", ".worktree", ".workbuddy"];
const args = [
  "--files",
  "--hidden",
  "-0",
  ...excluded.flatMap((name) => ["-g", `!**/${name}/**`, "-g", `!**/${name}`]),
  "-g",
  "!**/secret.md"
];
const result = spawnSync("rg", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
if (result.error || (result.status !== 0 && result.status !== 1))
  throw result.error ?? new Error(result.stderr);
const files = result.stdout.split("\0").filter(Boolean);
const findings = [],
  exceptions = [];
for (const file of files) {
  if (legacy.some((name) => containsLegacy(file, name))) findings.push({ file, kind: "path" });
  const bytes = readFileSync(resolve(root, file));
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  const evidenceHash = historicalEvidence.get(file.replaceAll("\\", "/"));
  const verifiedEvidence =
    evidenceHash !== undefined &&
    createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex") === evidenceHash;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const names = legacy.filter((name) => containsLegacy(line, name));
    if (!names.length) continue;
    const entry = { file, line: index + 1, names };
    const requiredHistory =
      file.replaceAll("\\", "/") === "docs/octo-runtime-rename-ipd-se.md" &&
      line.startsWith("架构评审指出：`" + legacy[0] + "` 命名有歧义") &&
      names.length === 1 &&
      line.split(legacy[0]).length === 2;
    if (requiredHistory)
      exceptions.push({ ...entry, reason: "Explicitly required architecture-review history" });
    else if (verifiedEvidence)
      exceptions.push({ ...entry, reason: "Reviewed Issue #22 historical evidence snapshot" });
    else findings.push(entry);
  }
}
console.log(
  JSON.stringify(
    {
      root: relative(process.cwd(), root) || ".",
      scannedFiles: files.length,
      findings,
      exceptions,
      excluded,
      respectsGitIgnore: true
    },
    null,
    2
  )
);
process.exitCode = findings.length ? 1 : 0;
