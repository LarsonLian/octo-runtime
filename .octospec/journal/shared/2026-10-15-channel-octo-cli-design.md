---
type: Journal
title: Channel Gateway 的 Octo CLI 设计记录
description: 记录渠道工具环境的设计边界及本轮文档检查结果。
tags: [channel, envs, documentation]
timestamp: 2026-10-15T00:00:00Z
---

# 设计与检查

本轮依据用户确认的范围，补充 [渠道约束](../../rules/channel-integration.md)和[改造方案](../../tasks/channel-octo-cli-environment/brief.md)。gateway 用已验证连接的 Token 与 API 配置，为本轮 octo-cli 提供强制执行环境，不写入 Context；桌面 IPC 的身份选择与 envs 用法保留。

仅修改文档。`uv run --with pyyaml python .octospec/scripts/lint.py` 与 `git diff --check` 通过。系统 Python 缺少 PyYAML，因此使用仓库指南规定的 uv 命令完成校验。

内部覆盖传递、Provider 应用、自动化测试、im-test 真实 WS 与 octo-cli 验证尚未实施。本记录不证明运行时已支持该能力。

后续按用户明确决定补充 OpenClaw 例外：CLI 定位实例实际加载的 `.env`，只更新两个 OCTO 变量，同一文件后写覆盖前写，不拒绝多 Bot 共用；Gateway 重启由人工完成。该分支使用共享身份，不承诺按轮隔离。官方文档核对确认 `.env` 通常不覆盖已有进程变量；文件落盘与实际工具生效分别验收。未操作本机 OpenClaw 文件或服务。

## 当前分支实施结果

以上“尚未实施”描述设计阶段。随后用户授权开始实施并要求直接修改当前分支，本轮已完成：

- 普通 Adapter 从连接闭包取得已验证 Bot 的两个工具变量，以独立 executionEnvOverrides 传入 Core、Host RPC 和 Adapter SDK，不写入 Context、模型材料或渠道业务快照。RPC 使用新方法确保旧 Host 明确拒绝，日志不输出请求凭据。
- CLI daemon 启动编排根据已保存 OpenClaw 来源同步 `.env`，保留其他变量与注释，同一目标后写覆盖前写，原子保存并设为 `0600`。支持自定义配置与 state dir，远程 URL 来源不误写本地目录。没有修改真实 OpenClaw `.env`，没有重启 OpenClaw Gateway。
- 新增跨真实 Host 子进程、工具子进程、并发环境、Context 保持、旧 Host、dotenv 多 Bot/目录/重复写入和自定义路径测试。IM 加密 WS 回归检查独立覆盖值。架构守卫只对 CLI OpenClaw 准备增加 channel-gateway 依赖例外，通用 extraset 与 SDK 边界保持。

检查结果：Runtime build、typecheck、lint 通过；全量 751 项测试中 744 通过、7 项按开关跳过，无失败。额外启用真实 Codex app-server 测试，确认独立覆盖及同名优先级实际到达本地 stdio MCP。Worker `make build`、桌面 `pnpm build:test` 通过；桌面首次构建与 Runtime 清理 dist 同时发生导致模块解析失败，待 Runtime 构建完成后重新构建通过。

线上测试环境证据：从既有受保护测试配置读取 Bot 凭据，对 im-test 验证身份，实际 octo-cli 只读 user-info 请求成功，身份来源为 `env:OCTO_BOT_TOKEN`，实际 WS 建连成功。通过重启后的桌面内置 daemon/AdapterHost 发起真实 Codex Run，工具执行同一只读 octo-cli 请求并完成。未向 IM 用户发送测试消息。

已重启桌面开发进程、内置 daemon/AdapterHost 和既有独立测试 daemon/AdapterHost；未重置 Home、profile 或身份。CDP 驱动真实 renderer 确认 im-test、已登录、Runtime running、AdapterHost ready、存在原 Runtime ID 与可用引擎。独立测试 Home 的旧 OpenClaw 连接描述报 `connection_config_invalid`；保留原配置，没有迁移或重建它，Codex 路径正常。

剩余验证边界：尚未完成“真实入站 IM WS 消息触发本轮工具调用”的整条闭环；WS 回归与真实 WS 建连、真实内置 Runtime 工具执行分别验证。OpenClaw 只完成临时目录的落盘验收，真实实例需要人工重启后再验工具环境；不把文件写入或配置值一致视作 Gateway 已加载。
