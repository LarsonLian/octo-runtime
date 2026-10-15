---
type: Task
title: 单一 Runtime 开源包的 GitHub CI
description: 对齐 Mininglamp-OSS 现有项目的检查、安全扫描与发行流程。
tags: [ci, testing, release]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与范围

只修改 octo-runtime，参考本机 octo-cli、cc-channel-octo 的 GitHub 工作流，并通过 GitHub API 核对组织 v1 复用合同。保留单一 npm 发行包，内部 workspace 不独立发布。其他工作树改动、Runtime 身份和进程不属于本任务。

CI 使用 Node 24 与 packageManager 固定的 pnpm，冻结 lockfile，在 Linux/macOS 检查 lint、命名、类型、构建、自动化测试与发行包离线安装。GitHub Release 使用组织的同提交 CI 证据门禁；npm 发布显式手动触发、默认 dry-run，校验稳定 tag、main 归属与版本，重新验证精确 SHA，再上传同一份 tgz，启用 provenance。

## 验收

用户后续明确许可证参考 octo-cli：采用 Apache-2.0，版权方沿用 Mininglamp Technology，Runtime 声明年份使用 2026。补充根许可证、包元数据及源码/发行 README，打包缺失 LICENSE 时失败，安装验证核对许可证正文与元数据。保留第三方许可证。

- 工作流静态检查通过，组织复用工作流及输入已核对。
- 本机执行 CI 对应命令，失败如实记录，不改动无关业务实现来掩盖失败。
- 检查发行物元数据与离线安装；不发布 npm、不推送、不创建远端仓库。
- 本次不修改 UI、线上接口或 Run/Context 协议；不以本机检查冒充 GitHub runner 或线上联调证据。
