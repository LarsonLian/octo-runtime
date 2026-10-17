---
type: Journal
title: Channel Gateway 连接状态机实施与真实环境验收
description: 记录五态实现、固定退避、重复连接踢旧及真实桌面状态验收，并保留合盖待验边界。
tags: [channel, extra, lifecycle, testing]
timestamp: 2026-10-16T00:00:00Z
---

# Channel Gateway 连接状态机实施与真实环境验收

对应[开发计划](../../tasks/channel-connection-state-machine/brief.md)。用户于 2026-10-16 授权实施；以下验证发生在北京时间 02:00 至 02:50 之间。代码已落入共享工作树，未为本任务创建提交；核查时 Runtime HEAD 为 `4a79d87`，Work App HEAD 为 `005f24b`，两者均包含其他并行工作，HEAD 不是本任务独立交付 commit。实际证据对应本记录引用的源码和当时构建产物。

## 实施结果

- 每 Bot 使用 stopped / connecting / online / retrying / failed 五态；只有 online 输出 connected=true 和 error=null。首次 start 任一步失败终止自动尝试，显式重新启动重新按首次规则执行。
- 当前启动周期完整上线后，暂态断线立即进入 retrying。失败及旧资源释放后依次等 5/10/20/30/30 秒，恢复尝试期间不变 connecting；每次完整成功清错误并重置计数。
- [ImRuntime](../../../packages/octo-runtime-extra-channel-gateway/src/application/im-channel.ts) 负责资格、退避和转换，连接对象及取消信号隔离过期回调；先完成旧连接清理再安排等待。清理失败停止恢复并保留诊断。停止取消等待和在途尝试，迟到结果不能复活连接。
- [连接错误](../../../packages/octo-runtime-extra-channel-gateway/src/transport/connection-error.ts) 保留 HTTP 阶段和状态、网络/超时分类及 Retry-After；响应体中断仍为网络错误，非法 JSON 为终端错误。非预期错误只输出稳定码，不输出任意响应正文、URL 或凭据。
- [WuKong 传输](../../../packages/octo-runtime-extra-channel-gateway/src/transport/wukong.ts) 保留握手及断开 reason，心跳超时为可恢复异常；服务端明确拒绝或协议错误为终端失败。同包握手成功后立即被踢不能返回健康连接，挂起 send 会随断线结束。
- Provider/卡片/投递诊断继续走 onDiagnostic，不再覆盖连接 error；重连不重新 invoke 任务，不把上线当作旧投递已成功。
- [Work App 设置](../../../../octo-work-app/src/renderer/src/settings/ImChannelsSettings.tsx) 接入失败文案，保留旧状态显示兼容，只标 online 为健康；每 3 秒轮询，窗口处于后台仍刷新。main 保持插件状态及错误透传。未增加宿主重连机器或第二个 preload 桥。
- README、INTEGRATION 和渠道规则同步说明启动、恢复及 loaded/online 的区别。Run=7 与 Context=v3 不变，未修改或部署 Worker。

## 自动化证据

执行 Runtime `pnpm typecheck`（包含完整 build）、`pnpm lint`、`pnpm lint:names`；均通过。构建后执行与 `pnpm test` 相同的全量 Node 测试命令：

```sh
node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js
```

最终全量 873 项：866 通过、7 跳过、0 失败，耗时 33.7 秒。新增[状态机专项](../../../test/im-connection-state-machine.test.js) 23 项全部通过，覆盖首次失败、两轮退避及重置、显式重启、并发 start、启动/恢复中停止、旧回调、清理顺序及失败、超长 Retry-After 分段等待、迟到唤醒不补发、多 Bot 状态、实际 HTTP/WS fixture、心跳超时、挂起 send、短拒绝帧及同包踢线、错误脱敏和响应体中断。

Work App `pnpm build:test`（含 tsc）通过；最后一次 `pnpm test` 为 194 文件通过、1 文件跳过，1624 测试通过、1 测试跳过。通道相关 UI/service 专项及窗口后台自动刷新的测试通过。

一次并行执行的桌面全量测试遇到 Runtime clean/build 暂时删除 dist，导致 runtime-core 导入失败；等待完整构建结束后顺序重跑通过。不是新增源码失败，后续不要并行执行依赖该 dist 的测试与清理构建。

两个仓库 `git diff --check` 通过，两个验收脚本 `node --check` 通过。本次 Runtime 源码、专项测试与验收脚本 Prettier 检查通过。OctoSpec 全仓 lint 最终通过：127 个 OKF 单元、20 条规则、888 个本地文件链接。

## im-test 真实连接与收发

