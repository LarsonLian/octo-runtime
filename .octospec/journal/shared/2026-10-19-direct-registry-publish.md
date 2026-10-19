---
type: Journal
title: 稳定 tag 直接发布双 registry
description: npm 与 GitHub Packages 同归档直发、部分恢复及三端 latest 一致性实现。
tags: [release, npm, github, testing]
timestamp: 2026-10-19T00:00:00Z
---

# 实施

从最新 main `6fee2e1` 建立独立 worktree，实现 [任务合同](../../tasks/direct-registry-publish/brief.md)。
保留源码 `0.0.0`、稳定 annotated tag 注入及完整 CI 矩阵；唯一验证归档直接 `npm publish`
到 npmjs 和 GitHub Packages，不调用 stage/approve/reject。Release 使用相同归档。

两个 registry 独立 matrix job，按 registry 与 tag 隔离发布并发，不相互取消。npm 使用
`NPM_TOKEN` 和 provenance；GitHub Packages 使用仓库 token 和 packages 权限，关闭 npm
provenance。已有版本按完整 SHA-512 跳过；仅 E404 允许按缺包处理，上传后最多等待 20 分钟。
部分交付恢复从任一 registry 验证源码并复用已发布 buildTime。

promotion 从三端现状选取最高完整稳定版，把所有 latest 作为不可回退下界。GitHub Packages
版本交集、完整 SHA-512 和 Release 附件实际字节都参与判定，dry-run 保持远端零写入。

# 评审修复

- 统一发布检查和 promotion 的 registry 错误分类及完整 SHA-512 读取，拒绝两端相同无效摘要。
- GitHub Packages 查询 package metadata 的 `versions[version]`，不依赖不支持的版本路径。
  校验 package 身份、版本表和目标值结构，只有有效版本表缺少目标键才视为缺版本。
- 追加 GitHub npmrc 认证前显式换行，兼容 setup-node 生成的无尾换行配置。
- 实际下载 Release 附件并核对摘要，拒绝同名空附件；临时目录总是清理，下载有超时。

# 验证边界

- 本地 38 项发行相关测试通过；覆盖双 registry、404/鉴权/网络、公开等待、超时、恢复元数据、
  三端 latest 防回退、无效摘要、空 Release 附件及无尾换行 npmrc。
- actionlint v1.7.12（不启用本机未安装的 shellcheck）、变更文件 Prettier、命名检查及
  `git diff --check` 通过；workflow YAML 可解析且没有重复键。
- Standards 与 Spec 分别评审；发现的摘要校验、端点、认证换行、附件内容及无效 metadata
  问题均已修复，最终剩余发现分别为 0、0。
- PR #35 首轮远端 shellcheck 指出字面 npmrc 环境变量的单引号写法；改用显式转义的双引号，
  并直接执行 workflow 中实际的追加命令验证：保留换行，且 token 值不写入配置文件。

不创建或移动 tag，不真实发布包，不修改组织策略、package 可见性或 registry 暂存状态。
本地测试不能替代合并后新 tag 的真实双 registry 发布验收。全仓 OKF lint 的现存跨仓库相对
链接在隔离 worktree 下失效；未修改这些历史文件，规则 frontmatter 与索引没有报告错误。
