#!/usr/bin/env python3
"""检查本仓 OKF 单元、规则索引与本地 Markdown 文件链接。"""
from pathlib import Path
import re
import subprocess
import sys

import yaml


ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / ".octospec"


def main():
    errors = []
    rules = {}
    count = 0
    for directory in ("rules", "guides", "tasks", "journal", "learnings"):
        for path in sorted((SPEC / directory).rglob("*.md")):
            if path.name in ("index.md", "log.md") or path.name.endswith(".template.md"):
                continue
            try:
                text = path.read_text(encoding="utf-8")
                match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.S)
                if not match:
                    raise ValueError("缺少完整 YAML frontmatter")
                metadata = yaml.safe_load(match.group(1))
                if not isinstance(metadata, dict):
                    raise ValueError("frontmatter 必须是 mapping")
                kind = metadata.get("type")
                if not isinstance(kind, str) or not kind.strip():
                    raise ValueError("缺少非空 type")
                if directory == "rules":
                    if kind != "Rule":
                        raise ValueError("规则必须声明 type: Rule")
                    rule_id = metadata["id"]
                    if not isinstance(rule_id, str) or not rule_id.strip():
                        raise ValueError("规则 id 必须是非空字符串")
                    if rule_id in rules:
                        raise ValueError("重复规则 id: " + rule_id)
                    rules[rule_id] = {
                        key: metadata[key]
                        for key in ("id", "priority", "load_bearing", "inject_when")
                    }
                count += 1
            except (KeyError, TypeError, ValueError, yaml.YAMLError) as error:
                errors.append(f"{path.relative_to(ROOT)}: {error}")

    try:
        index = yaml.safe_load((SPEC / "rules/_index.yaml").read_text(encoding="utf-8"))
        entries = index["rules"]
        indexed = {entry["id"]: entry for entry in entries}
        if len(entries) != len(indexed) or indexed != rules:
            errors.append("规则索引与规则 frontmatter 不一致或存在重复 id")
    except (KeyError, TypeError, yaml.YAMLError) as error:
        errors.append(f"规则索引无效: {error}")

    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
        cwd=ROOT, check=True, capture_output=True,
    )
    links = 0
    for name in sorted(set(result.stdout.decode().split("\0")) - {""}):
        path = ROOT / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)\n]+)\)", text):
            if re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith(("#", "/")):
                continue
            links += 1
            if not (path.parent / target.split("#", 1)[0]).exists():
                errors.append(f"{name}: 本地链接失效: {target}")

    for directory in (ROOT / "docs", ROOT / "packages/octo-runtime-protocol/docs"):
        if directory.exists():
            errors.append(f"已退出的文档目录仍存在: {directory.relative_to(ROOT)}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"OK: {count} 个 OKF 单元，{len(rules)} 条规则，{links} 个本地文件链接")
    return 0


if __name__ == "__main__":
    sys.exit(main())
