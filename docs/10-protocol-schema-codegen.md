# Protocol Schema 与类型生成

可序列化数据的结构来源为 [protocol.schema.json](../packages/octo-runtime-protocol/schema/protocol.schema.json)。[gen-types.mjs](../packages/octo-runtime-protocol/scripts/gen-types.mjs) 使用 `json-schema-to-typescript` 生成 [protocol-types.ts](../packages/octo-runtime-protocol/src/generated/protocol-types.ts)，不要手工修改生成文件。

## 当前边界

Schema 定义 ProviderSession、AgentConfig、Context、执行计划、Host 帧和 InvokeRequest wire 等数据形状。字段格式、权限和跨字段约束还由 Protocol 中相应的运行时校验器处理；生成 TypeScript 类型本身不会在运行时校验输入。

运行时常量、泛型 CanonicalEvent 以及带 `AbortSignal` 的 InvokeRequest 组合留在 [src/index.ts](../packages/octo-runtime-protocol/src/index.ts)。函数、活对象及 AbortSignal 不通过 JSON wire 传输。

当前 daemon 是 TypeScript 实现。跨仓库 Go 消费者的合同及生成流程由各消费者维护，不能把未来 Go daemon 写成当前实现或已批准的迁移目标。

## 修改流程

1. 修改 Schema 及相关运行时校验器。
2. 更新共享正反 fixtures 和受影响消费者。
3. 重新生成类型并构建：

```sh
pnpm --filter @mininglamp-oss/octo-runtime-protocol gen
pnpm --filter @mininglamp-oss/octo-runtime-protocol build
```

Protocol 包的 `build` 自动运行生成器。验证入口包括 `test/context-protocol.test.js` 和 `packages/octo-runtime-protocol/test/*.test.js`；具体测试范围随修改的合同决定。

Run 固定为 7、Context 固定为 `octo.context-envelope/v3`，Adapter transport 使用自身的版本 2。新增可选字段不机械升级这些版本，不新增旧格式识别、转换或回退。协议变更还必须同步 Worker、Harness 和桌面应用，构建并重启受影响实例，在 im-test 验证实际注册与执行；仅生成类型或全局链接不能代替实机验证。
