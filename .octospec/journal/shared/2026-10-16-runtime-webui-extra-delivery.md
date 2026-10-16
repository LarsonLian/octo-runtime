---
type: Journal
title: 本地 WebUI Extra 实施与验证
description: 删除 SSE demo，移植 Work App 展示组件，交付本地项目与有界会话工作台。
tags: [extra, stream, workspace, interaction, adapter, testing]
timestamp: 2026-10-16T04:00:00Z
---

# 本地 WebUI Extra 实施

用户在[计划](../../tasks/runtime-webui-extra/brief.md)后授权直接在当前分支实施。新增 [WebUI 包](../../../packages/octo-runtime-webui-extra/README.md)，删除旧 SSE demo 的源码、生产依赖、专属测试和验证脚本。当前配置指南已替换；用户已有声明、Runtime Home、身份、profile、Provider 原生会话与项目文件未删除或重新初始化。

## 实现与边界

- Extra 名称 `webui`，仅监听 `127.0.0.1:13888`。SDK 显式加载；CLI 保存完整声明后按原有 daemon 启动流程加载。CLI 没有单插件 load/unload 命令。
- React、Markdown、图标和样式仅在此包构建，输出 `dist/web`。服务端只有 protocol 生产依赖，daemon 是类型依赖；未向 SDK 增加 React 运行依赖。
- 共享 `ExtraAdapterHost` 仅新增可选只读 `list()`，复用既有 Host 实现。缺少端口返回明确错误，不扫描默认配置、不创建第二套执行内核、不安装 Provider。
- 后端提供本地页面、目录、会话、invoke、cancel 与 respond API；校验 loopback Host、同源 Origin、HttpOnly/SameSite cookie、页面 token。canonical SSE 原样传递，使用 Node pipeline 背压，断线和卸载传递中止信号。
- 统一 `InvokeInput` 和 Context v3，Run=7 未变。模型只收到本轮 inputs；执行项不变成模型背景，不从历史补上下文。session.update 的完整 opaque Provider binding 由前端被动保存并原样续接。
- 默认真实目录为 `~/octo-runtime-workspace`。其他项目使用服务端目录选择器，项目/选择/文本草稿/自定义模型保存在 sessionStorage。已有会话固定 cwd，执行前重验目录。
- WebUI JSON 最多 100 条，创建第 101 条时淘汰最旧非活动记录；revision 拒绝旧写入，删除后不可通过 PATCH 复活。串行修改、0600 临时文件原子替换，总文件上限 32 MiB。单条/全部清理仅作用于 WebUI 记录，等待自身在途请求清理。
- 并发上限后端 4 个、同会话 1 个；单浏览器入口一次执行。可切换会话视图，流和 checkpoint 仍绑定原会话。刷新旧在途消息标记 disconnected，不自动重发，旧审批不可操作。

## 移植证据

来源基线为 Work App `8ba43327bc4d6eedd29bf6305f9e8e968d10cd45` 及复制时工作树。来源仓库在实施期间有其他任务更新，不把后来的 HEAD 当作复制证明。逐文件来源、实际差异和保留内容见 [porting-map](../../../packages/octo-runtime-webui-extra/porting-map.md)。Runtime 实施期间基线推进到 `56f201f`，未回退其他任务改动。

Transcript、过程分组、工具展示、计时、RawRunPresentation、reducer、ModelPicker、ApprovalPolicyPicker、ApprovalCards、Popover 与 ConversationComposer 使用原实现或最小宿主接口替换。历史消息使用原 scroller 分页；本页新轮持续使用 live 渲染，完成时不切换渲染树，保留手动展开身份。仅在 HTTP/目录/本地 JSON 与浏览器组合层接线。batcher 原文件保留，当前接线使用完整 snapshot，未接增量合帧。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过，包含整仓 build 与根 tsc；浏览器另有独立 tsc |
| `pnpm lint` | 通过 |
| 完整 Node suite | 935 项，927 通过，8 跳过，0 失败；最后新增的损坏文件/端口状态用例另跑 |
| `node --test test/webui-extra.test.js` | 4/4 通过：鉴权、真实 Host list 接线、101→100、revision、binding、清理、SSE 透明转发、交互归属、取消/卸载、CLI 配置、端口占用与损坏 JSON |
| `pnpm --filter @mininglamp-oss/octo-runtime-webui-extra test:ui` | 两份迁入测试 35/35 通过，包括 thinking/工具分组、手动展开保持、终态折叠、多 final、复制、失败/停止等 |
| 发行物 | `node scripts/pack-release.mjs` 生成 tgz；仓库外临时目录 offline npm install 后可独立导入 Extra 并服务 HTML/JS/CSS，无 React 生产安装、无旧 SSE demo |

