---
type: Record
title: executionFeatures 全量删除与自动验收交付
description: 记录逐 Feature 提交、独立评估、隔离验证、正式环境 renderer 和真实 Codex 执行证据。
tags: [adapter, architecture, testing, delivery]
timestamp: 2026-10-16T00:00:00Z
---

# 结果

本任务的源码修复和可自动执行的验收已完成，各 Feature 分别提交并推送至三个仓库的 `origin/main`。Runtime 不再定义或消费 `executionFeatures`，不维护 react 业务能力标签，不输出空标签数组作为替代。HostApp 决定使用哪些 Adapter 功能；Adapter 执行真实输入、原生协议和交互合同。Provider 原生握手、执行身份、权限、来源和输入检查继续存在。

Run=7、Context=v3、Adapter transport=2 保持独立。未重建身份、Home、profile、SQLite 或用户配置；未发布 Worker 服务、修改真实 Runtime 登记或发送外部 IM 消息。用户将联调目标改为正式环境 `https://im.deepminer.com.cn`，并选择只完成可自动验证部分；Work App 文档与默认配置已同步。

## 独立评估与提交

原始准备度评分是历史记录；修订后的八项独立评估均分 97.125，最低 96。新增基线问题 F10 为97，F11/F12 为98，均先评估再实施，见[计划](autonomous-plan.md)和[独立报告](feasibility-review.md)。评分表示方案可执行性，不是测试通过率。

| Feature | 仓库与提交 | 最终行为 |
| --- | --- | --- |
| F4 | Runtime `69341da` | 删除 computer-use 标签专用配置探测 |
| F6 | Worker `8a7d330` | 删除字段、标签准入及旧执行计划字段；保留实际来源、可用性、权限和租约检查 |
| F10 | Work App `8e40620` | 移除已退役场景引用，修复问答翻译归属及测试 DOM 环境 |
| F5 | Work App `947095c` | 宿主私有产品策略决定引擎与审批选项，不读取 Runtime 标签 |
| F2 | Runtime `b31dafb` | Host 使用实际 responder；具体 Adapter 编码或拒绝输入 |
| F3 | Runtime `83d7ae5` | watchdog 按真实原生活动切换，修复审批暂停和 MCP 工具进度 |
| F11 | Work App `b499046` | README 使用正式域名；配置、AGENTS 与 prod 启动命令沿用已提交的 `5d69cd3` |
| F8 | Runtime `abb3ade` | MCP 仅提交本轮窄覆盖，原生同名连接在会话/输入前明确拒绝 |
| F9 | Runtime `3af977a` | 配置字段名不再误判为超时，保留真实超时与协议错误优先级 |
| F1 | Runtime `439a800` | 删除类型、常量、转换 helper、默认数组、加载要求和发现投影 |
| F12 | Work App `c7d084c` | 三份测试桩同步已提交的本机项目与无标签 SDK 合同 |
| F7 | 本记录所在提交 | 发行包、三仓检查、真实 renderer/Provider 验收及边界记录 |

