#!/usr/bin/env python3
"""Issue #22 的隔离历史验收。仅创建本地测试提交，不修改源仓库或访问服务。"""
import argparse
import base64
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

FAILED = "62d10ac46e7c2c3505b42c362229f7b91f328e5b"
BASE = "ab3ded527db4599f50bbab4c2045b4b025086f3d"
REPO = Path(__file__).resolve().parents[3]
PATCH_FILES = [
    ".gitleaksignore", ".github/CI.md", ".octospec/index.md",
    ".octospec/rules/engineering.md", ".octospec/log.md",
    "scripts/lint-names.mjs", "test/name-lint.test.js",
]
TASK = ".octospec/tasks/gitleaks-history-triage"
JOURNAL = ".octospec/journal/shared/2026-10-19-gitleaks-history-triage.md"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks", required=True, type=Path)
    parser.add_argument("--scratch", required=True, type=Path,
                        help="必须是尚不存在的新目录；脚本不删除已有文件")
    parser.add_argument("--reuse-evidence", type=Path,
                        help="复用已完成的历史验收目录，不重复核验和生成 canary")
    args = parser.parse_args()
    scanner = args.gitleaks.resolve()
    scratch = args.scratch.resolve()
    if scratch.exists():
        raise SystemExit("scratch 已存在；请选择新目录，保留上一轮证据")
    if not scanner.is_file():
        raise SystemExit("找不到指定的 Gitleaks 可执行文件")
    env = dict(os.environ)
    for key in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"):
        env.pop(key, None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # 仅用于隔离验证仓库的合成提交元数据，不作为产品变更的作者身份。
    env.update(GIT_AUTHOR_NAME="Gitleaks verification fixture",
               GIT_AUTHOR_EMAIL="gitleaks-fixture@example.invalid",
               GIT_COMMITTER_NAME="Gitleaks verification fixture",
               GIT_COMMITTER_EMAIL="gitleaks-fixture@example.invalid")

    def git(cwd, *argv):
        result = subprocess.run(["git", *argv], cwd=cwd, env=env,
                                capture_output=True, text=True, encoding="utf-8")
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    version = subprocess.check_output([str(scanner), "version"], env=env, text=True).strip()
    if version != "8.30.1":
        raise SystemExit("验收固定使用 Gitleaks 8.30.1")
    ignore = (REPO / ".gitleaksignore").read_text(encoding="utf-8")
    fingerprints = [line.strip() for line in ignore.splitlines()
                    if line.strip() and not line.lstrip().startswith("#")]
    pattern = r"[0-9a-f]{40}:[^:\r\n]+:(?:generic-api-key|curl-auth-header):[1-9][0-9]*"
    assert len(fingerprints) == len(set(fingerprints)) == 45
    assert all(re.fullmatch(pattern, item) for item in fingerprints)
    expected = set(fingerprints)
    scratch.mkdir(parents=True)
    checks = []
    metadata = {"gitleaks_version": version, "failed_base": FAILED, "main_base": BASE,
                "platform": os.name, "git_version": git(REPO, "--version"),
                "checks": checks}

    def scan(name, cwd, expect, options=(), report=True):
        # 与现有工作流命令一致；仅增加脱敏 JSON 报告输出参数。
        command = [str(scanner), "git", *options, "--redact", "--verbose"]
        report_path = scratch / (name + ".redacted.json")
        if report:
            command += ["--report-format", "json", "--report-path", str(report_path)]
        command += ["."]
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True,
                                text=True, encoding="utf-8")
        (scratch / (name + ".redacted.log")).write_text(
            result.stdout + result.stderr, encoding="utf-8")
        findings = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else []
        assert all(finding["Secret"] == "REDACTED" for finding in findings)
        count = re.search(r"(\d+) commits scanned", result.stderr)
        logged_findings = re.search(r"leaks found: (\d+)", result.stderr)
        finding_count = len(findings) if report else (
            int(logged_findings.group(1)) if logged_findings else
            0 if "no leaks found" in result.stderr else None)
        checks.append({"name": name, "cwd": cwd.name, "options": list(options),
                       "exit": result.returncode, "findings": finding_count,
                       "scanned_commits": int(count.group(1)) if count else None,
                       "report": report, "head": git(cwd, "rev-parse", "HEAD")})
        (scratch / "summary.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        assert result.returncode == expect, f"{name}: exit {result.returncode}, expected {expect}"
        print(f"{name}: exit={result.returncode}, findings={finding_count}", flush=True)
        return findings

    repos = {}
    baselines = {}
    previous = None
    if args.reuse_evidence:
        previous_dir = args.reuse_evidence.resolve()
        previous = json.loads((previous_dir / "summary.json").read_text(encoding="utf-8"))
        assert previous["historical_dispositions_and_canaries_passed"]
        assert previous["main_base"] == BASE and previous["expected_canaries"] == 19
        baseline = json.loads((previous_dir / "main-baseline.redacted.json").read_text(encoding="utf-8"))
        assert len(baseline) == 45 and {f["Fingerprint"] for f in baseline} == expected
        baselines["main"] = baseline
        cwd = scratch / "main"
        cwd.mkdir()
        git(cwd, "init", "--quiet")
        git(cwd, "fetch", "--quiet", "--no-tags", str(previous_dir / "main"), previous["canary_sha"])
        git(cwd, "checkout", "--quiet", "--detach", previous["candidate_sha"])
        assert git(cwd, "rev-parse", "--is-shallow-repository") == "false"
        assert not git(cwd, "for-each-ref", "--format=%(refname)")
        assert (cwd / ".gitleaksignore").read_text(encoding="utf-8") == ignore
        repos["main"] = cwd
        metadata["reused_history_evidence"] = previous_dir.name
    else:
        for name, sha in (("original", FAILED), ("main", BASE)):
            cwd = scratch / name
            cwd.mkdir()
            git(cwd, "init", "--quiet")
            git(cwd, "fetch", "--quiet", "--no-tags", str(REPO), sha)
            git(cwd, "checkout", "--quiet", "--detach", sha)
            assert git(cwd, "rev-parse", "HEAD") == sha
            assert git(cwd, "rev-parse", "--is-shallow-repository") == "false"
            assert not git(cwd, "for-each-ref", "--format=%(refname)")
            baseline = scan(name + "-baseline", cwd, 1)
            assert {item["Fingerprint"] for item in baseline} == expected
            assert len(baseline) == 45
            baselines[name] = baseline
            repos[name] = cwd
            (cwd / ".gitleaksignore").write_text(ignore, encoding="utf-8")
            assert not scan(name + "-exceptions", cwd, 0)

    cwd = repos["main"]
    paths = PATCH_FILES + [str(path.relative_to(REPO)).replace("\\", "/")
                          for path in (REPO / TASK).rglob("*") if path.is_file() and "__pycache__" not in path.parts]
    if (REPO / JOURNAL).exists():
        paths.append(JOURNAL)
    for relative in paths:
        source, target = REPO / relative, cwd / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    git(cwd, "add", "--", *paths)
    git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet",
        "-m", "fixture: apply reviewed historical dispositions")
    candidate = git(cwd, "rev-parse", "HEAD")
    metadata["candidate_sha"] = candidate
    assert not scan("candidate-full", cwd, 0)
    assert not scan("candidate-pr", cwd, 0, ["--log-opts=" + BASE + ".." + candidate])
    # 不带报告扩展参数，再执行一次工作流原样命令。
    scan("candidate-workflow-exact", cwd, 0, report=False)

    ignore_path = cwd / ".gitleaksignore"
    saved_ignore = cwd / ".gitleaksignore.saved"
    ignore_path.rename(saved_ignore)
    try:
        assert {f["Fingerprint"] for f in scan("missing-ignore", cwd, 1)} == expected
    finally:
        saved_ignore.rename(ignore_path)
    scan("missing-explicit-config", cwd, 1, ["--config", "missing-config.toml"])
    invalid = cwd / ".gitleaks.toml"
    invalid.write_text("[[rules]\n", encoding="utf-8")
    scan("invalid-config", cwd, 1, ["--config", ".gitleaks.toml"])
    invalid.rename(cwd / "invalid-config.saved")
    if previous:
        canary_sha = previous["canary_sha"]
        canary_base = previous["candidate_sha"]
        git(cwd, "checkout", "--quiet", "--detach", canary_sha)
        expected_canaries = json.loads(
            (previous_dir / "canary-full.redacted.json").read_text(encoding="utf-8"))
        expected_fingerprints = {f["Fingerprint"] for f in expected_canaries}
        assert len(expected_fingerprints) == len(expected_canaries) == 19
        for name, options in (("canary-full", []),
                              ("canary-pr", ["--log-opts=" + canary_base + ".." + canary_sha])):
            findings = scan(name, cwd, 1, options)
            assert len(findings) == 19
            assert {f["Fingerprint"] for f in findings} == expected_fingerprints
            assert not (expected & expected_fingerprints)
        scan("canary-pr-workflow-exact", cwd, 1,
             ["--log-opts=" + canary_base + ".." + canary_sha], report=False)
        metadata.update(canary_sha=canary_sha, canary_base=canary_base, expected_canaries=19)
    else:
        # 保留原始历史，直接在各历史路径/行号添加新内容；不运行这些文件。
        per_file = collections.defaultdict(list)
        for finding in baselines["main"]:
            per_file[finding["File"]].append(finding)
        canaries = set()

        def value(label):
            return base64.urlsafe_b64encode(
                hashlib.sha256(("issue22-nonfunctional-canary:" + label).encode()).digest()
            ).decode().rstrip("=")

        for relative, occurrences in sorted(per_file.items()):
            rows = {}
            fields = {}
            for finding in sorted(occurrences, key=lambda f: f["StartLine"]):
                field = "curl" if finding["RuleID"] == "curl-auth-header" else re.match(
                    r"[a-z_]+", finding["Match"]).group()
                fields.setdefault(field, finding["StartLine"])
            for field, line in fields.items():
                if field == "curl":
                    rows[line] = "curl 'https://example.invalid' \\"
                    rows[line + 1] = "  -H 'Authorization: Bearer " + value(relative + field) + "'"
                    canaries.add((relative, line, "curl-auth-header"))
                else:
                    rows[line] = '"' + field + '": "' + value(relative + field) + '"'
                    canaries.add((relative, line, "generic-api-key"))
            adjacent = max(rows) + 1
            rows[adjacent] = '"api_key": "' + value(relative + "adjacent") + '"'
            canaries.add((relative, adjacent, "generic-api-key"))
            # 额外证明厂商特定内置规则仍有效。前缀在运行时组合，不把 canary 留在源树。
            if relative == "test/task-materials.test.js":
                vendor_line = adjacent + 1
                vendor = "gh" + "p_" + hashlib.sha256(b"issue22-vendor-canary").hexdigest()[:36]
                rows[vendor_line] = '"vendor_token": "' + vendor + '"'
                canaries.add((relative, vendor_line, "github-pat"))
            target = cwd / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("\n".join(rows.get(i, "") for i in range(1, max(rows) + 1)) + "\n",
                              encoding="utf-8")
        git(cwd, "add", "--", *sorted(per_file))
        git(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet",
            "-m", "fixture: add nonfunctional secret-pattern canaries")
        canary_sha = git(cwd, "rev-parse", "HEAD")
        metadata["canary_sha"] = canary_sha
        metadata["expected_canaries"] = len(canaries)
        for name, options in (("canary-full", []),
                              ("canary-pr", ["--log-opts=" + candidate + ".." + canary_sha])):
            findings = scan(name, cwd, 1, options)
            actual = {(f["File"], f["StartLine"], f["RuleID"]) for f in findings}
            assert actual == canaries, f"{name}: unexpected canary locations/rules"
            assert len(findings) == len(canaries)
            assert all(f["Commit"] == canary_sha for f in findings)
            assert not (expected & {f["Fingerprint"] for f in findings})
        scan("canary-pr-workflow-exact", cwd, 1,
             ["--log-opts=" + candidate + ".." + canary_sha], report=False)
    metadata["complete"] = True
    metadata["validation_scope"] = "historical-false-positive-dispositions"
    metadata["historical_dispositions_and_canaries_passed"] = True
    (scratch / "summary.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PASS: reviewed history exceptions and new-commit canaries")
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
