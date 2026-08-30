# 10 Protocol Schema And Codegen

## 当前状态与目标

`@orbtex-ai/orbtex-protocol` 的数据形状类型（`ProviderSession`、`AgentConfig`、`CanonicalEventPayload`、`RunIdentity`、`InvokeRequest` 的可序列化部分）现在以 **JSON Schema 为唯一来源**，通过 codegen 生成 TypeScript 类型：

```text
schema/protocol.schema.json   ← 协议真值（draft-07，中文 description）
        ↓ scripts/gen-types.mjs（json-schema-to-typescript）
src/generated/protocol-types.ts   ← 生成的 TS 类型，勿手改
        ↓ import + 组合
src/index.ts   ← 运行时常量/函数、泛型 CanonicalEvent、带 signal 的 InvokeRequest
```

目标是：当 daemon 后续被抽取为独立的 Go/Rust 二进制后（见 [orbtex-daemon 演进备注](../packages/orbtex-daemon/README.md)），**同一份 schema 可再生成 Go struct**，让跨语言的 `daemon -> host -> n*adapter` 两端共享一份结构定义，而不必手工同步类型。当前阶段只生成 TS，Go 生成留待引入 Go daemon 时接入。

这一步不改变任何公共导出面：`@orbtex-ai/orbtex-protocol` 导出的类型名与运行时函数全部保持不变，Core、Adapter Host 和所有 provider adapter 无需改动。

## 为什么用 schema 生成，而不是继续手写 TS

手写 TS 在单语言、单进程时最省事，但一旦要跨语言（TS host + Go/Rust daemon）就会出现**两端类型手工同步**的问题：任何一端漏改都在运行时才暴露。引入一份中立的协议定义，可以让类型、跨语言 struct 和运行时校验都从同一处派生，消除漂移。

关键前提是 **wire 是 NDJSON 纯文本，不做二进制压缩**。这个前提直接决定了选型方向：我们需要的是「协议定义 + 类型生成」，而不是「二进制序列化框架」。

## 选型对比

| 方案 | 定位 | 对本项目的契合度 |
| --- | --- | --- |
| **手写 TS 类型** | 无 IDL | 单语言时最简单；跨语言需手工同步 Go 类型，易漂移。现状要演进到 Go daemon，故淘汰。 |
| **Protobuf** | 二进制 wire + IDL | 主场是二进制 wire 与字段号兼容；我们是 JSON 文本 wire，其核心优势用不上。`oneof` 适合 union，但 proto3 JSON mapping 有 int64→string、默认值省略、任意对象需 `Struct` 等摩擦。 |
| **Thrift** | 二进制 wire + IDL（含 service/exception） | aily 采用，主因是字节内部 thrift-first 生态；其类型系统缺少 union/literal，需手写绕过。我们无该生态约束，且 union 需求强，不合适。 |
| **JSON Schema** ✅ | JSON 原生的 schema 语言 | 直接描述线上真实 JSON；`oneof`/`anyOf` 表达 union、`additionalProperties` 表达开放字典、`const`/`enum` 表达 literal，thrift 缺的它都有。**同一份 schema 还能在两端做运行时校验**，正好补上纯文本 wire「解析即校验」的缺口。 |

结论：在「NDJSON 不压缩 + 需要跨 TS/Go」的前提下，JSON Schema 是最贴合的协议定义语言。Protobuf 只有在决定把 wire 也换成二进制时才重新占优。

## 意义

1. **单一真值，消除跨语言漂移**：结构定义只在 schema 中存在一次，TS（现在）与 Go（将来）都由它派生。
2. **类型即校验**：schema 既生成类型，又可被 `ajv`（TS）/ `santhosh-tekuri/jsonschema`（Go）用于边界校验，且校验依据与生成类型同源。这对任意 JSON 文本 wire 尤为重要。
3. **描述内嵌契约**：每个字段的中文 `description` 直接进入生成类型的 JSDoc，也天然构成协议文档。
4. **演进路径清晰**：为后续 Go/Rust daemon 抽取铺好协议层，届时只需接上 Go 生成器，无需重写协议。

## 边界：哪些进 schema，哪些不进

schema 只描述**可 JSON 序列化的数据形状**。以下三类留在 `src/index.ts` 手写组合，因为它们不是纯数据：

- **运行时常量与枚举**：`CANONICAL_EVENT_TYPES` / `TERMINAL_EVENT_TYPES` 是 `as const` 数组，同时用于运行时 `Set` 校验，是「值」而非「类型」，保持单一运行时真值。
- **泛型 `CanonicalEvent<TType>`**：codegen 无法表达 TS 泛型；生成的 `CanonicalEventPayload` 被泛型壳复用。
- **携带 `AbortSignal` 的 `InvokeRequest`**：`AbortSignal` 是不可跨进程序列化的活对象。schema 只生成 `InvokeRequestWire`（不含 signal），`index.ts` 交叉出运行时用的 `InvokeRequest = InvokeRequestWire & { signal?: AbortSignal }`。这条边界与「函数/活对象留在调用侧、可序列化数据才过 wire」的原则一致。

## 工作流

```bash
# 改协议：编辑 schema
$EDITOR packages/orbtex-protocol/schema/protocol.schema.json

# 重新生成 TS（build 前会自动执行）
pnpm --filter @orbtex-ai/orbtex-protocol gen

# 构建（内含 gen）
pnpm --filter @orbtex-ai/orbtex-protocol build
```

`src/generated/protocol-types.ts` 带 `勿手改` 横幅；任何改动都应通过 schema 完成。后续引入 Go daemon 时，在 `scripts/` 下追加一个 Go 生成器读取同一份 schema 即可。
