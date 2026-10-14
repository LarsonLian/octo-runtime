# daemon 包与可选连接验证

日期：2026-10-14。本次范围为 packages 边界及 Work App 消费迁移，不修改 Context v3 / Run 7，不实施 Worker 数据库或最终设备 WS 合同。

## 落点

- 删除 embedded 独立包，本地 SDK、Home、账户隔离、监督与 IPC 移入 daemon/src/runtime。
- enrollment 位于 worker-access；Worker/IM 工厂位于各自可选包。daemon 生产依赖树不含这两个包。
- HostApp 明确指定安装、模块工厂和启用配置；未启用模块不导入、不建联。模块共享 Host，模块错误不改变本地 ready。
- Work App 直接依赖 daemon，DaemonRuntimeService 只处理宿主认证、配置、适配器探测快照与 UI 投影。默认 Worker 关闭，IM 按 bot 配置独立启动。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| Harness workspace build 与根 tsc | 通过 |
| 本次 daemon/runtime/工厂/enrollment 修改的 ESLint | 通过 |
| Harness 全套 Node tests | 898 通过，9 跳过，0 失败 |
| Work App build（含 tsc） | 通过 |
| Work App 全套 Vitest | 194 文件通过、1 跳过；1598 测试通过、1 跳过 |
| prepare:runtime:mac-arm64 | 通过，daemon 和可选模块分别部署 |
| 独立客户 daemon 生产部署 | Worker/IM 均不在生产依赖树；实际本地执行 3 轮成功 |
| 显式启用不存在的 Worker 模块 | 报模块错误，本地继续执行；停止模块后本地仍可执行 |
| 云端启动等待时切账号 | 请求中断，进程回收，不等待 enrollment 成功 |
| 实际发行目录加载可选工厂 | IM 独立启动；Worker 越权租户拒绝，本地 ready 不受影响 |
| 两个仓库 git diff --check | 通过 |

生产隔离检查可重跑 [verify-daemon-deployment.mjs](../../scripts/verify-daemon-deployment.mjs)，模块回归见 [daemon-modules.test.js](../../test/daemon-modules.test.js)。

## 真实 renderer

干净重启 Electron 与 electron-vite 后，通过 CDP 9222 调用真实 preload，使用 `https://im-test.deepminer.com.cn` 登录态。

- 本地 Runtime 就绪、cloudConnected=false。
- 本地聊天执行完成，完整 CanonicalEvent 与 daemon 源流逐项一致；本轮 21 项事件。
- 重复请求复用原 execution，不重复 invoke。
- renderer 历史页显示实际回复，无等待同步或思考残留。截图保存在本机 `/tmp/octo-local-invoke-proof.png`。

记录未包含登录凭据。未把以上本地验证写成设备 WS 已获最终评审或在线 toggle 已实现；这两项仍由独立方案推进。本次代码仍使用 daemon server 承载本地控制进程，最终对外进程职责拆分不在包合并中宣称完成。
