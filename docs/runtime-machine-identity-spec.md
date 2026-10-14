# Runtime 与 Machine 身份

SDK 在本地 profile 初始化时生成或读取稳定 `runtime_id`，不以云端 enrollment 成功为前提。当前实现见 [identity.ts](../packages/octo-runtime-daemon/src/runtime/identity.ts)。

同一 app-owned Home、subject 和 tenant profile 在普通重启、模块关闭或外部连接失败后保留身份。初始化校验 profile、租户及 Runtime ID 格式，错误时明确失败，不自动改用另一个身份。

Home 在 `machine.json` 保存 `machine_id`。它是未可信的安装分组标识，不是硬件指纹、认证凭据或通用设备身份。同一 Home 下多个 profile 可以共享它；不同应用 Home 不自动合并。

Runtime ID、业务 Agent ID、逻辑 session ID 和 Provider session ID 分别承担不同职责。知道本地 Runtime ID 不表示有权远程调用；本地身份也不能证明 IPC 就绪、Provider 可用或业务连接成功。

当前仓库已移除 Worker 接入包。旧 enroll/register 的 owner、credential 与发现合同不再作为本地 SDK 使用说明；外部登记必须按实际服务的身份和权限合同校验。

会话 reset 不删除 Runtime 身份。显式销毁身份属于独立操作，不能作为自动网络修复。完整历史及 Provider binding 由业务应用保存；Host 的有界窗口不提供重启后的历史恢复。见 [Runtime 合同](runtime-local-and-online-contract.md)。
