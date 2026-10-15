---
type: Journal
title: IM 长任务与 Codex 有界重试实施验证
description: 一天默认时限、Extra 恢复边界、真实 Codex 故障注入及图标依赖移除。
tags: [channel, extra, adapter, testing, verification]
timestamp: 2026-10-15T00:00:00Z
---

# IM 长任务与 Codex 有界重试

## 已实施行为

按[任务方案](../../tasks/im-long-running-retry/brief.md)在当前分支实施：IM 默认 run_timeout_ms 从 120 秒改为一天，Bot 范围为 100..86400000 ms；工具无输出时限默认一天，显式 Context 限制仍有效。Host 的首帧与模型空闲保护保留。

Channel Gateway 的 ImTask 管理任务总期限、连续故障段与累计重试，Host 仍执行单次调用。默认连续 5 次、累计 20 次、连续恢复 120 秒，指数退避 2..30 秒加最多 20% 抖动，遵守 retryAfterMs。原生 retry_scheduled 计入相同预算，不发起并行 invoke；非空文本增量或工具完成结束连续故障段，usage 和重试提示不刷新。

明确的 Codex 暂态 failure（OH-PRV-4005/4006 且 retryable）在本轮工具或交互出现前可以新建尝试；先等源流结束，每次使用剩余任务期限、新 runId/invocationId 和原业务 Context。出现工具/交互后不自动重放，Host 断流按结果未知处理。Codex Adapter 将 codexErrorInfo 的结构化 HTTP/连接事实放入已有失败字段，保留原始错误，不新增协议版本。

一条 IM 请求保留单张进度卡、一个最终回复与有界尝试记录；失败尝试的半截文本不拼接到成功答案。取消跟随活动尝试，退避可停止；reset 停止后续尝试且不取消正在执行的调用。活动消息不因 120 秒去重 TTL 过期而重复执行，结束后刷新既有终态去重窗口。活动卡片绑定支持一天，结束后保留 30 分钟。

## 自动化与构建

- Runtime 全 workspace 构建、根 TypeScript 检查及 lint 通过。
- 全量 Node 回归 832 项：825 通过、7 跳过、0 失败。
- 新增任务与 Channel 专项 15 项通过：超过 120 秒、15 分钟静默工具、一天边界、显式短时限、剩余预算、冻结 Context、原生提示、连续/累计上限、白名单、未知流、工具/交互边界、Retry-After、取消、reset、单卡片与最终答案、在途及终态去重。
- Codex 结构化错误测试覆盖限流、不可用、连接/响应流错误、认证和额度；通过本机 app-server generate-ts 核对原生错误类型。
- OctoSpec 校验通过：104 个 OKF 单元、20 条规则、737 个本地文件链接。

## 真实调试

运行 scripts/verify-im-retry-live.mjs：im-test 首页返回 200，无效 Bot token 认证返回 401。真实 Codex 经独立 AdapterHost 进程调用，第一次仅替换进程上游为本地 503 服务，该服务实际收到 1 个请求；第一次失败为 OH-PRV-4006，Extra 发起第二次调用，真实模型返回随机标记且 run.completed。共 2 次尝试、1 次业务重试提示。

故障注入仅使用本次子进程配置，不修改用户 config.toml 或认证文件；第二次沿用既有真实 Provider 配置。只删除验收新建的临时工作目录。没有真实 IM 消息发送，没有删除或重新初始化既有 Runtime Home、身份、profile、配置或会话。

## 按用户要求移除图标依赖

移除 Runtime 的 adapter-icons 开发依赖、锁文件项及专属测试；同时移除 Work App 的该依赖、override、资源读取和品牌样式，已有位置使用 lucide 通用终端图标，名称由宿主维护。生态 README 不再要求构建图标项目。历史日志与旧 worktree 保留历史事实，不把它们作为当前构建依赖。

Work App 全量 Vitest 1618 项通过、1 项跳过；测试环境构建及 TypeScript 检查通过。CDP 驱动真实 renderer，在 im-test 已登录状态打开运行时设置，10 个引擎均有可见通用标识，0 破图、0 Runtime 异常；截图为 /tmp/octo-provider-marks.png。脚本为 Work App scripts/verify-provider-marks-live.mjs。主进程另有既有 Agent Access 项目接口 502 和 macOS 登录项权限错误，不能据此声称整个应用接口健康。

## 尚未验收

没有可用的 im-test Bot 凭据，未完成真实 IM 收发、卡片按钮和一整天持续运行。工具执行后安全恢复、Host 同 stream 续流及跨进程重启恢复未实施。没有远端部署或发布；重建源码不代表既有宿主正在使用最新代码。Run=7、Context=v3 保持。
