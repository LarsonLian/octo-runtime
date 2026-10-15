# 工程知识变更记录

## 2026-10-15

- 确认 [Adapter 装配归属](tasks/adapter-composition-ownership/brief.md)：CLI 与 SDK 嵌入代码各自选择，Host 按选择加载；配置载体由各自决定。依赖、裁剪和包体由宿主 App 自行管理，不作为 Runtime 的包体承诺。记录启动传递、缺包、空集合及已有 daemon 冲突的影响；对接文档、可运行示例和加载关键代码的详细中文注释为必须交付项。本次仅更新文档，未改代码或安装包。

- 按[任务](tasks/remove-adapter-host-app/brief.md)移除 Host app 启动壳，CLI daemon 与 SDK 统一启动 package runner；保留独立进程和全部 CLI 功能，更新发行物及测试。808 项回归通过、7 项跳过，离线安装、12 个 Adapter 加载及真实 Codex/OpenClaw 调用通过，范围见[记录](journal/shared/2026-10-15-remove-adapter-host-app.md)。

- 落实 [CLI 设备级 extras 配置目录](tasks/device-extra-directory/brief.md)：唯一读取 `<home>/extras`，Extra 命令拒绝 profile，不增加旧布局探测或迁移；58 项相关回归与限定范围实机验证通过，见 [记录](journal/shared/2026-10-15-cli-extras-directory.md)。

- 按[任务](tasks/unify-invoke-transport/brief.md)统一 Host、RPC、daemon 与 CLI 的输入及 signal 环境参数；执行准备只在 Host，删除旧三参数 HostInvoke/createHostInvoke 及无消费者的 wire-options，源帧与视图共用同一输入。[验收记录](journal/shared/2026-10-15-unify-invoke-transport.md)包含可重复 CLI 命令、真实 Playboard 和 Work App 结果及未覆盖范围。

- 按[任务](tasks/remove-context-snapshot/brief.md)删除通用执行协议的 contextSnapshot 和 ChannelContextSnapshotRef，同步 schema、生成类型、校验、Core 转发及测试；记录 Host/RPC 输入统一和 Host 单一执行链的目标，当前内部链路尚未改造。验证结果见[记录](journal/shared/2026-10-15-remove-context-snapshot.md)。

- 修复 Extra dispose：IM 停止信号贯通建联与执行，关闭等待真实资源释放并汇总失败；SDK 加载期间可取消，旧账号停止不作用于新进程。全量回归及限定范围 im-test/CDP 通过，见[修复记录](journal/shared/2026-10-15-extra-dispose-repair.md)。

- 按[任务](tasks/remove-business-scenarios/brief.md)删除通用协议的 ScenarioRequest、场景常量、builder 白名单和校验导出；业务自行构造 Context，Channel Gateway Extra 仍为业务接入层，Work App 测试程序不构成兼容约束。验证结果见[记录](journal/shared/2026-10-15-remove-business-scenarios.md)。

- 按[任务](tasks/remove-unused-plan-fields/brief.md)删除未消费的 required_execution_features 和 provider_compatibility；同步 schema、生成类型、校验及样例。补充场景白名单、渠道快照和内部派生参数的[调用链澄清](journal/shared/2026-10-15-protocol-simplification-review.md)，验证及未完成范围见[记录](journal/shared/2026-10-15-remove-unused-plan-fields.md)。

- 补充 [Runtime 总体协议与调用设计](rules/protocol-design.md)：串联公共输入、两层 RPC、Host 输出、Provider 调用、审批／追问往返及取消续流；登记规则索引并接回专项文档。仅整理当前合同，验收见 [记录](journal/shared/2026-10-15-protocol-design-overview.md)。

- 按[任务简报](tasks/remove-business-capability-contract/brief.md)删除自有 Adapter capabilities、执行计划 required_capabilities 和 ExecutionTarget 预留设计；业务标签归业务方，真实执行与 Provider 原生握手协议独立保留。现行规则改为 [Adapter 执行元数据](rules/adapter-metadata.md)，验证范围见[实施记录](journal/shared/2026-10-15-remove-business-capability-contract.md)。

