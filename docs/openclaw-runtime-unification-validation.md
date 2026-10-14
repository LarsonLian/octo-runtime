# OpenClaw Runtime 统一改造验收

日期：2026-10-14（Asia/Shanghai）。概念和行为以 [统一合同](15-openclaw-external-agent-binding-design.md) 为准。

## 实施结果

- 删除 CLI 外部绑定入口中的 binding、Agent 和 workspace 配置要求。注册后初始化 Runtime 的连接来源；支持自动发现、指定 OpenClaw Home、显式 Gateway URL 与 token。
- 将连接描述、凭据和设备身份保存到对应 Runtime profile。探测与执行共用解析器，每次读取当前配置；显式来源失败不回退默认实例。
- 为 Adapter Host 本地探测接口增加 Provider 配置参数。Runtime 注册与周期探测使用各自配置，移除执行入口排除 OpenClaw 的分支。
- 连接配置不覆盖 Context 已冻结的 `provider_agent_id`。Gateway 探测不依赖默认 Agent `main`，实际调用验证指定目标。
- 内置 SDK 支持按 Runtime ID 查询 Provider；桌面端按当前空间的 Runtime ID 查询和调用，切换空间时不回退到另一 Runtime。
- Run=7、Context=v3 和 Worker 的既有目标字段保持不变。本次 Worker 没有源代码变更，也未执行云端部署。

## 自动验证

| 范围 | 结果 |
| --- | --- |
| Runtime workspace 构建 | 通过 |
| Runtime 根类型检查 | 通过 |
| 本次改动代码的 ESLint | 通过 |
| Runtime 与协议全量测试，`--test-concurrency=4` | 903 项：894 通过、9 按已有条件跳过、0 失败 |
| 桌面应用构建和类型检查 | 通过 |
| 桌面 Runtime 与会话服务相关测试 | 24 项通过；修正测试类型后 Runtime 11 项再次通过 |
| Worker 构建、domain/service 测试 | 通过 |

新增回归覆盖两个 Runtime 的不同连接和设备身份、共享 Host 的并发探测、凭据更新、显式来源不可用、私钥文件权限、无 `main` 的 Gateway、Context 目标保留、连接信息不进入模型上下文，以及桌面空间切换时的 Runtime 选择。

## 实机验证

重启桌面应用和内置 Runtime 后，通过 CDP 调用真实 renderer 的 preload 接口：账号使用 `https://im-test.deepminer.com.cn`，内置 Runtime 在线，OpenClaw 可用。四个已注册 profile 分别生成自己的连接描述。

通过该桌面应用的同一 daemon，携带当前 Runtime ID 和由 Context 解析的目标 Agent `main` 发起最小请求。请求只要求返回标记，不调用工具；Adapter 使用 Gateway 的 `deliver: false`，不向聊天渠道投递消息。

- Run：`run_08cc0bb0-2be3-4fa0-bcde-aa5486aef36a`。
- 统一 Host 帧：28 条。
- 终态：`completed`。
- 返回文本：`OPENCLAW_RUNTIME_a86264a5`，与预期标记一致。

实机执行覆盖桌面本地统一调用链路。Worker 下发 Run 的连接配置与目标传递由集成测试覆盖；本次未新建云端业务 Run。自动探测读取实际 OpenClaw Home；显式 URL/token、多 Runtime 不同 Gateway 和凭据轮换由隔离测试覆盖。
