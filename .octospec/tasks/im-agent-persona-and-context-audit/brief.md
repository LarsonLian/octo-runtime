---
type: Task
title: IM Agent 默认人设配置与 Context v3 简化评估
description: 补齐两个 IM Channel 的人设默认配置与使用指引，关联 text-only instructions 改造并评估其他冗余设计。
tags: [channel, context, extra, invoke, protocol, documentation]
timestamp: 2026-10-16T00:00:00Z
---

# IM Agent 默认人设配置与 Context v3 简化评估

状态：2026-10-17 已随 Extra 改造实施 Runtime 指令协议、两个 Channel 的前置修复及三个 Extra/CLI 的显式人设配置示例。用户要求 SDK 接入先不改，HostApp 的配置生产者迁移及全 Provider 矩阵不标记完成；现有用户配置不自动重写。其他简化候选仍是评估。证据见[交付记录](../../journal/shared/2026-10-17-extra-initializer-delivery.md)。下文现状表保留为实施前排查依据。

## 目标与评估结论

两个 IM Channel 的默认配置和所有相关 Extra、CLI、SDK 使用指引，逐 Bot 显式带上“我是明略科技的Octo助理”。instructions 保持文本列表，每项只留 text，完整移除 source；同时审查 Context v3 的其他过度设计。2026-10-16 用户进一步确认本次支持破坏性更新、不考虑旧接口兼容；动态加载单独见[Extra 函数式初始化计划](../extra-initializer-context-dependencies/brief.md)。

必要性高，可复用已有 `config.bots[i].context`，无需新增 persona 字段或人格组件。主要成本是配置生产者和示例同步、已有执行准备与指令协议改造，以及真实 Provider 会话验证。更广的精简候选见[逐项评估](assessment.md)，候选不等于已决定删除。

正式类型是 `octo.control/instructions`，讨论中的 `app.control/instructions` 对应这一类型，不新增别名。Run=7、Context=`octo.context-envelope/v3` 保持独立版本。

## 当前实现与缺口

| 入口 | 已核对事实 | 缺口 |
| --- | --- | --- |
| Gateway `transport/contexts.ts` | 克隆 Bot 的 config.context.items，再追加本轮 IM 材料 | 没有内置默认人设，依赖宿主配置 |
| WeCom `transport/channel.ts` | 每轮克隆 config.context，省略时为空 v3 信封 | 同上 |
| 两个包的 contracts / 配置校验 / config-schema.json | 已有可选 context，校验完整 v3；配置 schema 只展开信封外壳 | 无需新字段；完整示例仍有空 items 或省略 context |
| CLI 指南及两个包 README | 多处完整 Bot 示例省略 instructions | 照抄容易漏配，多 Bot 需逐个覆盖 |
| SDK Channel Gateway 指南 | 已给一个 Bot 配置系统指令，第二个 Bot 省略，条目仍含 source | 覆盖不完整，格式须随协议升级 |
| 协议与配置层 | source 必填且参与配置层判断，指令用双换行拼接 | 目标为 text-only、单换行；已有独立计划 |
| 两个 Channel 的 dispatcher | 将完整 Context 传给 resolveLocalContext，后者拒绝控制指令 | 含 instructions 的请求可能在 Provider 启动前失败，复用已有修复任务 |

源码：[Gateway Context](../../../packages/octo-runtime-extra-channel-gateway/src/transport/contexts.ts)、[WeCom Context](../../../packages/octo-runtime-extra-channel-wecom/src/transport/channel.ts)、[Gateway dispatcher](../../../packages/octo-runtime-extra-channel-gateway/src/execution/dispatcher.ts)、[WeCom dispatcher](../../../packages/octo-runtime-extra-channel-wecom/src/execution/dispatcher.ts)、[执行 resolver](../../../packages/octo-runtime-executor-core/src/context.ts)。

“IM invoke 时没有配置入口”指消息触发流程没有宿主交互式填写人设的步骤。通用 InvokeInput 实际支持 contexts 和 controlInstructions，不能写成 invoke 协议没有指令能力。IM 的稳定入口是宿主提供 Bot config，Channel 将其组装为本轮调用输入。

## 关键合同

### 默认配置显式包含人设

两个 Channel 的新建 IM 配置模板和完整示例，每个 Bot 均包含以下 context。默认正文精确为 `我是明略科技的Octo助理`。

```json
{
  "context": {
    "schema": "octo.context-envelope/v3",
    "items": [
      {
        "namespace": "octo.control",
        "name": "instructions",
        "payload": {
          "entries": [
            { "text": "我是明略科技的Octo助理" }
          ]
        }
      }
    ]
  }
}
```

这是删除 source 后的目标格式，须与[统一执行与指令计划](../unify-execution-and-simplify-instructions/brief.md)一起交付。当前版本仍要求 source，暂不把该格式发布为已可运行的配置。

| 情况 | 目标行为 |
| --- | --- |
| 使用默认新建模板 | 宿主显式生成并保存上述配置 |
| 用户自定义人设 | 使用其 entries，保持顺序和原文，不夹带默认身份 |
| 已有配置省略 context，或显式空 items / 空 entries | 保持原语义，通用 loader、Host、Adapter 不暗中补人设 |
| 多 Bot | 每个 Bot 独立配置，不相互继承 |
| bot_name 与人设不同 | bot_name 只管展示，不生成或改写系统指令 |

