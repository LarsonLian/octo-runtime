---
type: Journal
title: Gateway 宿主会话存储工厂交付
description: Issue 57 的公开入口、句柄所有权和本地自动化验证结果。
tags: [channel, session, extra, testing]
timestamp: 2026-10-20T00:00:00Z
---

# 行为与边界

基线为 `6fb8ca5`，本轮修改保留在工作树，用户要求不提交、不推送。范围见 [任务简报](../../tasks/channel-host-session-store/brief.md)。

GatewayDependencies 扩展通用 ChannelDependencies，增加同步 createSessionStore(JsonObject): ImSessionStore。Extra 传到 Manager，按启用且有效 Bot 的独立配置快照实际创建并使用句柄；宿主扩展 scope 保留。未提供工厂继续默认 Memory，直接 sessions 仍借用；工厂和接口错误不降级。

Manager 拥有工厂句柄，初始化异常回收，旧 Runtime 收尾后才释放并替换。close 可异步；释放一次，失败持续报告；remove/upsert 和整体关闭均有 5 秒上限，超时撤销包装句柄访问并阻止替换。整体关闭立即清理已创建实例，不先无限等待初始化队列。Provider 收尾时只保存同 session/generation 的真实 session.update，不继续展示/交互/最终投递，已有 reset 不受迟到更新覆盖。

