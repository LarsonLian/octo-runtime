# Work App 移植边界

来源仓库：相邻 `octo-work-app`，基线 commit `8ba43327bc4d6eedd29bf6305f9e8e968d10cd45`。复制时包含该仓库工作树中的部分更新，不代表全部文件逐字等于该 commit；具体差异见下表。保留原文件中的中文、注释、样式和图标。没有重设计 thinking、工具分组或模型菜单。

| WebUI 文件 | Work App 来源 | 适配 |
| --- | --- | --- |
| `web/src/surfaces/Transcript.tsx`、`execution-process.ts`、`tool-presentation.ts` | `src/renderer/src/surfaces/` 同名文件 | 原样；图片读取经本地模块 bridge 的已载入 dataUrl 映射 |
| `TeamProgress.tsx`、`ExecutionExperience.tsx`、`ExecutionTimer.tsx`、`ActivityLabel.tsx` | 同目录同名文件 | 原样 |
| `ModelPicker.tsx`、`ApprovalPolicyPicker.tsx` | 同目录同名文件 | Picker 保留来源工作树的真实引擎图标、不可用引擎状态及四挡 effort 滑块；本地设置事件替代 Electron 设置导航。ApprovalPolicyPicker 与基线相同 |
| `ApprovalCards.tsx` | 同目录同名文件 | 只把 HostApp 的响应类型换成相同协议类型；响应经本地接口回到原 invocation |
| `TranscriptScroller.tsx` | `ConversationView.tsx` 的同名函数 | 提取函数，保留粘底、上滚、分页补偿和回到底部 |
| `web/src/shared/work-state.ts`、`experience.ts`、`presentation.ts` | `src/shared/` 同名文件 | 原样 reducer 与公开 exposure 过滤 |
| `web/src/shared/raw-presentation.ts` | `packages/agent-access-kit/src/client/raw-presentation.ts` | 原样；前端包装本地 canonical 事件，与 Work App `agent-conversation-service.ts` 的 `#project` 相同，并初始化本地 startedAt |
| `presentation-event-batcher.ts` | `src/renderer/src/features/workbench/` | 原样保留；当前采用完整 snapshot 更新，未额外引入增量合帧路径 |
| `web/src/components/` | `packages/ui-kit/src/react/` | 原样组件；注入本地翻译和 overlay Escape 栈 |
| `web/src/lib/{i18n,format,provider-icons,provider-names}.ts` | `src/renderer/src/lib/` | i18n 仅删除 Electron setNativeLocale 调用；provider-icons 来自来源工作树新增文件；format 与 provider-names 与基线相同 |
| `web/src/adapter-icons/`、`web/resources/locales/` | `packages/adapter-icons/src/`、`resources/locales/` | 图标目录来自来源工作树新增文件；翻译为复制时工作树快照，含引擎状态文案及 question 层级修正，并非基线原样目录 |
| `web/src/styles/_*.scss`、各 surface 样式 | Work App 同名样式 | 基线原样；例外是 run-context.scss 随来源工作树保留引擎图标、标签和状态布局更新。`webui.scss` 组合本地壳及响应式尺寸，给宿主 composer 增加 border-box |
| `web/test/conversation-*.test.ts` | `tests/conversation-process-group.test.ts`、`conversation-presentation-ui.test.ts` | 两份来源行为测试只更改本地 import 路径；保留原参数化用例与断言 |
| `web/src/shared/contracts.ts` | `src/shared/contracts.ts` 中组件所需声明 | AST 抽取，省略 Electron/业务服务合同；图片增加本地 dataUrl 持久化字段 |

`App.tsx` 是本 WebUI 的项目/session/HTTP 组合层。Composer 使用原 `ConversationComposer`、ModelPicker、ApprovalPolicyPicker 与 ApprovalCards，替换 Work App 的登录、项目服务、SQLite 和 IPC 接线。`lib/bridge.ts` 中的 `octoWork` 是普通模块对象，不读取任何宿主全局。

React 等依赖只用于此包构建；服务端只依赖 Runtime protocol，daemon 接口为 type-only。构建输出无需相邻仓库或浏览器 CDN。`scripts/sync-webui-source.mjs` 用于抽取需要裁剪的共享声明和 scroller，并同步脚本列出的组件；它读取相邻仓库当前工作树，不执行 checkout 或锁定来源 commit。其余文件按此表同步，不覆盖本地 HTTP 组合层；再次同步前应比对来源差异。

## 系统继承与证据边界

本次属于已有 Work App 体验的普通扩展，沿用其 tokens、组件和样式，不建立新的设计系统。2026-10-16 文档核对通过文件内容比较确认：Transcript、execution-process、tool-presentation、TeamProgress、ExecutionExperience、ExecutionTimer、ActivityLabel、ApprovalPolicyPicker、ConversationComposer、Popover、共享 reducer、raw-presentation 及 `_*.scss` 与上述基线一致。ApprovalCards 只替换响应类型 import，i18n 只去除原生 locale 桥调用，两份 conversation 测试只替换路径。

核对时 ModelPicker、run-context.scss、provider-icons 和全部 15 份 adapter-icons 文件与相邻 Work App 工作树一致。两份 locale 还与核对时工作树存在系统状态文案差异（WebUI 保留“内置运行时 / 即时通讯”，相邻仓库已改为“Adapter Host Daemon / IM”）；保留复制快照，不追随其他任务的后续更改。相邻仓库当前 HEAD 不作为本次复制来源证明。

本地壳负责真实目录、项目选择、会话列表及 HTTP/SSE 接线。默认监听 `127.0.0.1:13888`；会话存入宿主指定的有界 JSON 文件，项目、草稿与自定义模型列表使用浏览器 sessionStorage，配置和上限以 README 为准。模型管理打开本地设置，未移植 Work App 的登录、云端项目服务、SQLite 或 Electron IPC。图片读取通过本地模块 bridge 从当前会话已载入的 dataUrl 映射取得，不是独立图片下载接口。

以上为来源与实现边界核对，不等同于 Provider 执行成功证明。真实工具轮、审批响应及桌面/移动视口的运行结果应以当前任务最终验收记录为准；静态映射不扩大其验证范围。
