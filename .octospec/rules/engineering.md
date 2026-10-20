---
type: Rule
title: Runtime 开发与验证约定
description: TypeScript、协议生成、进程通信与验证证据的维护要求。
tags: [typescript, protocol, testing, integration]
timestamp: 2026-10-19T00:00:00Z
id: runtime-engineering
tier: repo
priority: 80
load_bearing: false
inject_when:
  paths: ["apps/**", "packages/**", "scripts/**", "test/**", "test-support/**"]
  touches: [typescript, protocol, testing, integration]
source: self
supersedes: []
---

# Runtime 开发与验证约定

## 需求与方案的强制范围检查

每个新增或修改需求必须先执行[基础架构的产品意图归属检查](architecture.md)，在对应 brief 记录业务目标、决定权归属、显式输入、合同内动作、越界动作及对其他接入产品的影响。先由第一性原理判断是否属于 octo-runtime，再选择实现位置；不能从旧兜底或技术实现方便反推职责。

评审必须拒绝下列设计：基础层替产品决定模式/思考强度/会话生命周期；省略字段触发未经约定的体验策略；为上游错误在下游猜测补造意图；将单产品默认推广至 SDK、CLI 和其他 Extra。明确合同内校验、原生映射、权限、资源并发保护及真实故障处理仍由各执行模块承担，但不能以这些技术责任为由改变业务意图。不得要求宿主理解 Provider 私有参数来弥补 adapter 未接线。

本要求是架构与评审约束，不宣称自动化检查能够识别全部职责越界。发现越界应修改方案和责任归属，而非仅添加风险说明或测试后保留越界行为。

## 工程与验证要求

- 使用严格 TypeScript ES modules，不显式使用 `any`；类型引用使用 type-only import，错误必须显式处理。
- Extra 核心代码须以中文注释说明关键合同和设计原因，包括函数/JSON 边界、资源所有权、实际在途额度、超时与取消竞态、清理失败及重载限制。注释应贴近对应接口或分支，不逐句复述实现；行为变更时同步更新，避免注释作出代码无法保证的内存或生命周期承诺。
- `pnpm build` 将源码 Git commit 与 dirty 状态写入 CLI 的 `dist/build-info.json`；版本命令及根帮助展示构建时的 `commit:<12 位短 SHA>`，未提交修改标记 `(dirty)`。发行物保留此元数据，运行时不查询用户当前目录的 Git；缺少 Git 来源时显示 `commit:unknown`，不得伪造为干净提交。
- 同一文件的 `buildTime` 为构建流程捕获的 UTC ISO 8601 时间，帮助和版本显示 `build:`；旧或无效元数据显示 `build:unknown`，不得用运行、安装或 commit 时间代替。发行矩阵共用一次构建会话时间；同版本恢复必须校验并复用原发行物时间，仍以完整 archive integrity 阻止不可变版本内容漂移。
- 协议 wire types 从 JSON Schema 生成。修改协议时同步 schema、生成类型、样例、调用端及测试，不手工只改生成文件。
- CLI 普通控制请求使用 Unix socket / Windows Pipe 单行 JSON；SDK 执行和订阅使用 JSON-RPC 2.0，daemon 到 adapter-host 使用 stdio NDJSON JSON-RPC 2.0。具体形状见 [本地传输合同](local-execution.md)。Provider 差异封装在 `octo-runtime-adapter-*` 内。
- 自动化测试使用 fake Provider，不调用真实模型。真实接口调试连接 `https://im-test.deepminer.com.cn/`，分别记录自动化检查与实际联调结果，不把 mock 结果当作线上证据。
- 按改动范围运行 `pnpm lint`、`pnpm typecheck` 和相关测试；跨包合同变更运行 `pnpm test`。纯文档改动检查 OKF 格式、索引与链接，无需触发真实模型执行。
- 修改 Run / Context 协议后，同步构建 Worker、Runtime 和桌面应用，重启受影响的本地进程，验证内置运行时注册及执行。仅完成全局链接不算重启验证。
- UI 或真实桌面接口变更，还须通过 CDP 驱动真实 renderer，对着线上测试环境验证；具体方法遵循生态根目录的开发约束。
- 凭据从受保护配置读取，不进入知识文件、模型上下文、日志、截图或提交。Provider workdir 不代表操作系统安全隔离。

## 稳定版单 registry 交付

- 源码保持 `0.0.0`；稳定 annotated tag `vX.Y.Z` 注入发行版本。完整 CI 验证的同一份 tgz
  只发布到 npm 官方仓库 `https://registry.npmjs.org`，并作为 GitHub Release 附件，不走 stage/审批转正。
- npm 使用 `NPM_TOKEN` 与 provenance；不发布、查询或回退到 GitHub Packages，不请求
  `packages` 权限。GitHub Release 是附件交付，不是另一个 npm registry。
- npm 已有版本必须匹配完整 SHA-512；恢复时只从 npm 验证并复用已发布归档的源码
  commit、clean 标记和构建时间。鉴权或网络错误不得当作缺包，上传后的可读性检查必须有界。
- 版本专属 dist-tag 不等于预发布流程。npm 与 Release 资产字节一致的最高完整稳定版自动
  推进 latest；两端已有稳定版 latest 都是不可回退的下界。RC 等预发布不进入候选集，不改 latest。
  dry-run 零远端写入。


## 历史密钥扫描的验收

- 历史告警逐条核验来源及实际用途，仅对有依据的非秘密内容添加原始 `commit:file:rule:line` 精确例外。
  待确认项和未处置真实凭据继续阻塞；禁止目录、字段、整个提交或检测规则的宽泛豁免。
- 固定基线 SHA 和 refs，临时仓库保留原始历史使例外实际生效，再新增非功能性 canary，
  验证原路径、原行号及邻近行的新密钥模式仍被完整历史和 PR 扫描拦截。
- 本地验证与托管 CI 分别记录；操作步骤和例外依据见
  [CI 指南](../../.github/CI.md#secret-scan历史告警与精确例外)。

架构与协议版本的约束以 [基础架构](architecture.md) 为准。本文件是开发要求，不表示上述所有链路在本次变更中均已验证。