单一发行包新增 `/extras/channel-gateway` 函数式入口；该入口与 `/extra` 公开工厂、binding 和 occurrence 类型。数据库、scope、加密和最终租约撤权仍归宿主；没有 SQLite 生产依赖、Core/Provider/WeCom 改动或历史迁移。完整接入合同见 [SDK 第 8 节](../../../SDK_CHANNEL_GATEWAY_GUIDE.md#8-宿主会话存储与重载恢复)。

# 验证

环境：macOS、本机 Node 24.13.0、pnpm 11.19.0；frozen-lockfile 安装，未修改 lockfile。

- `pnpm typecheck`（包含 workspace 构建）通过；最终改动后 `tsc -p tsconfig.json --noEmit` 通过。
- `pnpm lint`、`pnpm lint:names`、变更 TS/JS/JSON 的 Prettier 检查及 `git diff --check` 通过。
- 定向首次完整通过 46 项，覆盖 SQLite 重开、scope/reset/去重、工厂与存储异常、独立句柄、借用存储、初始化回收、异步关闭、收尾绑定、关闭后拒绝访问、5 秒超时、SDK 切账号/停止及公开类型编译。
- `pnpm test` 最终通过：Node 共 1336 项，1326 通过、10 项既有条件跳过、0 失败；WebUI 35 项通过。首轮发现 delete/set 导致 Bot 状态顺序回归，保留原 Map key 位置修正；相关 37 项复测及全仓复测通过。
- `node scripts/pack-release.mjs` 本地打包成功；仓库外解包验证 `/extras/channel-gateway` 可导入、模块名称正确，公开工厂/存储类型在 `skipLibCheck=false` 下编译通过。没有上传或发布。
- `uv run --with pyyaml python .octospec/scripts/lint.py`：14 个历史跨仓链接失效，均核对为 HEAD 已有引用且本机相邻项目缺失；本次无新增格式、索引或链接错误。未改写这些历史材料来掩盖缺失。首次系统 Python 缺少 PyYAML，使用仓库推荐的 uv 路径完成检查。

# 验证限制

专项使用真实 Extra→Manager→ImRuntime 和临时 SQLite 文件，网络 Transport 与模型为 fake；SDK 测试经真实本地 daemon/独立 Host 和 fake Provider。未做真实 IM/Provider 联调、Windows 验收、第三方 Buddy 迁移或发行；不能把本地恢复通过写成真实 Provider thread 永不改变。


# 第二轮整体复审与修复

用户追加要求按整体改动重审，重点存储隔离、关闭收尾与异常，仍不提交推送。Standards/Spec 独立审查的完整结果见 [复审报告](../../tasks/channel-host-session-store/review.md)。Standards 4 项 P1、Spec 1 项 P1/1 项 P2（1项重叠），共5类问题均已修复：

- SDK 原来在 owner abort 时立即销毁 IPC，无法接收尾 binding；现在停止接纳后按原 receipt/stream 校验取消，保留源流至真实终态或 5 秒期限。ACK 无首帧可及时取消，ACK 丢失保留原安全取消路径；断流、提前 break、取消错误及超时保留为清理失败，不隐式重发取消。get 的窗口元数据先与严格 receipt 字段分离，真实 native SDK 回归通过。
- Runtime 正常关闭保留内部终态，不误进未知结果展示、不重复 cancel、不再 finish/flush presentation。
- Manager 在 owner abort 时立即启动清理和撤权，不等卡住的 initializer。
- 存储租约记录 draining 读写失败，句柄仍尝试释放，但清理持续失败并阻止 reload，避免绑定写入失败被 close 成功掩盖。
- 错误 Promise/thenable 工厂仍拒绝接纳，但消费其拒绝并回收迟到句柄；strict 子进程不崩溃，其他有效 Bot 不受影响。

隔离键、宿主 scope 独立快照、reset/generation、直接 sessions 借用合同复审未发现新的确定问题。没有扩大 Runtime 的数据库职责或新增公共信号协议，普通显式 invoke abort 行为保持。

第二轮验证覆盖并取代上文第一轮最终计数：

- 新增 16 项回归：Gateway 收尾/初始化/存储故障 4 项、Promise 工厂 strict 子进程 2 项、LocalExtras→真实 JSON-RPC socket 10 项；含真实 Gateway+工厂与 IPC 联合路径，证明取消后的 binding 先写入再释放句柄。
- `pnpm test`：Node 共 **1352 项，1342 通过、10 项既有条件跳过、0 失败**；WebUI **35 通过**。
- 构建后 `tsc -p tsconfig.json --noEmit`、`pnpm lint`、`pnpm lint:names`、变更源码/测试 Prettier 与 diff 检查通过。曾将 lint 与清空 dist 的 prebuild 并发，产生暂时声明无法解析错误；改为依赖构建产物就绪后顺序检查通过，未以代码修改掩盖工具竞态。
- 使用最终构建重新本地打包并包外导入 Gateway、以 skipLibCheck=false 编译公开类型。无上传发布。
- OKF 仍仅同一组 14 个 HEAD 已有跨仓失效引用，无新增格式、索引或链接错误。

本机 fake Provider/网络边界及未验真实 IM、Windows、第三方 Buddy 的限制保持；未提交、推送或发布。


# 发行验证器 P1 补修

后续独立评审指出：新增 `/extras/channel-gateway` 后，`scripts/verify-release.mjs` 的精确 exports 清单未同步，导致必需的离线发行门禁失败。此前单独包外导入/类型探针不能替代仓库完整发行验证器；这是前两轮收尾的实际漏验，撤回“本地打包探针等同发行门禁通过”的任何推断。

已在保留精确清单断言的前提下补入 `./extras/channel-gateway`，没有放宽或跳过其他校验。使用干净 `5fc65ebb288db8edca6b44e415ddbdc105ca8937` 重新构建的同一归档，先以旧验证器复现 exports 的 deepStrictEqual 失败，再运行修正后的仓库原版脚本：

```sh
node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-0.0.0.tgz --expected-commit 5fc65ebb288db8edca6b44e415ddbdc105ca8937 --require-clean
```

完整离线验证通过：空缓存全局安装、CLI/daemon 启动、12 Adapter 就绪、公开类型、ExecutorCore、第三方 Extra 与三个内置 Extra 加载、卸载保留 Home。归档 dirty=false，未改写构建来源或降低 require-clean 条件，未开启真实模型联调。

改动仅为验证器公开导出清单及本验证记录，不修改存储或执行逻辑。按用户此前授权，将补修追加至 PR #65 分支并同步 fork main；不合并受评审保护的上游 PR，不发布。
