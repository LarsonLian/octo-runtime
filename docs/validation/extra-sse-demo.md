# Extra SSE 演示验证记录

## 2026-10-15 统一输入与拆包复验

对外输入已统一为协议包 `InvokeInput` TS class / JSON 对象。CLI playboard、AdapterHost、SDK、gateway、wecom 和 SSE 入口复用同一校验与执行解析；完整字段见 [Invoke 合同](../../packages/octo-runtime-protocol/docs/invoke-input.md)。原先 `{adapterType, request, options}` HTTP 包装已删除。

Gateway 与 WeCom 已拆为两个独立 extra 包；worker-access 已移至生态目录外的独立本地备份仓库，不再默认装配。旧记录中的迁移范围和 DTO 示例保留历史含义。

- Runtime 构建与类型检查通过；全量 731 测试中 724 通过、7 跳过、0 失败。
- Desktop 构建与类型检查通过；全量 1615 测试中 1614 通过、1 跳过、0 失败。
- 字段映射验证主输入/恢复输入的图片字节、完整 Provider 扩展参数、身份、代次和 metadata 保留。
- 已重启真实 Work App。CDP 确认登录 im-test、本地 Runtime 正常；真实 SDK 本地聊天执行完成，完整 canonical 事件相等、重复调用被阻止、renderer 显示最终答复。
- Gateway 真实 im-test 注册与连接通过；Codex 执行完成，遗留数据库未被写入。
- SSE 用统一 JSON 经重启后的桌面 daemon / Codex 执行完成；错误 Bearer 拒绝，卸载释放端口，共享 Host 保持 ready。
- WeCom 协议及生命周期自动测试通过；本轮未使用真实企业微信账号进行实机验证。

## 实现范围

统一函数式 Extra 加载器、CLI `extraset`、CLI daemon 启动配置读取、SDK JSON 声明传递，以及原生 HTTP/Bearer/SSE 演示插件。本次不改变 Run=7、Context=v3，不迁移 channel-gateway 或 worker-access，不默认启用 Work App 的 demo。

## 自动验证

- `pnpm build`：全部 Runtime workspace 包和 apps 构建通过。
- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- 新增源文件 ESLint：通过。
- `node --test test/extras.test.js`：8 项通过。包括名称唯一性、逆序清理、初始化失败回收、清理失败继续回收、停机中断初始化、0600 配置保存、完整替换、错误声明拒绝、重启读取、Bearer/方法/body 校验、请求取消、卸载端口释放、端口占用隔离及 Desktop SDK 传递。
- 相关 daemon、CLI、SDK、无数据库执行回归：36 项通过。

CLI 进程测试从 `apps/daemon/dist/index.js` 启动真正 daemon，按已保存声明动态加载演示包；连续两次启动均产生 Host 执行流，SIGTERM 后端口释放。该测试使用 fixture Provider，不表示线上 Provider 验证。

## 真实测试环境

运行 `node scripts/verify-extra-sse-live.mjs`，结果通过。脚本读取真实 Work App renderer 的公开状态，确认登录 `https://im-test.deepminer.com.cn` 且本地 Runtime 正在运行；核对 IPC 返回的 PID 与 renderer 显示的 daemon PID 一致。

在独立临时 Home 中通过 `extraset` 保存完整配置，加载演示 lambda，注入真实桌面 daemon 的 IPC 执行端口。HTTP POST 从 `127.0.0.1:3002` 进入，插件调用 `adapterHost.invoke`，经真实 IPC 和 Codex Provider 返回 canonical SSE。

| 观察点 | 实际结果 |
| --- | --- |
| 桌面环境 | im-test，已登录 |
| 本地 Host | ready，与 renderer 指向同一 daemon |
| 对外连接开关 | false；没有为 demo 开启云端连接 |
| 无 Bearer 的请求 | HTTP 401 |
| 真实调用 | Run `8198899b-fa98-47c9-88e5-ab46aca302d9` |
| Provider | codex |
| 输出 | 与本轮随机 marker 完全一致 |
| 终态 | `run.completed` |
| 插件卸载 | HTTP 端口关闭 |
| 共享 Host | 卸载后仍 ready |

此验证说明插件能调用真实桌面执行能力，不表示请求经过 Worker 远程调度，也不表示 Octo/WeCom 已迁移为 Extra。SSE demo 不调用 IM 注册或发送消息接口；没有新增线上设备注册。临时配置及随机 Bearer Token 在验证后删除。

复跑前需要启动真实开发桌面并登录 im-test，CDP 为 9222。自定义 Runtime Home 使用 `OCTO_EXTRA_LIVE_RUNTIME_HOME`；若 3002 已占用，可用 `OCTO_EXTRA_LIVE_PORT` 选择其他端口。脚本始终关闭自己创建的插件，不关闭桌面 Host。
