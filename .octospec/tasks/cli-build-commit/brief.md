---
type: Task
title: CLI 版本展示构建 Git commit
description: pnpm build 固化源码提交信息，安装后的 CLI 直接展示构建来源。
tags: [typescript, testing, runtime]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与决策

用户通常运行 `pnpm build`，需要从安装后 octo-runtime 的版本信息识别构建对应的 Git commit。CLI workspace 构建时生成 `dist/build-info.json`，记录完整 SHA 与 dirty 状态；默认帮助和 `--version` / `-v` / `version` 额外显示 `commit:<12 位短 SHA>`，工作树有修改则附带 `(dirty)`。

来源固定为构建仓库，安装目录和调用者工作目录不参与版本判断。无 Git 来源时记录 null 并显示 unknown；语义版本号保持不变。现有打包流程复制 CLI dist，携带元数据。只生成构建产物，不改写受版本控制的源码文件。

# 实施与验收

1. [x] 接入 CLI workspace build，生成静态元数据并接入版本输出。
2. [x] 补充 clean/dirty/无 Git 来源、不同 cwd 的 CLI 输出与安装包验证。
3. [x] 构建、类型、lint、16 项相关回归、隔离发行包验证及本机安装通过，见 [记录](../../journal/shared/2026-10-15-cli-build-commit.md)。

交付按会话授权，仅提交并推送本需求差异；保留工作树已有修改。本地安装使用重新编译的发行包。
