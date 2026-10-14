# Runtime 纯执行实体与本地 SQLite 移除方案

日期：2026-10-14。范围：仅 `octo-runtime` 项目。本文记录已选设计；实现和实测结果在验收记录中单独说明。

## 职责

Runtime 接收调用方提供的执行请求，校验执行身份及配置，调用 Provider，传递事件，处理交互和取消。Runtime 不管理业务 Agent，不保存业务 Session 或 Run 历史，不从历史请求恢复模型上下文。

调用方负责业务身份、协议快照、会话映射、历史保存和重启后的恢复决策。Provider 自身的会话文件由 Provider 管理；移除 Runtime SQLite 不代表 Provider 不使用 SQLite。

Run `schema_version=7` 和 Context `octo.context-envelope/v3` 保持不变。配置解析、租约、fencing、权限和必要执行配置继续校验。模型上下文只使用本轮显式提交的内容。

## 移除范围

1. daemon 不再创建 `state.db`，不再构造 `HarnessEngine` 或领域 store，删除 Agent 注册、业务 Session 查询、本地 Run 历史查询及重启恢复实现。
2. core 保留执行配置解析和模型上下文固定渲染，删除 `Store`、`MemoryStore`、`SqliteStore`、SQLite helper 和业务执行引擎。不得用无限增长的 Map 替代数据库。
3. 删除 `OCTO_RECORD_RUN_STEPS`，不提供 Run 事件落盘开关。
4. worker-access 删除 `agent-work.db` 路径和伪数据库打开、隔离、迁移逻辑。运行目录显式使用 `root`，用于工作区准备和磁盘空间探测。
5. 内置 IM channel 使用进程内会话映射，删除 `im-sessions.db`。映射丢失后创建新会话，不声称恢复旧 Provider 会话。IM 映射和消息去重必须设置容量及过期限制。
6. 删除数据库参数、生成路径、导出和对应依赖接线。旧数据库不读取、不迁移，不自动删除用户文件。

## 进程内状态与容量

执行状态包含活动调用、取消信号、交互句柄及有限事件回放，不是历史数据库。

Host 和 worker-access 各自的回放窗口保留现有限制：最多 128 个 Run，单 Run 最多 4 MiB 或 4096 条事件，总事件序列化大小最多 64 MiB，单事件最多 256 KiB，事件保留 120 秒。Host 接收中的调用也必须计入 Run 容量。超过窗口时淘汰旧事件，游标落在窗口外时返回明确缺口；不得伪造完整续传。

IM 会话映射最多 1024 项、总序列化大小 4 MiB、保留 24 小时；消息回执最多 4096 项、总量 16 MiB、保留 120 秒；reset 去重最多 4096 项、总量 1 MiB、保留 120 秒。超限淘汰最早映射。定时清理间隔为 10 秒，访问时也检查过期。单个 IM Bot 的活动会话最多 128 个，排队消息最多 64 个；活动会话继续使用自己的执行句柄，模块停止时释放。模块重新创建且映射已过期或被淘汰时创建新会话。

上述字节数限制针对事件序列化大小，不是进程 RSS 上限。对象、Provider、IPC、复制及多个 Runtime 会增加内存占用。并发数量、映射数量和请求本身的协议大小限制共同约束内存；验收不得把 64 MiB 宣称为整个进程的内存上限。

终态 Run 和过期事件必须清理。模块停止时释放会话映射；进程停止时释放全部执行状态。daemon 重启后旧 stream 失效。执行层不重放历史业务请求，不补齐历史模型上下文。

## 保留的本地文件

保留配置、凭据、机器及 Runtime 身份、监督进程状态和 `invocations.json`。`invocations.json` 仅用于清理孤儿进程，不保存 Run 请求或事件历史。保留实际工作区及必要执行材料，不把 SQLite 换成 Run JSON 归档。

## 验收

- apps、packages 和产物不得引用 `node:sqlite`、`better-sqlite3` 或 `sqlite3`；不再导出 SQL store 或旧业务引擎。
- daemon 启动、执行、取消、drain、adapter-host 重启及 IM 模块启动均不创建数据库文件。
- 容量测试覆盖并发接收、事件淘汰、游标缺口、过期和模块清理；重启测试证明旧 Run 不恢复。
- 构建、类型检查及适用测试通过后，重启受影响的本地 Runtime 进程，在 `im-test.deepminer.com.cn` 验证 Runtime 注册和执行。不得以 fixture 测试替代线上测试环境验证。

## 实现与验证记录

2026-10-14：本方案的代码移除已实施。core 只导出执行配置解析函数；daemon 不再构造领域引擎或 store；worker-access 使用运行目录和内存回放；内置 IM 模块使用有界内存映射。SQLite 导入、旧 store 导出、数据库路径参数和 Run 落盘开关已删除。没有读取、转换或删除用户遗留数据库。

- `pnpm build` 和 `pnpm exec tsc -p tsconfig.json --noEmit` 通过。
- 最终全量测试使用 `node --test --test-concurrency=4 --test-timeout=60000`：891 项，882 项通过，9 项跳过，0 项失败。默认并发的一轮出现 CLI 生命周期用例挂起；该用例独立重跑通过，随后上述全量重跑通过。跳过项不能计作实测成功。
- `test/stateless-executor.test.js` 检查源码和构建产物不加载 SQL 驱动，并验证启用 IM 的 daemon 启动、执行和重启不创建数据库、不恢复旧 Run。Host 测试覆盖并发接收容量和直接执行流的 drain；IM 测试覆盖容量、字节淘汰、过期及关闭清理。
- CLI daemon 和桌面应用的内置 Runtime 已重启。新生成的内置进程会话不再含 `store_path`；检查这些 Runtime 进程的文件句柄，没有打开 SQLite 文件。
- `scripts/verify-stateless-live.mjs` 通过：CDP 读取真实 renderer 的 im-test 登录态；CLI daemon 的 Octo IM 模块已完成真实注册并保持连接；通过 IPC 调用真实 Codex，终态为 `completed`，回答与验证标记一致。执行期间没有新增数据库，也没有修改遗留数据库。此项证明 IM 注册及执行，不等同于 Worker Runtime 注册；本次未修改 Worker 注册或 Run/Context 的线上协议。