“默认配置带上”由模板和宿主配置生产者落实，不是 JSON Schema 自动填值，也不是 extraset 保存时合并字段。CLI 继续接收完整声明，不新增隐式生成器。现有设备配置不因文档示例更新而自动改写。

### 指令列表与完整移除 source

- 保留 `payload.entries: { text: string }[]`，不压成单字符串，不新增分类。
- 按原顺序用单个 `\n` 拼接；保留正文空白、重复和内嵌换行，空列表得到空字符串。
- instructions.source 的 Schema、生成类型、运行时校验、配置层分支、构造器、fixtures、测试和现行示例一起移除，不新增替代来源字段。
- 保留真实身份认证、配置写入授权和 mandatory 强制约束；source 标签不是授权凭据。
- 普通材料和 extra.im 的 source 语义不同，单独审查，不全文替换删除。

### 旧数据与兼容处理

沿用已有指令计划：新消费者不保留旧 source 解析、自动剥离或双格式回退。旧结构进入新入口时明确拒绝，不能丢弃整份人设后继续。

本次不安排旧数据自动迁移或兼容层。实际生产者、当前受控示例及宿主构造代码一次性更新为 text-only；旧输入在新入口明确失败。活动配置由其所有者按新合同重新提供，不要求 Runtime 理解和转换旧格式。本轮不扫描或修改用户数据库、Home、profile 或配置。

历史 Event/Run 的不可变快照和 hash 保留原文，不批量删 source 或重算 hash。需要重放为新调用时，由业务方明确生成当前格式。本计划不保证旧快照原样可重新执行。无法协调升级的仓外消费者须列为部署约束，不静默恢复兼容分支。

### 责任与生效时机

宿主提供 config → Channel 克隆 Bot Context、构造公开 InvokeInput → Host 统一准备 → Adapter 按 Provider 会话合同使用指令。

Channel 不自己解析内部执行计划，前述错误引用已有修复任务，不新建另一条实现。Host 不读 Bot 配置或人格文件，不按 session 补历史。Channel 每轮提交配置指令与 Adapter 新会话初始化使用指令是两个步骤，不能混为每轮重复发送 system。

人设修改先按 Extra 整体重载流程加载完整新配置，再按已有合同显式新建或 reset Provider 会话。仅保存或连接绿点不证明人设已应用；不新增逐 Bot 热更新接口，不重置 Runtime 身份。普通业务 Context 继续逐轮处理。

## 实施计划

- [ ] M1：完成已有统一执行与指令任务，修复准备路径，完成 text-only 协议、生产者与消费者同步。
- [ ] M2：补齐两个 Channel 的完整 Bot 示例、schema examples 和宿主新建模板；逐 Bot 显式默认人设，自定义可替换。
- [ ] M3：更新 CLI、Extra、SDK 指引，说明列表、多条拼接、空值、旧配置更新和保存/重载/新会话的生效条件。
- [ ] M4：完成真实链路验收并记录版本；其他 Context 精简候选逐项决定，不直接扩大删除范围。

说明盘点：`CLI_USAGE_GUIDE.md`、`SDK_CHANNEL_GATEWAY_GUIDE.md`、`SDK_NATIVE_INTEGRATION_FULL_GUIDE.md`、`apps/cli/README.md` 与帮助、两个 Channel README / config-schema.json、`.octospec/guides/extra-configuration.md`、`skills/octo-runtime/SKILL.md`。涉及 IM 配置的完整示例必须展示人设；导航入口链接完整示例。

所有 Extra 使用指引均检查适用性：通用 Extra 开发示例说明业务方通过 InvokeInput.contexts 显式提交指令；WebUI 按自身公开合同说明，不能假造 config.bots。普通 playboard、WebUI 和其他产品不自动套用 IM 默认人格。

## 验收

- [ ] 两个 Channel、CLI、SDK 和 schema 完整示例逐 Bot 带 text-only 默认人设，正文精确匹配，多条指令保持列表。
- [ ] 真实配置加载、消息触发和 Host 调用通过，不再因控制项误入执行 resolver 失败，不通过放宽 resolver 掩盖错误。
- [ ] 自定义不夹带默认身份，多 Bot 隔离，空值保留；现有 Home/配置不被自动改写。
- [ ] 活动生产者、生成类型和现行示例移除 instructions.source；历史记录和明确拒绝旧结构的负例可保留历史文本。
- [ ] 真实 Provider 新会话收到精确指令，续聊、reset 和适用的 fresh fallback 符合已有计划；以原生请求证据为准，不只看模型自我介绍。
- [ ] Octo IM 使用 `https://im-test.deepminer.com.cn/` 验证配置、收发和失败展示；WeCom 用真实测试 Bot 验证，缺条件则标待验。
- [ ] 协议修改同步构建 Worker、Runtime、Work App，重启受影响本地进程并验证注册/执行；涉及桌面入口时通过 CDP 验证线上测试环境 renderer。
- [ ] 实施时按范围运行 build、typecheck、lint、lint:names、Node 相关测试与跨包全量回归，分开记录本任务和依赖任务证据。

本轮只做源码评估和 OKF 格式/索引/链接检查，未运行模型或线上功能测试。实施后调试必须使用线上测试环境，未验收项不得标为已完成。

本轮文档检查：`uv run --with pyyaml python .octospec/scripts/lint.py` 通过，检查 170 个 OKF 单元、20 条规则及 1377 个本地文件链接；`git diff --check` 通过。系统及 bundled Python 缺少 PyYAML，使用 uv 临时依赖执行，未修改仓库依赖。