固定使用 `https://im-test.deepminer.com.cn/api`，专用 QA Bot：orbtex-codex（`288zxxlbqsw6c4bd7ae_bot`）为连接测试，orbtex-codebuddy（`288zyjzasjbde21f02a_bot`）为探针发送者。凭据仅由[脚本](../../../scripts/verify-channel-connection-live.mjs) 从显式指定的受保护账户文件读取；只使用既有隔离 QA 群，不向普通聊天发消息。

真实鉴权、注册和加密 WS 建立后，仅终止测试进程自己持有的 socket，并在该进程阻断恢复鉴权请求。属于本地故障注入，不能称为服务端真实停机。

| 检查 | 实测结果 |
| --- | --- |
| 初次无效 token | failed / IM_AUTH_HTTP_401；观察 35 秒仅一次请求，无自动重试 |
| 完整上线 | online / null / true，鉴权、注册、WS 握手全部完成 |
| 连续恢复等待 | 5002 / 10003 / 20002 / 30003 / 30002 ms |
| 恢复成功 | online，连接错误清空 |
| 第二轮断线首档 | 5002 ms，再次恢复成功 |
| 恢复后真实收发 | 隔离群真实 mention 入站，仅一次受控 Host invoke，真实 WS 最终回复；message sync 解码 payload 后核对内容相同 |
| 停止后观察 | stopped / null；6 秒无新增鉴权或注册请求 |

收发使用确定性 Host 帧生成测试回复，验证连接、入站准入及投递链，不是新一次真实模型执行验收。初版验收脚本漏配 group_ids、随后又未解码 sync 的 Base64 payload，分别造成等待超时；修正脚本后整轮重跑通过，未放宽生产准入或修改生产 payload 协议。

## 相同 Bot 重复连接

在同一个专用 Bot 上直接使用当前注册函数和 WuKong 客户端建立第二连接，未设置 force_refresh、未添加任何抢占参数。第二次注册及握手成功；旧 Bot 随即收到 reason=12，状态变为 failed / IM_SERVER_DISCONNECTED_12 / false。

结论限于本环境本次实测：服务端允许第二连接并踢旧，不是注册阶段拒绝第二连接。客户端保留终端原因并停止恢复，避免自动反抢；不提供跨机器锁。reason=12 的其他来源不能由这个样本推断，HTTP 占用业务 code/schema 仍无证据，因此未解析未知响应正文或把任意 409 解释为占用。终端通知后的零重试由自动化用例覆盖；真实重复连接后很快主动关闭，未再单独观察 35 秒。

## 真实桌面与双 Bot

构建并重新启动受影响应用；最终验证的本机 daemon PID 为 `68307`，启动于 02:42:01，晚于本轮网关产物构建。既有 Home、profile 和身份沿用，没有重建或清库。验证开始和结束的 daemon PID 相同，原有通道 ID 集合相同。

[CDP 验收脚本](../../../scripts/verify-channel-connection-renderer-live.mjs) 连接真实 Electron renderer（9222），断言根服务为 im-test。测试 Bot orbtex-claudecode（`288zyyqdci566e26e33_bot`）通过本地 HTTP/WS 代理访问真实服务；代理只在验收期间关闭该连接或返回受控 503。另一专用 Bot orbtex-opencode 直连 im-test，作为独立观察者。

- DOM 与后台同时核对 failed / IM_AUTH_HTTP_401、online、retrying / IM_DISCONNECTED、恢复后 online 且错误消失；失败、恢复中和成功均保存并人工查看截图。
- 窗口 hidden 时最初发现 React Query 暂停轮询，已加 refetchIntervalInBackground 并补 UI 用例；最终不用手动刷新即可观察恢复。展示仍为 3 秒轮询，非推送。
- 第一轮恢复首档 5050 ms，第二轮 5045 ms；停止后观察 11 秒无新增恢复请求。
- 故障 Bot 的初次失败、恢复等待、恢复成功、二次断线及停止后，观察 Bot 在检查点均为 online。配置保存仍遵循既有全 Extra 卸载/重载，不宣称配置更新时另一 Bot 完全无瞬断。
- renderer exception 数量为 0，新增测试通道全部删除，原有通道配置保留。测试截图位于 `/tmp/octo-connection-renderer/{failed,retrying,online}.png`，临时路径不是长期归档保证。

## 边界与状态

MacBook 实际合盖/唤醒未执行；超长等待、迟到计时器和心跳超时已用可控时钟验证，但不能替代系统休眠实测。真实 429、5xx、完整网络黑洞及服务端撤权没有在 im-test 人为触发，分类和取消按 HTTP/WS fixture 与状态机自动化验证。普通断网的状态变更始于传输检测，现有心跳 25 秒、无包阈值 90 秒，物理断网到检测之间存在延迟。

因此代码交付和已列自动化/真实环境验收完成；整体状态为 implemented-partially-validated，待实际合盖验证后才可标记全部验收。没有以旧计划或本记录授权删除/重建身份、配置或数据库。
