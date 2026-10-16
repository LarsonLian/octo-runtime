---
type: Task
title: 本地 WebUI Extra 替换 SSE Demo
description: 删除 SSE 示例，以完整相同的执行协议承载从 Work App 直接移植的项目、会话和聊天体验。
tags: [extra, architecture, stream, workspace, interaction, adapter, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 本地 WebUI Extra

## 状态与目标

用户已授权在当前分支直接实施。M0–M3 已实现，本地页面已启动；M4 已完成真实 Codex、浏览器及仓库外发行安装验证，线上既有连接共存仍未验证。代码入口、实际差异和证据见[交付记录](../../journal/shared/2026-10-16-runtime-webui-extra-delivery.md)。下文保留原计划合同，已实施接口及限制以该记录和包 README 为准，不能把所有计划验收项视为已通过。

新增 `packages/octo-runtime-webui-extra`，包名为 `@mininglamp-oss/octo-runtime-webui-extra`，Extra 稳定名称为 `webui`。删除 `packages/octo-runtime-extra-sse-demo` 及其发行依赖、测试和当前用法引用，用完整本地 WebUI 接替。启用后监听 `http://127.0.0.1:13888/`，直接提供可用的项目与会话界面。

页面以当前 `octo-work-app` 工作台为源码基准：左侧项目与 session 列表，中间对话及执行过程，底部输入区，右下角唯一模型/引擎入口。thinking 展开收缩、工具过程、最终答复、动画、滚动和模型菜单直接移植原代码、样式、资源及测试，不根据截图重新猜测交互。用户澄清后没有指定另一个 `octo-web-ui` 仓库。

首个默认项目为 `~/octo-runtime-workspace`。项目等于 Runtime 所在机器上的一个本地目录，可以继续选择并添加其他目录。项目记录和当前选择使用浏览器 `sessionStorage`。

用户进一步指定：sidebar sessions 使用仅属于 WebUI 的临时本地 JSON 存储，最多保留 100 个，超限淘汰旧记录，保存 Provider session 绑定，列表支持清理和刷新。此要求取代本计划初版“会话全部仅存 sessionStorage”的选择；项目存储方式不变。

## 第一性原理与需求归属

| 检查 | 本任务结论 |
| --- | --- |
| 真实业务动作 | 本机用户启用 Extra 后，在浏览器选目录、创建和切换会话、输入消息、观察工具过程并完成交互，方便使用与演示 |
| 产品决定权 | WebUI 拥有项目、session、展示、模型/引擎、思考强度和本轮上下文策略；这些逻辑属于此 Extra 的浏览器应用与接入代码 |
| Runtime 合同内动作 | 复用共享 AdapterHost 的 invoke/cancel/respondInteraction，以及已加载 Adapter 的列举和实际可用状态查询 |
| 显式输入 | 前端冻结本轮 inputs、Context v3、cwd、模型/effort/审批选择和会话 binding，经插件接口提交 |
| 问题责任 | 旧 demo 缺少完整产品入口，在新 Extra 补齐；不要求 Host、Adapter 或 IM Channel 管理 WebUI 业务历史与界面状态 |
| 越界动作 | 不新建执行内核、不隐式安装 Provider、不从历史补模型上下文、不把 WebUI 默认值推广到其他接入产品 |
| 当前授权与影响 | 用户明确要求删除旧 demo。保留既有 Runtime 身份、Home、profile、Provider 状态、其他 Extra 和用户目录 |

## 已核对基线与移植原则

源码核对基线：Runtime `5f7c825`、Work App `8ba4332` 及各自当前工作树。实施开始时重新记录来源 SHA 和涉及文件的工作树状态，不能把本次核对当作对将来版本的锁定。

| 移植来源（相对 `../octo-work-app/`） | 要迁入的行为 |
| --- | --- |
| `src/renderer/src/surfaces/Transcript.tsx`、`execution-process.ts`、`tool-presentation.ts` | 整轮过程收口、thinking 摘要与详情、过程分组、工具语义及详情、最终答复和复制 |
| `src/renderer/src/surfaces/ConversationView.tsx` | 会话生命周期、流更新、粘底、上滚停止跟随、回到底部、历史分页定位 |
| `src/renderer/src/features/workbench/presentation-event-batcher.ts`、`src/shared/work-state.ts` | 流增量合帧、消息/item 状态与稳定身份；先核对 re-export 及真实依赖闭包 |
| `packages/agent-access-kit/src/client/raw-presentation.ts`、`src/shared/presentation.ts`、`src/main/agent-conversation-service.ts` | 相同 canonical 事件的投影、公开暴露过滤、session.update、终态和实时/历史一致性；投影在新 WebUI 前端运行 |
| `src/renderer/src/surfaces/Composer.tsx`、`ModelPicker.tsx`、`ApprovalPolicyPicker.tsx`、`ApprovalCards.tsx` | 输入区、发送/停止、审批响应、右下角引擎/模型菜单、四挡思考强度、重置、选中/禁用态及键盘行为 |
| `src/shared/model-settings.ts`、`src/renderer/src/lib/execution-context.ts`、`packages/adapter-icons/` | 引擎选择、模型/effort 偏好、Context 构造及真实 Provider 图标 |
| 上述组件的样式、Popover、Markdown、计时器、i18n 和其他实际依赖 | 字体、间距、动效、弹出层定位、Markdown/表格、耗时；不能只拷 JSX 后重画样式 |
| `tests/conversation-presentation-ui.test.ts`、`conversation-process-group.test.ts`、`presentation-stream-contract.test.ts` 及对应 batcher/输入区测试 | 随代码迁入的行为断言，作为复刻的回归依据 |

采用“复制依赖闭包，再替换宿主接线”的方式。允许的差异是 Electron IPC 改为本地 HTTP/SSE、本地目录项目与浏览器存储；展示和展开状态机保持原实现。不能把 Electron main、SQLite、账号/租户服务或 `window.octoWork` 引入浏览器应用；宿主调用通过 WebUI 组合层端口替换。不同时重构 Work App、抽通用大 UI Kit 或重写另一套 reducer。

M0 形成 `porting-map.md`，逐项记录“来源文件/版本 → 目标文件 → 依赖 → 必要差异及理由 → 复用测试”。同一 fixture 在原版和新页面回放，比较 DOM、展开状态、可见文本、按钮行为及截图；视觉相似不能代替行为一致。

## 关键合同

### 1. Extra 启动、构建与删除旧入口

- 采用 `name + default load(ctx, config)`、`onStatus`、`signal`、`onDispose`。页面和 HTTP 接口由本 Extra 提供，调用注入的共享内核，不再依赖旧 demo。
- 地址限定本机 loopback，约定端口 `13888`。占用时报告监听失败及原因，不自动换端口，不把 `loaded` 显示为页面已就绪。
- HostApp 决定安装和启用；CLI 使用 `<home>/extras/webui/config.json`，SDK 显式装配。本地打开和执行不以云端登录为前提。
- 默认目录使用 `homedir()/octo-runtime-workspace`，不是 shell cwd 或 Runtime Home。缺失时创建；已有目录直接使用；非目录或无权限明确报错，不能删除或重建原内容。
- React/TypeScript 前端和必要图标随 Extra 的 `dist` 打包。正式使用不依赖独立 Vite、CDN 或 Work App 源码目录；在仓库外安装发行物验证完整资源。
- 删除旧包、根生产依赖、锁文件项、demo 专属测试和当前文档旧示例。历史 journal 保留历史含义。已有 `sse-demo` 配置只报告入口已移除及新配置方法，不自动删除、改写或作为新包别名加载。
- 卸载关闭监听与连接，取消并等待本 Extra 的在途执行清理，释放端口；不能停止其他 Extra 或重启共享 Host。状态返回 URL、活动请求数和脱敏错误，不返回凭据。

### 2. HTTP 接口与 Adapter 数据

下列为实际接口。它们只承担 WebUI 接线，不另造 Run/Context 协议。

| 接口 | 职责 |
| --- | --- |
| `GET /`、静态资源 | 提供完整页面和本地资源 |
| `GET /api/bootstrap` | 默认项目绝对路径及页面写接口 token；token 仅内存持有 |
| `GET /api/adapters` | 查询同一共享 Host 已加载 Adapter 及实际可用状态，供菜单展示和刷新 |
| `GET /api/directories` | 返回规范路径及最多 1000 个直接子目录，不返回文件正文或递归扫描；创建/执行时再次验证 |
| `GET /api/sessions`、`POST /api/sessions` | 读取与创建 WebUI 会话，列表刷新重新读服务端 JSON，新建时执行 100 条淘汰策略 |
| `GET /api/sessions/:sessionId`、`PATCH /api/sessions/:sessionId` | 读取详情、按版本保存前端生成的有界展示快照及真实 Provider binding |
| `DELETE /api/sessions/:sessionId`、`DELETE /api/sessions` | 清理单条或全部 WebUI 会话；在途执行须先停止并确认清理，不能误报已删除 |
| `POST /api/invoke` | 接收统一 `InvokeInput`，SSE 原样交付完整 canonical 事件 |
| `POST /api/invocations/:invocationId/cancel` | 转交 cancel，以真实终态结束界面状态 |
| `POST /api/invocations/:invocationId/respond` | 校验本 WebUI 活动执行归属，将原 `InteractionResponse` 转交 respondInteraction |

daemon 已有 `adapter.list`，SDK 有 `listAdapters()`，Host RPC 有 `describe/probe`。本次在公开 `ExtraAdapterHost` 增加可选只读 `list()`，复用 `HostRunService.list()` 和实际探测链路；旧宿主缺少此端口时明确返回 503。不让 Extra 扫描默认 JSON 猜当前加载集合，不创建第二个 Host，不让浏览器直连内部 IPC。

“拉 adapters 支持”指已装配集合、对应元数据及真实可用结果；不新增 `executionFeatures` 标签、布尔能力表或功能准入中心。`unchecked` 不伪装成探测成功。模型列表沿用 Work App 已配置/原生来源，不能把 Adapter 列表当模型目录；只有默认模型时展示“默认”，不编造模型 ID。Provider 凭据保留在宿主/Provider 的受保护配置。

WebUI 默认按 `codex > claude-code > codebuddy > openclaw` 选择首个实际可用项，显式选择和 mandatory 约束优先；其他产品不受影响。未安装、未认证、不可连接和尚未探测分别展示，不自动安装或静默改选引擎重试失败请求。

本地接口严格校验 Host/Origin，拒绝跨站调用和通配 CORS；以本机会话 HttpOnly/SameSite cookie 和写接口 CSRF 校验防止其他网页借服务执行命令。Runtime Token 和 Provider 密钥不进入前端存储、源码或日志。本机访问不是操作系统沙箱，不承诺远程共享或多用户隔离。

### 3. 项目、目录与 sessionStorage

- 左侧提供新对话、项目及项目内 session、最近会话；添加项目可搜索已有项目并选择本机目录。首次打开选中默认项目。
- 浏览器目录上传或 `showDirectoryPicker()` 不能提供可靠的宿主绝对路径。使用 Extra 目录浏览接口：点击进入子目录、返回父目录、选中当前目录，也可输入绝对路径校验；不上传目录，不依赖 Electron dialog。
- Extra 以 `realpath/stat/access` 验证路径并去重，区分不存在、非目录、不可访问。目录只代表 cwd，不授权 Provider 越权；目录 API 不开放任意静态文件读取。
- 版本化 `sessionStorage` key 按本地实例/Home 的非秘密作用域隔离，保存项目 ID、名称、规范路径、当前选择和最近信息。每轮执行前重新校验目录，浏览器记录不是授权凭据。
- 项目、当前选择、草稿等页面偏好只承诺本标签页刷新保留，不承诺关页后或跨标签页共享。新标签页可能获得 opener 复制初值，但随后独立；复制的在途记录不能视为可接管执行。会话列表和 Provider binding 采用下一节的 JSON 合同，不以 sessionStorage 为权威来源。
- 浏览器存储处理 `QuotaExceededError` 和损坏数据；超限提示记录未保存，不静默删改正文或 Provider 文件。
- 项目新选目录只影响新会话，已有会话固定关联原项目。修改目录创建新项目关联，不在进行中偷换 cwd。移除项目不级联删除会话或本机目录；会话记录保留其原始规范目录，项目记录丢失后仍可据此显示并重新校验。

### 4. WebUI 专属的 100 条 JSON 会话队列

- 使用简单有界的最近使用队列（LRU 语义）：按最后一次用户提交/会话操作的 `updatedAt` 降序展示，sessionId 作稳定次序。逐帧 SSE 到达不刷新排序，也不为这 100 条数据引入最大堆/最小堆依赖。这里采用用户所述队列的容量/淘汰意图，具体数据结构保持简单。
- 整个 WebUI 实例最多保留 100 个 session，跨项目合计。创建第 101 个时，在同一次串行写入中淘汰最旧的已结束记录，先完成原子保存再返回成功；不自动淘汰/中断在途会话。若没有可淘汰记录则明确拒绝新建，不突破上限。
- JSON 文件默认由 CLI 按当前 Home 安排为 `<home>/extras/webui/sessions.json`，通过插件专属配置 `sessionStorePath` 传入；SDK HostApp 显式提供自己的路径。Extra 不猜 Home/profile，不借此给通用 Runtime 增加业务存储。文件设为仅本机用户可读写。
- 文件保存版本号及最多 100 个记录：WebUI sessionId、标题、项目规范目录、创建/更新时间、状态、对应 Adapter、模型/effort 选择、代次和 opaque `providerSession`。Provider session ID 来自真实 `providerSession.sessionId`，可在 JSON 中关联为 `providerSessionId`，不得从 WebUI sessionId 推算；扩展 binding 数据完整保留，不只存一个字符串而丢失恢复合同。
- 展示历史由前端沿用原投影生成有界快照，经 PATCH 被动保存；不新增后台任务、逐事件 Run 归档或服务端 presentation 引擎。快照条数、单记录及整文件字节预算在 M0 固化，记录数上限不能代替字节上限。超预算明确报保存失败，不静默截断或伪称完整历史。
- 采用单进程串行修改、临时文件加原子替换，避免同时新建/PATCH/删除写坏 JSON。PATCH 携带记录版本和会话代次，过期写入、已淘汰或已清理的会话拒绝，迟到 checkpoint 不得把记录复活。写失败保留上次有效文件，不报告操作成功；损坏文件明确报错，不自动覆盖为空。
- 绑定由前端收到真实 `session.update` 后保存；保存不是执行接纳条件，也不保证 Provider 可恢复。插件/浏览器重启后可重新读列表和历史，但旧在途状态必须变成结果未知、旧交互不可操作，不自动恢复或重放执行。继续聊天仍核对 Adapter、目录、代次和真实 resume 结果。
- sidebar 提供刷新、单条清理、全部清理。刷新重新读取 JSON 并更新当前列表，保留仍存在的选中项，不重新 invoke；当前项已被淘汰时退出该详情。单条/全部清理只删除此 WebUI 的 JSON 记录与前端缓存，不删除 Provider 原生 session、项目目录、其他 Extra 或 Runtime 身份。
- 在途记录须先执行“停止并清理”，等待真实终态和清理完成再删除；失败时保留记录并显示原因。全部清理先停止本 WebUI 自己的活动执行，不触碰其他入口；清理过程中禁止新建和 checkpoint 回写。空列表保留“新对话”入口。

### 5. 完整相同的执行与流协议

- 使用统一 `InvokeInput`、Context `octo.context-envelope/v3`，显式 `protocol_mode: canonical`。Run `schema_version=7`、内部 Adapter 和审批各保持独立版本；不往 HTTP body 机械增加非 InvokeInput 字段。
- SSE 数据保留原 `CanonicalEvent`，不裁剪 channel、exposure、message/tool 身份、增量/快照、activity、plan、usage、execution、session、交互或未知可选 payload。协议、身份和权限继续校验。
- 前端用标准 SSE parser 处理字节分块、UTF-8 跨块、CRLF、多行 data 和错误事件，参考 `eventsource-parser` 路径；不对网络 chunk 直接 JSON.parse 或自行拆换行猜事件。
- 投影、增量合并、thinking/工具分组和历史还原在前端运行，尽量复制 `RawRunPresentation` 与 Work App 本地源接线。必要的本地投影计数只作 UI 排序，不伪称 Host 源游标，不新增可恢复源流合同；后端不先合成答案或 HTML。
- 显式绑定 sessionId/runId/invocationId；保存并提交真实 `session.update` 返回的 opaque providerSession，不从业务 sessionId 猜 Provider ID。恢复按真实回执展示，浏览器聊天记录不等于 Provider 背景已恢复。
- WebUI 冻结每轮输入和 Context；无背景时允许空模型上下文。cwd、model、effort、审批属于执行配置，不拼入模型文本；底层不自动补历史、合并、去重或省略业务项。
- 同一 session 同时只允许一轮在途。切换左侧 session 仅改变视图，不取消其他会话流；连接管理放在会话视图之外，隔离各自事件、展开状态、草稿与 binding。服务端活动映射和并发有明确上限。
- 首版不新增自动 SSE 续流/后台历史回放。请求连接断开时取消该请求执行并等待清理；未收到真实终态则显示中断/结果未知，不按 EOF 或 HTTP 200 认定成功，不自动重新 invoke。刷新恢复旧在途记录时标记未知、禁用旧交互并保留部分内容；用户明确新开/重置后再执行，不重放旧消息。
- 主动停止经 cancel，界面保持停止中直至真实终态。审批/追问/elicitation 返回原 invocation，不作为新消息另开 Run；拒绝过期、重复、非本页面执行和终态后的回答，响应在途避免重复提交。

### 6. 展开与右下角菜单的复刻验收

以下是现有源码和用户要求的核对重点，不是授权重写行为：

1. thinking 只展示允许公开的摘要/计划；摘要行、详情、工具切换、等待审批和断线状态沿用原版。
2. 运行时整轮过程可见，工具输入输出和 thinking 分组详情的默认状态按原代码。用户手动展开后，增量、工具结束和后续 render 不覆盖手动状态。
3. 真实终态后过程区按原逻辑自动收起，显示耗时与分隔线，全部 final 块保留在外；手动重开、下一轮和历史重载均保持原行为。
4. commentary/analysis/final 不靠内容猜分类。复制答案不夹带过程；多 final、无文本完成、失败和取消的部分结果沿用原处理。
5. 接近底部跟随增长，上滚后停止，回到底部恢复，加载早期记录不跳动；不额外每帧强制滚动。
6. 完整迁入 ModelPicker：Provider 图标、默认/模型勾选、引擎子菜单和返回、四挡 `low/medium/high/xhigh` 滑杆、拖动反馈、键盘步进、当前文案和重置；Popover 尺寸定位、外部关闭与焦点恢复一起迁入。
7. Composer 的权限选择、发送/停止、运行锁定和错误反馈一起接线。设置/模型管理、资源选择等可见命令必须有本地流程，不留失效的 Electron 跳转或空按钮；附件沿同一 inputs 合同接线。

## 实施里程碑

| 阶段 | 交付与通过条件 |
| --- | --- |
| M0 来源锁定与接口定稿 | 来源 SHA、依赖闭包、porting-map、迁入测试/fixture、HTTP 类型、目录边界、存储/并发预算、模型来源及原版基准截图 |
| M1 Extra 与发行接线 | 新包生命周期、13888 页面/资源服务、只读 Adapter 端口、目录 API、本机接口保护、CLI/SDK 配置与状态；同步删除旧 demo，端口占用/卸载测试通过 |
| M2 原版聊天与完整协议 | 迁入投影/reducer/batcher/Transcript/样式/资源；SSE、取消、审批问答闭环，相同 fixture 的 thinking/工具/终态/复制行为一致 |
| M3 工作台与输入体验 | sessionStorage 目录项目、100 条 JSON 会话及 Provider binding、淘汰/刷新/单条和全部清理、默认目录、草稿、完整 Composer/ModelPicker/effort/权限和本地设置，互不串流 |
| M4 浏览器及发行验收 | 同流并排回放、真实 Provider、CDP/Playwright、桌面/窄窗口截图、仓库外发行安装、其他 Extra 共存与回归，逐项保存证据和限制 |

各阶段分别记录状态，不以“能打开页面”认定交互完整，也不以同协议类型通过编译认定复刻成功。

## 验收清单

- [x] 发行物不含旧 demo，新包名称准确；当前文档入口已替换，历史和用户配置未被清理。
- [x] 本地 `13888` 可用；占用/卸载/共享 Host 复用通过测试，既有线上 Extra 共存另验。
- [x] 默认目录创建，真实第二个目录选择和草稿刷新已用浏览器验证。
- [x] 新建/切换、sessionStorage 草稿和 URL 恢复已实现；真实在途切换隔离通过浏览器验证。
- [x] 101→100 淘汰、revision、迟到 PATCH、清理、损坏文件保护通过后端回归。
- [x] 真实 Provider binding 刷新续聊成功；单条与全部清理通过后端测试，Extra 卸载重载可恢复记录。
- [x] Adapter 来自共享 Host；模型入口沿用原源码，桌面/手机浮层通过浏览器检查。
- [ ] 同一完整事件 fixture 的 thinking 展开收缩、工具详情、手动状态保持、终态收口、耗时、多 final、下一轮和历史回放 DOM/行为断言一致。
- [ ] 覆盖 UTF-8/分块 SSE、增量/快照、exposure、无文本完成、失败、取消、断流和刷新未知状态，无 EOF 假成功或自动重复执行。
- [ ] 审批和结构化问答真实回到原 invocation；错误归属、过期、重复和已结束回答不能执行。
- [ ] Host/Origin/CSRF、目录及静态文件边界、请求大小、存储配额、并发、慢输出背压和卸载中止可验证，日志/截图不含凭据。
- [x] 构建、typecheck、lint、完整 Node 回归和 35 个迁入 UI 断言通过；文档检查见交付记录。
- [x] Playwright 驱动真实 Codex 文本、工具审批、续聊、取消；桌面/手机无横向溢出，保留真实执行失败证据。
- [ ] 与线上测试环境 `https://im-test.deepminer.com.cn/` 的既有 Extra 共存调试，证明 WebUI 装卸不影响已有连接与执行。WebUI 本地执行不依赖云登录；mock、真实 Provider、线上共存证据分别记录。
- [x] 发行包仓库外离线安装后独立提供 HTML/JS/CSS，无 React 服务端依赖；本地 Extra 已重新加载。未修改 Run/Context 协议。

## 范围外与剩余实现决策

不建设云端项目/session 服务、远程共享、跨浏览器历史同步、SQLite/通用业务数据库、新 Provider 安装器或另一套协议。用户本轮指定的有界 JSON 会话存储只属于 WebUI，不改变 Host/daemon/Adapter/Channel 的纯执行或不持久化合同。不变更 Work App 默认联调环境，不修改 IM Channel 的固定目录与会话策略。

包名、端口、默认目录、项目 sessionStorage、最多 100 条 JSON 会话及 Provider binding、淘汰/清理/刷新、删除 demo、复制 Work App 交互和 Extra 拉取 Adapter 已由用户确定，不再列为待批准事项。字节预算、模型目录来源及依赖替换明细在 M0 据源码定稿；若必须改变可见交互或扩大存储范围，再列具体差异，不能自行降级复刻要求。
