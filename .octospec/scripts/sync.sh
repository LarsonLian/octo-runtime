#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
spec_dir="$repo_root/.octospec"
bash "$spec_dir/scripts/octospec-sync.sh"

# 上游仍管理全局缓存和根脚手架，本仓中文入口在最后统一同步。
for agent_file in CLAUDE.md AGENTS.md GEMINI.md QWEN.md; do
  [ -f "$repo_root/$agent_file" ] || continue
  python3 "$spec_dir/scripts/octospec_sync_block.py" \
    "$repo_root/$agent_file" "$spec_dir/AGENT-BLOCK.md"
done
