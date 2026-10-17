---
type: Journal
title: actmode 首批三个 Adapter 实施与真实验证
description: Codex、Claude Code 与 OpenCode ACP 的显式模式映射、真实问答及验证限制。
tags: [adapter, protocol, testing]
timestamp: 2026-10-16T00:00:00Z
---

# actmode 首批交付

按[任务](../../tasks/adapter-plan-interaction-exploration/brief.md)实施 Context `octo.context-envelope/v3` 的 `octo.execution/actmode`，payload 为 `{mode:"default"|"plan"}`，Run 保持 7。同步 Schema、生成类型、严格校验、catalog、fixture、defaults/mandatory 解析及冻结执行计划。execution item 不进入模型文本。

Runtime 只消费本轮解析结果，不推断模式、不在省略时补值、不管理产品偏好或会话策略。宿主继续决定 sessionId 与显式模式；没有改 Channel Gateway 输入，也没有恢复已撤回的 Codex 私有开关。没有修改身份、Home、profile、全局 Provider 配置或安装状态。

| Adapter / 实测版本 | 原生映射 | 真实验证 |
| --- | --- | --- |
| Codex 0.154.0 | 读取 collaborationMode/list，turn/start 携带 mode 与实际模型设置 | Plan、同 session 显式 default、同 session 省略均完成；Work App Plan 完成并保存 applied 事件 |
| Claude Code 2.1.293 | permission-mode plan；system/init.permissionMode 作为应用证据 | 三轮完成；Work App Plan 完成。当前默认模型无权限，测试显式选择已授权 cpa/gpt-6.1-sol，验证的是 CC harness，不是 Anthropic 模型 |
| OpenCode 1.18.30，既有 ask/ACP 路径 | configOptions 的 mode；plan→plan，default→build；共享桥也支持旧 modes RPC | 单独三轮完成；Work App Plan 完成。重复三轮时 default 续聊一次达到 120 秒截止，不能宣称稳定性验收完成 |

canonical 返回 `execution.update`，native 返回 `evidence/execution`。applied、fallback、unknown 分开，未知值为 null；仅原生目录明确不支持可选 Plan 时降级普通模式，调用失败仍失败。模型输出、plan.updated 或接纳回执不作为已应用证据。

## 真实宿主证据

真实 Electron renderer 经 CDP 9222 驱动，已登录 `https://im-test.deepminer.com.cn`，内置 Runtime 注册与执行正常。Work App 三个测试 Run：

- Codex：`run_593d5a3f-8fc5-4db9-9b00-16ab963559c6`。
- CC：`run_decf04b3-d16a-4031-aad5-79aba6265ba0`。
- OpenCode ACP：`run_ffa974cc-9a11-4b81-9840-d4ee5ddf6f8c`。

三个均 completed、输出 MODE_PASS、user 消息数为 1。只读查询宿主 chat_run_events，三个均保存 requested=plan、effective=plan、status=applied、nativeMode=plan 的 execution.update。宿主脚本及截图见相邻 Work App `docs/validation/actmode-live/`。

Codex 原生 request_user_input 经显式通用 Plan Context 产生两题、四个选项和两个自由输入。第一题改选并补充文字、第二题只输入文字，原 Run `run_f0481916-5109-46bd-9ac5-2130738970a8` completed，逐字返回两题答案，user 数仍为 1。没有把答案拼成新聊天消息，没有执行部署或文件修改。CC / ACP 的提问 UI 未在本轮验收。

## 自动检查与限制

Runtime 全量构建、TypeScript 与 lint 通过；专项及相邻回归 340 项，336 通过、4 跳过。全量回归当时 905 项，893 通过、8 跳过、4 失败，均为并行修改中的旧日志路径/报错措辞断言；专项复跑同样失败，未修改其独立实现。Work App build:test 与测试通过：194 文件通过、1 跳过；1624 测试通过、1 跳过。Worker `go build -o /tmp/octo-actmode-worker ./cmd/server` 通过；未改 Worker 代码或部署线上服务。Work App 已重启并真实执行，保留运行中的测试实例。

修复真实 ACP 测试发现的 usage 帧含 model:undefined：仅实际存在时才加入该字段，避免非 JSON 值被 Host 拒绝；测试覆盖所有输出均可序列化。

Kimi / mcode 可发现模式并设置，但账户额度不足，未记完成。OpenCode 是本次实际可用 ACP Provider。原始重复测试结果保存在任务 live-results.json（含一次 OpenCode 超时）；成功的 OpenCode 三轮日志为本机 `/tmp/octo-actmode-opencode-live.log`。其他九家 Adapter、CC/ACP 原生问答、取消/过期/重启恢复及稳定性长测仍未验收。mode 与权限组合、旧消费者语义忽略的覆盖不应从此次三家成功扩大推断。
