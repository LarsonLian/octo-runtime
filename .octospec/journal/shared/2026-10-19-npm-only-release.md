---
type: Journal
title: npm 单 registry 发布与稳定版 latest 修复
description: 记录线上 latest 修正、独立 worktree 的 CI 改动、GitHub Packages 清理交接和验证结果。
tags: [release, npm, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 目标与基线

关联[任务简报](../../tasks/npm-only-release/brief.md)。从最新 `origin/main`
`1505ce132bb0ae98afc3229a6eac6a7507849883` 建立独立 detached worktree
`octo-runtime-npm-only-release`；原工作区的未提交记录保持不动。

# 线上操作与清理

- 已将 npm 官方仓库 `@mininglamp-oss/octo-runtime` 的 `latest` 调整为 `1.0.1`。
  随后匿名读取官方 dist-tags API，确认 `latest: 1.0.1`、`next: 1.0.0-rc1`。
- 原发布运行中 npm 上传已成功，故障位于 latest 协调器查询 GitHub Packages 后解析空 JSON，
  不应将此故障归因于 npm token。移除该 registry 的全部运行时依赖。
- GitHub API 清理尝试因当前登录缺少 `read:packages` 返回 403；未扩权、未删除其他包。
  用户随后明确告知已手动删除 GitHub Packages；本次记录以用户确认为准，未独立核验删除结果。

# 实现

- 发布 workflow 移除双 registry matrix、GitHub Packages token、权限和认证配置，
  唯一上传目标为 `https://registry.npmjs.org`，继续直接发布与生成 provenance。
- 同版本恢复只读取官方 npm 归档，保留 SHA512、clean commit 与原构建时间验证。
- latest 协调器只读取 npm registry 和 GitHub Release 附件，完整稳定版本自动推进 latest；
  RC 不进入候选集，旧版本恢复不回退，dry-run 不写远端。空或无效 npm JSON 明确报错。
- GitHub Release 保留为附件交付，不是另一个 npm registry；晋升前核对附件和 npm 的完整 SHA512。
- 同步发行规则、CI 说明与部署指南；历史双 registry 任务记录保留，不改写历史。

# 验证

- 六个相关 Node 测试文件共 40 项通过，覆盖 latest 推进、RC 排除、不回退、恢复、完整性、
  单 registry、鉴权和网络错误、有界可见性等待、发行清单、构建信息及 Windows 发行辅助逻辑。
- 已执行改动文件的 Prettier 格式化，`git diff --check` 通过。
- 两个修改的 workflow YAML 解析通过；通过 `uv --with pyyaml` 临时运行 OKF 检查，
  检查报告既有文档指向未放入当前目录结构的兄弟仓库，未改动这些无关链接。
- 使用空 npm 用户配置与独立全局配置路径，对真实 npm 和 GitHub Release 执行只读协调，
  下载 `v1.0.1` Release 附件并完成 SHA512 比对，结果为
  `{"target":"1.0.1","relation":"equal","attempts":1,"actions":[]}`，没有远端写入。
- 上述本地验证阶段未触发线上 CI、未新建发布版本、未提交或推送。

# 远端交付授权

用户后续授权将本 worktree 创建为 `fix/npm-only-release` 分支，提交、推送、创建 PR，
在检查通过后合并进入 main。保留配置的 Git 作者及 Codex 协作 trailer；合并不创建发行 tag，
不发布新 npm 版本。远端检查和合并结果以 PR 与 main 的实际状态核验，不把本地测试当作远端结果。