- 实施 [Playboard 统一 daemon 执行](tasks/playboard-daemon-execution/brief.md)：移除 CLI 的 Provider 特殊装配，复用 daemon 启动与本地 RPC，隔离 PID/socket/账本，保留既有配置和常驻实例。构建、类型、lint、全量回归和真实 Codex/OpenClaw 执行通过，线上环境与未验收边界见[验证记录](journal/shared/2026-10-15-playboard-daemon-execution.md)。

- 按用户架构图记录 [实体设备、虚拟 Runtime 与 Extra 归属澄清](tasks/device-virtual-runtime-boundary/brief.md)：Extra 属于设备 Host，Runtime 为虚拟身份，个人／组织归属由业务插件管理；列出旧定义问题、profile 收敛与保留迁移要求。撤回 S1 的 P1 发布阻断定性，字段校验和文件保护问题仍未修复。本次仅更新文档。
- 记录 [Playboard 统一 daemon 执行决策](tasks/playboard-daemon-execution/brief.md)：复盘直接启动 Host、重复 Provider 装配及 RPC 层次混淆，明确临时 daemon、状态隔离与验收要求；本次仅写入 OKF，代码和线上验收待实施。

- 按后续授权实施 Extra 责任收敛：删除 onConfigure 和业务 RPC，宿主以完整配置卸载重载；增加默认同步状态，插件内部配置错误跳过并报告。SDK、CLI、三个插件与 Work App 已同步，自动检查和限定范围 im-test/CDP 验证通过；未验收边界见[实施记录](journal/shared/2026-10-15-extra-responsibility-implementation.md)。

- 修复 Alpha review F2：Octo/WeCom 回收闲置会话调度条目，移除累计 128 个会话门槛，旧卡片重试进入当前队列。双渠道分别验证模拟每日一万个会话，追加 [评审修正状态](journal/shared/2026-10-15-alpha-code-review.md)及[验证记录](journal/shared/2026-10-15-im-session-scheduling-release.md)；完整 AdapterHost 无缓存目标、S1/F1 保持待实施。

- 按用户决策收敛 Extra 责任边界：宿主管理卸载、配置修改和重载；沿用 onDispose，增加必备且默认返回空对象的同步状态能力。记录[原设计问题、责任分配和后续验收](tasks/extra-responsibility-boundary/brief.md)，同步架构、Extra 规则及指南状态说明。本次仅写入 OKF，未实施或验收代码调整。

- 在当前分支实施渠道 octo-cli 环境覆盖与 CLI OpenClaw dotenv 同步；更新环境/本地执行合同、Schema、调用链及回归测试。构建、全量检查、im-test 只读请求与内置 Runtime 工具执行通过，未验收边界见[实施记录](journal/shared/2026-10-15-channel-octo-cli-design.md)。

- 补充渠道 octo-cli 的 OpenClaw 例外：CLI 向实际加载的全局 `.env` 写两项变量，同一文件后写覆盖前写，人工重启；保留每轮 envs 不支持的真实边界，见[方案](tasks/channel-octo-cli-environment/brief.md)。

- 记录 channel-gateway 使用 octo-cli 的渠道执行环境约束与[改造方案](tasks/channel-octo-cli-environment/brief.md)：使用连接凭据覆盖两个 OCTO 变量，不写入 Context，不改变桌面身份选择；实现与线上验收尚未执行。

- 将 OpenClaw 自动发现和刷新移到 CLI 启动编排，SDK 显式配置，Adapter 只读连接；见 [合同](rules/openclaw.md)与[验证记录](journal/shared/2026-10-15-openclaw-cli-discovery.md)。

- 接入 octo-spec / OKF，补充中文 Agent 入口、规则索引与工作流。
- 将架构正文迁入 `rules/architecture.md`，根目录仅保留导航。
- 验证记录见 [接入与架构迁移](journal/shared/2026-10-15-okf-onboarding.md)。
- 按当前源码与 Git 演进审查全部 31 份旧材料，整理为规则、指南和历史摘要，移除根与协议包的 docs 目录。
- 修正过时接口与未实现拓扑，补充规则索引和本仓知识/链接校验；结果见 [全量整理验收](journal/shared/2026-10-15-knowledge-consolidation.md)。