打包有前端单 chunk 大于 500 kB 的提示，当前 JS gzip 约 262 kB、CSS gzip 约 34 kB；不影响类型、构建或安装结果。依赖仅在浏览器打开页面后加载。

## 真实页面与 Provider

Playwright 使用本机 Chrome，实际驱动 `13888` 页面，未用 fake Provider 代替下列结果：

1. Codex 连续两轮文本：首轮保存 marker，刷新后从 JSON 重新打开，第二轮回答同一 marker，真实 Provider binding 保持相同。
2. 默认目录与 `/private/tmp` 目录选择、跨项目草稿、刷新恢复草稿通过。运行中切到新会话，原会话继续；重新打开回到原流。
3. 真实 Codex 工具轮 `32c5c506-daf4-468f-9f03-d23f33f9c7f7`：页面点击“允许一次”，interaction 最终 resolved；exec_command 执行 pwd/printf，exitCode=0，工具输出及最终答复包含项目路径和 `WEBUI_TOOL_OK`，assistant completed。
4. 真实停止轮：点击“停止执行”后收到取消终态，JSON 中 assistant.status 为 stopped。最初脚本误等 DOM cancelled 超时；原 reducer 的展示状态实际叫 stopped，数据核对后修正测试断言。
5. 桌面 1440×1000、手机 390×844，模型浮层可打开/关闭，过程 fold 的 aria-expanded 可切换；无页面异常及根横向溢出。手机 composer x=12、width=366，模型浮层 x=9、width=296。

一次工具测试未处理审批，等到真实 watchdog 超时；保留为失败记录，不将出现工具行算作成功。后续增加允许审批及检查 assistant completed、工具 exitCode/output 的断言后通过。

截图保存于本地忽略目录 `.impeccable/review/{desktop.png,desktop-model.png,mobile.png}`。独立 finish reviewer 对 composer 宽度与耗时证据两项修复均判 resolved、可交付；documenter 核对来源映射，没有新增或改写设计系统。检测提示为继承样式的过渡及活动文字效果，按用户要求保留原体验。

## 在线环境与限制

实际请求 `https://im-test.deepminer.com.cn/health`、`/agentworker/health`、`/agentworker/health/ready` 与 `/agentworker/api/v1/runtimes`，均返回 HTTP 200、Content-Type text/html 和 SPA shell。不能把它们当作 Worker 健康或 API 成功。

另通过新启动 WebUI 的真实 Codex 工具执行 curl 请求同一 im-test `/health`：默认 ask 沙箱下 DNS 失败，工具 exitCode=6，页面如实显示；为只读联网验证显式选择页面原版“完全访问”并确认后，同一会话重试得到工具 exitCode=0、输出 `200 text/html`，真实 Provider binding 保持一致。随后另建一轮点击停止，页面进入 stopped；此轮 Playwright 完整断言通过。权限选择只作用于该页面构造的执行请求，没有改写 Provider 配置。

最初将 WebUI 动态挂到已有 Work App daemon，真实 Adapter 与两轮恢复使用同一共享 Host。后续该桌面进程停止，WebUI 随之关闭；重新使用独立验证宿主、显式 Codex 装配与同一 WebUI JSON 启动 13888，不修改 Runtime 身份或桌面配置。该验证启动脚本只位于本机 `/tmp`，不是产品默认配置或自动启用机制。

线上既有 Extra 连接共存、真实结构化问答和其他 Provider 的完整 UI 执行仍未验收；不宣称这些结果。当前默认/自定义模型 ID 来自本 WebUI 设置，未接 Work App 账号模型目录。会话文件不支持多个服务进程同时写入；项目偏好按当前浏览器 origin/sessionStorage 保存，不支持跨标签同步或多用户远程访问。极慢消费者压力与所有异常 fixture 的浏览器并排回放未单独覆盖。

最终 OKF lint 通过：147 个单元、20 条规则、1032 个本地链接；`git diff --check` 通过。未提交、推送或发布发行物。
