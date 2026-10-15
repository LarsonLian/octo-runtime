---
type: Journal
title: CLI 构建 commit 展示与本地安装验证
description: 构建时保存源码 Git 信息，离开仓库后仍可查看真实构建来源。
tags: [typescript, testing, runtime]
timestamp: 2026-10-15T00:00:00Z
---

# 实现

见 [需求与计划](../../tasks/cli-build-commit/brief.md)。CLI workspace build 在 TypeScript 编译后生成 `dist/build-info.json`；根 `pnpm build` 自动执行。静态文件记录完整 commit 与 dirty，版本命令和根帮助展示短 SHA。没有 Git 时显示 unknown，运行中不查询 Git，不改变语义版本或 Run/Context。

# 验证

- `pnpm typecheck`：workspace 构建、CLI 元数据生成和 TypeScript 检查通过。
- `pnpm lint`：通过。
- `node --test test/build-info.test.js test/cli.test.js test/cli-extra-directory.test.js test/cli-status.test.js`：16 项通过。覆盖无 Git、clean、未跟踪/已暂存修改、更新提交、从仓库外运行版本和帮助、daemon 与设备级 Extra。
- `node scripts/pack-release.mjs` 与 `node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`：通过；隔离空缓存离线安装后版本元数据保留，daemon ready，12 个 Adapter 可见；隔离卸载保留 Home。
- 本机执行 `npm install --global --offline --no-audit --no-fund <tarball>`，全局 CLI 的版本展示通过；安装来源为当前工作树的重新编译产物，未发布到 registry。
- OKF 格式与本地链接、Git 差异空白检查通过。

追加版本信息前，本轮已用安装后的全局 CLI 在临时 Home 完成 extraset/extraget、0600、拒绝 profile、daemon 启动、SSE Extra 加载、Bearer 拒绝和真实 Codex `run.completed` 验证。临时进程及 Home 已清理。线上测试环境及桌面执行链路证据见 [extras 验证记录](2026-10-15-cli-extras-directory.md)；本次版本信息变更没有修改外部接口或 UI。

保留用户既有 Home、profile 和 OpenClaw 配置，未安装自启服务，未重启桌面 Runtime。工作树存在其他未提交修改，构建显示 `(dirty)`，不把此构建声称为仅包含某个干净提交。
