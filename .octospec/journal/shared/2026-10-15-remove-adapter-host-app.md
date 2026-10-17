---
type: Journal
title: 移除 AdapterHost app 实施与验证
description: 统一 package runner、保留独立 Host 进程并验证 CLI 和发行物。
tags: [architecture, runtime, testing, installation]
timestamp: 2026-10-15T00:00:00Z
---

# 实施结果

依据[任务](../../tasks/remove-adapter-host-app/brief.md)，先更新[基础架构](../../rules/architecture.md)，再移除 `apps/adapter-host` 的启动壳、package manifest、构建配置及 README。apps 只保留 CLI 与 daemon。

CLI daemon 的默认 Host 入口改为通过 `import.meta.resolve` 解析 `@mininglamp-oss/octo-runtime-adapter-host/runner`，与 SDK 使用同一个入口。保留命令行和环境变量的入口覆盖，以及原有独立子进程、stdio RPC、取消、异常收口和重启监督。

同步根 `host` 脚本、发行目录拷贝、根 files 清单、workspace lock、测试和当前文档。package README 承接独立进程与职责说明。发行验证明确断言 apps 只有 CLI 和 daemon，runner 随内部生产依赖携带。

未改变 CLI 命令或参数，Run=7、Context=v3 与 RPC 合同保持。没有删除或重新初始化已有 Home、Runtime 身份、profile、配置或运行状态，没有安装或重启 Provider。新的验证进程均从本次构建启动。当前系统全局安装未替换，本次全局安装验证使用独立 prefix。

# 自动化验证

| 检查 | 实际结果 |
| --- | --- |
| `pnpm build` | 通过，workspace 已无 Host app |
| `pnpm exec tsc -p tsconfig.json --noEmit` | 通过 |
| `pnpm lint` | 通过 |
| `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js` | 815 项：808 通过、7 跳过、0 失败；跳过项不计通过 |
| `uv run --with pyyaml python .octospec/scripts/lint.py` | 通过；系统 Python 缺 PyYAML，使用 uv 临时环境检查 |
| `git diff --check` | 通过 |
| 当前执行、测试、发行和指南的旧 app 路径搜索 | 无残留执行依赖；任务和规则中描述删除决定的文字保留 |

[新增入口测试](../../../test/daemon-runtime-options.test.js)验证默认 runner 解析及显式覆盖优先级。现有 CLI、Playboard、Extra、SDK 和跨包回归覆盖执行、Ctrl+C 取消及 Host 崩溃恢复。

# 发行物与真实执行

构建后执行 `node scripts/pack-release.mjs`，生成 `dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`。执行 `node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`：在隔离目录、空 npm 缓存及 offline 模式下全局安装成功，全局 CLI help/version、命令帮助、daemon 就绪和 12 个内置 Adapter 动态加载通过。包名导入限制仍有效；卸载移除测试包和命令，保留测试 Home，最后仅回收测试创建的临时目录。没有发布 npm。

执行 `node scripts/verify-playboard-live.mjs`，先只读请求 `https://im-test.deepminer.com.cn/`，HTTP 200。随后用本次构建的 CLI → 临时 daemon → package runner 分别调用真实 Provider：

| Provider | 退出码 | 终态 | 预期标记 | canonical 事件数 |
| --- | --- | --- | --- | --- |
| Codex | 0 | `run.completed` | 匹配 | 18 |
| OpenClaw | 0 | `run.completed` | 匹配 | 40 |

两次执行均无 stderr 诊断，请求仅要求返回标记，不调用工具、不修改文件、不发送消息。测试创建的临时 Home 与工作目录已回收，既有 Runtime 不受影响。

im-test 结果仅证明测试环境可达，真实模型结果证明本地新执行链路；不据此声称 IM 收发、云端登记或审批应答通过。本次未修改 UI、真实接口或 Run/Context 协议，没有重启桌面应用。实机平台为 macOS，Windows Named Pipe 未做实机验证。