Work App 的[AGENTS.md](../../../../octo-work-app/AGENTS.md)明确覆盖上级旧 im-test 要求；[README 配置说明](../../../../octo-work-app/README.md#运行时配置)解释三个服务地址的派生、prod 启动和显式覆盖。未把其他任务的个人工作区、插件或服务拆分改动混入本任务提交。

## 隔离验证

每个产品提交在独立生态快照中验证，内部依赖使用已提交版本，不链接主脏工作树的可变源码/dist。混合文件只暂存本任务 blob；提交 tree 与受测 tree 一致。

| 提交 | 受测 tree |
| --- | --- |
| Worker F6 `8a7d330` | `ae404e51283e9f25de5633444f8464c34bcd29bf` |
| Work App F10 `8e40620` | `4ddf13383ffaccb85ed3757db13abfe1e02dd681` |
| Work App F5 `947095c` | `23f639053019c5b7baff07b1693db9e33296e855` |
| Runtime F2 `b31dafb` | `fe3fd314527a49e4f03cfabb0e6bcf76baacfdc6` |
| Runtime F3 `83d7ae5` | `fab64ed3c0e8c6763e53cd54867cb2988bcf4c4e` |
| Work App F11 `b499046` | `e6c67fb29592242af527da2af4da0f7605b9e353` |
| Runtime F8 `abb3ade` | `2d83d904d5594d51044bf0605db62e1e6c586b4f` |
| Runtime F9 `3af977a` | `6beff6ba6dbdeee3723358a594235da2a4ffee2b` |
| Runtime F1 `439a800` | `95c90837fc127041468ea4cb81082014fc8f58fa` |
| Work App F12 `c7d084c` | `671a6e47f8d71f348a4a2b65dc301bdba59f36bf` |

最终 Runtime 基线为 `439a800`：typecheck（包含全量 build）、lint、lint:names 通过；Node 全量1009项，1001通过、8跳过；WebUI另35项通过。新回归覆盖12个内置 Adapter、无字段 JSON loader 和 SDK 执行、发现/重启及 Node/browser 导出不存在。协议旧字段拒绝 fixture、历史记录和字段不存在断言仍保留。

最终 Work App 基线为 `c7d084c`，依赖 Runtime `439a800`：typecheck:all、test:all、build:prod 通过。主测试1615通过、1跳过；各 kit 共940通过、1跳过。F12相关三文件31项通过，未删断言或放宽计数公式。

Worker `8a7d330`：`go test ./...` 与 `go build ./cmd/server ./cmd/migrate` 通过。OpenAPI生成命令可执行，但基线生成结果另有大范围既存漂移；本任务只同步三个删除的执行计划字段，未声称全量 OpenAPI 干净差异检查通过，也未接管并行服务拆分。

## 发行包

由干净 `439a800` 源码对应的构建产物生成 `dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`，build-info 为该提交、dirty=false。先完成 build，再运行已有 pack 脚本和 `scripts/verify-release.mjs` 的离线模式；未运行其旧 im-test live 分支。

空缓存离线安装、全局 CLI、SDK Host启动及12个 Adapter 发现、无两个旧字段、公开协议无旧导出、外部 Extra 编译加载、私有入口隔离均通过。卸载移除包并保留本次测试 Home。切换快照基线时遗留的旧 SSE workspace 只有 node_modules，已仅在本任务临时快照清理后打包，未删除用户工作区或 Runtime 状态。

本次产物位于临时生态的 `octo-runtime/dist/release/`；该发行包尚未发布到包仓库。

## 正式环境与真实执行

2026-10-16，正式根站 `/`、Worker `/agentworker/health`、`/agentworker/health/ready` 均返回200。这只是只读可达性证据，不代表远端已部署本次源码。

隔离桌面 QA 在最终构建后完整重启 main/renderer/daemon/Host，使用独立 CDP 9224 及原有 QA Home/userData。真实 renderer 返回正式 serverUrl 和 `/agentworker/api`；Host running且ready，12个 Adapter均无旧字段，默认Codex、单一模型入口、三种审批菜单，未见 alert 或项目加载失败。仅验证现有可自动使用的状态，没有要求用户再登录或复制凭据。验证后停止本任务启动的 QA 进程，保留其数据。

真实 Codex 通过 Host 完成：纯文本精确标记、仅凭图片像素识别红色圆形、ask下收到审批并接受无副作用命令后取得标记、原生turn已启动后取消并收到唯一cancelled终态。四轮使用已登记 trusted 项目，Home config摘要前后均一致。

真实 MCP 在同一可信项目加载既有 Home 配置与本轮唯一 stdio server，收到initialize/tools/list/tools/call。仅对固定健康工具对应的同server空form确认返回accepted；工具GET正式Worker ready返回200，模型回显匹配随机marker，run.completed，Home config摘要未变。

首轮 MCP 验证曾在新临时工作目录触发 Codex 原生 trust_level 记录，且未响应原生elicitation而超时。后续使用既有可信项目并按固定工具范围完成确认后通过；未恢复或删除原生记录，未将早先失败写成成功，也未修改产品来自动批准其他交互。

本机验证日志：`/tmp/octo-features-f1-*.log`、`/tmp/octo-features-f12-*.log`、`/tmp/octo-features-f7-*.log`、`/tmp/octo-features-f8-live-final.log`。真实 Provider 的审批与取消为受控本机任务，不发送外部聊天。

## 验收边界

仅真实 Codex 的上述路径记为实机通过；其他 Provider、原生 HTTP MCP、三图原生顺序和 opt-in GC 等未启用用例仍按各自 skip 门槛处理，不扩大为真实验收。默认Node测试中的8项skip未隐藏或移除。

Worker 源码已提交推送，但远端部署与登记迁移不在本任务授权内，未修改真实 Runtime 注册数据；实际发布仍须先更新消费者再切换无字段生产者。当前 SDK 没有 Worker注册工厂，本任务未新增该链路。也未向生产 IM 会话发送测试消息。
