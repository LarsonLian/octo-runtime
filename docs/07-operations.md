# Runtime 运维

日期：2026-10-14。先区分本地、注册、设备连接和 IM 连接，见 [Runtime 合同](runtime-local-and-online-contract.md)。调试涉及真实服务时使用 `https://im-test.deepminer.com.cn/`。

## 启动与检查

客户 App 使用 [daemon SDK](../INTEGRATION.md#2-作为-sdk-接入独立-app)，本地启动不需要 Worker URL 或 Runtime credential。HostApp 明确提供发行物和 Provider 安装方案。

独立 CLI 前台诊断：

```bash
octo-harness --home /absolute/runtime/state daemon run
octo-harness --home /absolute/runtime/state status
octo-harness --home /absolute/runtime/state adapter list
octo-harness --home /absolute/runtime/state adapter probe codex
```

已保存云端 profile 的 CLI 装配仍可能恢复 Worker 接入；客户仅本地 SDK 不依赖这套 CLI 流程。CLI `doctor` 同时检查云端项，整体非零不能直接判定本地 Host 不可用。

SDK 查看 `health.local.ready`、`adapterHostReady`、本地 profiles 与 `health.modules`。模块启动返回值不等于在线证据；Worker 实际连接看相应模块 `state.runtimes[].connected`，IM 看频道自己的状态。

## 排障顺序

| 故障 | 检查与恢复 |
| --- | --- |
| 本地 IPC 不可用 | 检查有效就绪响应、runner／Host 入口、owner lock、进程和日志；socket 文件不能证明就绪 |
| Host 就绪但无法执行 | 检查 Adapter probe、实际 Provider 安装／认证、执行配置、工作目录与权限 |
| 可选包缺失或加载失败 | 检查 HostApp 是否携带并显式启用了正确工厂；报错不触发自动安装 |
| 注册失败 | 检查真实账号／租户授权、服务地址与回执；保留本地 Runtime ID，不清空 Home |
| Worker 或 IM 断线 | 只处理对应模块；检查 DNS、TLS、鉴权与其连接状态，本地执行继续独立判断 |
| 输出断流 | 沿原 run／stream 游标修复；缺口或过期明确失败，不重新 invoke |
| 取消已受理 | 等待执行终态并确认 Provider 回收；不把请求成功显示为已完成 |
| 历史缺失 | 检查宿主业务事件存储；Host 内存窗口不是完整历史库 |

不要因为设备离线删除 identity、创建新的 Runtime 或重装 Provider。注册凭据重置与聊天会话 reset 分别处理，均不能代替具体故障诊断。

## 本地日志

启动前设置 `OCTO_RUNTIME_DEBUG=1` 可开启 Host 本地诊断输出：

```bash
OCTO_RUNTIME_DEBUG=1 octo-harness --home /absolute/runtime/state daemon run
```

检查有效运行 Home 的 `logs/adapter-host.log`；SDK 账号隔离时使用对应账号运行目录。修改 shell 环境不会改变已运行进程，必须重启受影响实例。

日志可能包含调用输入与输出，不能公开传播凭据或完整业务内容。当前源流与远程 relay 没有 durable outbox；不使用“清 outbox／修 durable ACK 水位”作为本版运维步骤。

## 验收证据

分别记录本地 IPC 就绪、注册回执、设备实际连接、频道实际连接、真实 Provider 终态及业务保存结果。云端探针不能替代本地执行验证；fixture 测试不能替代真实 im-test 与桌面 renderer 联调。

现有验证见 [2026-10-14 包解耦记录](validation/daemon-package-modules-2026-10-14.md)。Work App 的持久化在线 toggle 和最终 access／设备 WS 划分仍未完成，不以当前模块工厂验证代替其验收。
