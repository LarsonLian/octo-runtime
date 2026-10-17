---
type: Task
title: Tag 驱动的单一 npm 发行物
description: 以受校验的稳定版本 tag 生成唯一公开包，内部 workspace 随根包捆绑且禁止独立发布。
tags: [installation, release, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 目标

对外只发布 `@mininglamp-oss/octo-runtime`，由根包提供 `octo-runtime` 和
`octo-runtime-daemon` 命令。推送符合严格稳定版 SemVer 的 annotated tag 后，GitHub
Actions 对 tag 指向的 `main` 提交重新构建、测试、生成单一 tgz、发布 npm，并创建带同一
tgz 的 GitHub Release。

源码清单不是发行版本来源：根清单和所有内部 workspace 使用非发行占位版本
`0.0.0`。发行版本唯一来自 tag；打包脚本将 tag 版本写入生成包根清单和所有被捆绑的内部
workspace 清单。内部 workspace 全部 `private: true`，不进入 npm registry，生产依赖通过
`bundleDependencies` 实体化进根发行包。

## 关键合同

- **版本归属：** `vX.Y.Z` tag 是唯一发行版本，工作流内执行严格 SemVer 校验；生成包版本
  必须等于去掉 `v` 的 tag。`v0.0.0` 被明确禁止，源码占位版本不得被误当成发行版本。
- **来源归属：** tag 必须指向 `main` 历史中的 commit。构建元数据保留完整 commit；正式
  发行必须满足 `build-info.commit == tag commit` 且 `dirty == false`。
- **单包边界：** `apps/*` 和 `packages/*` 只参与源码构建或根包捆绑，全部禁止独立发布。
  根包的 `bin` 继续指向随 tgz 携带的 CLI/daemon 构建产物；`private` 不改变命令可执行性。
- **发布门禁：** npm 发布只消费同一次精确 tag 验证生成的 artifact。构建、静态检查、测试、
  离线安装、公开入口和真实全局命令验证任一失败都不得发布。
- **重试行为：** npm 已存在同版本时不尝试覆盖不可变版本；工作流继续核对 registry 版本并
  可补齐 GitHub Release。不同 tag 使用独立并发键，同 tag 不并发发布。
- **触发方式：** 稳定版 tag push 自动启动正式发布；手工入口统一位于 `Release Publish`，只能
  对已存在 tag 选择 dry-run 或同 tag 故障恢复，不能形成仅发布 npm 的第二条正式路径。普通
  PR、`main` push 和手工 CI 仍生成 `0.0.0` 测试包，不发布。

本任务属于 Runtime 发行基础设施，不改变产品行为、Provider 选择、Agent 输入、Runtime Home、
身份、profile 或 Extra 配置。发布流程只忠实使用维护者显式创建的 tag，不替产品或调用方增加
运行时默认策略。

## 范围外

- 不独立发布任何 `@mininglamp-oss/octo-runtime-*` workspace 包。
- 不改变公开 `/extra`、`/protocol` API、CLI 命令合同或 daemon 生命周期。
- 不自动安装 Provider，不迁移或覆盖用户 Home。
- 本次不引入预发布 tag；自动发布仅接受 `vX.Y.Z`。预发布版本和 npm `next` 另行设计。
- npm/GitHub 凭据、组织权限和 tag 保护由仓库管理员配置，凭据不进入仓库或验证记录。

## 验收

- 源码根清单为 `0.0.0`；所有 `apps/*`、`packages/*` 清单均为 `0.0.0` 且
  `private: true`，自动测试防止回退。
- `pack-release.mjs --version 1.2.3` 只在临时目录生成
  `mininglamp-oss-octo-runtime-1.2.3.tgz`，不改写源码工作树；生成根清单及内部 workspace
  清单版本均为 `1.2.3`，不存在 `workspace:`、`link:` 或 `file:` 依赖。
- 发行 tgz 离线全局安装后，`octo-runtime --help`、`octo-runtime --version`、全局
  `octo-runtime-daemon` 启动、公开 TypeScript 入口和内置 Extra 验证通过；版本为 tag 版本，
  commit 为 tag commit，且不带 dirty 标记。
- tag 工作流拒绝格式错误、非 `main` 历史、源码模板不合规或构建证据不一致的发行。
- npm 首次发布使用 public access 和 provenance；同版本重跑不覆盖 npm 版本，并能恢复或补齐
  GitHub Release。
- 运行 `pnpm lint`、`pnpm lint:names`、`pnpm format:check`、`pnpm typecheck`、`pnpm test`、
  动态版本打包及离线发行验证；检查 OKF、workflow 和补丁格式。
