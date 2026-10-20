---
type: Journal
title: "Windows manifest 模块路径修复与本地验证"
description: "Issue #37 的内部 loader 修复、原生 Windows 回归及后续独立失败。"
tags: [adapter, testing, windows]
timestamp: 2026-10-19T12:15:00Z
source: self
---

# Windows manifest 模块路径修复与本地验证

## 结果与范围

[Issue #37](https://github.com/Mininglamp-OSS/octo-runtime/issues/37) 的路径加载修复已完成。专门回归 14 通过、0 失败、1 个 POSIX 专用检查跳过；Windows 绝对路径、相对路径和 file URL 均经真实 Host 子进程完成就绪、执行和关闭。任务及边界见[brief](../../tasks/windows-manifest-module-paths/brief.md)。

提交前在最新 main（ab3ded527db4599f50bbab4c2045b4b025086f3d）重新验证：Node 1249 项中 1166 通过、53 失败、0 取消、30 跳过；WebUI UI 35/35 通过。typecheck（含构建）、format:check、lint、lint:names 均通过。全仓仍未通过，剩余失败名称与初次修复验证一致。

初次修复验证基于 6fee2e1828587c26c97d185a60590d956ee10192：Node 1239 项中 1156 通过、53 失败、0 取消、30 跳过，WebUI UI 35/35 通过。原修正基线为 1224 项、1138 通过、57 失败、29 跳过。新增 15 项中 14 通过、1 跳过，旧失败减少 4 项；剩余 53 个失败名称均属于原 57 项，但其中部分已推进到新的失败阶段。不能把名称相同解释为根因没有变化。

## 环境与隔离

- Windows 11 企业版 10.0.22621，x64，PowerShell 5.1.22621.1778，普通用户，非 WSL。
- Node 24.22.0；pnpm 11.19.0；Codex CLI 0.163.0，仅记录版本，未运行模型。
- 本地分支 fix/windows-manifest-module-paths，基线 6fee2e1828587c26c97d185a60590d956ee10192。构建元数据 dirty=true，buildTime=2026-10-19T12:04:15.188Z。
- 新建独立 octo-runtime-issue-37 worktree；原主工作区保持干净，已有 Windows 基线工作区的未提交内容保留。测试专用 Home/temp 位于兄弟目录 octo-runtime-issue-37-test-data，不在任一 Git checkout 内。
- 工具链使用已安装的 Node/pnpm，绕过会强制切回原仓库的 .run/pnpm.cmd。仅在本 worktree 安装依赖、构建、运行测试；不修改全局 PATH/security 或现有 Bot/Runtime 配置。
- 子进程环境采用 OS/工具链白名单，不继承凭据及 live flags；所有执行测试使用 fake Provider。安装使用 frozen lockfile、已有 pnpm store，忽略安装脚本后单独执行 typecheck 构建；没有修改锁文件。
- API 核对远端 ab3ded527db4599f50bbab4c2045b4b025086f3d 的 #35/#36 为发行流程变化，无 loader 或本次测试变化。提交 PR 前已通过 SSH 更新到此 main；下方初次验证结果仍明确归属原实现基线。

## 原因与修改

旧 runner 仅识别点或正斜杠前缀，Windows 盘符路径到达 import 时被当作 c: URL scheme。修复前现有 focused test 的完整错误为 ERR_UNSUPPORTED_ESM_URL_SCHEME，并明确显示 “On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'”；`.cache/issue-37/baseline-focused.log`（仅本机保留）保留完整堆栈。

内部 module-specifier helper 使用本机 node:path.isAbsolute 识别盘符、UNC、POSIX 绝对路径；文件路径经 pathToFileURL 转换，保留特殊字符。以点开头的路径继续相对 manifest 所在目录解析；包名、子路径和现有 URL 原样交给 Node。runner 的导出校验、工厂调用、Adapter 类型检查、注册和生命周期没有变化。

helper 未加入 package exports 或 SDK index。六个声明产物（Host index/process/rpc/runner、public extra/protocol）的 SHA-256 与原基线一致，见`.cache/issue-37/public-types.json`（仅本机保留）。package.json、公开 exports、协议 schema、生成类型、调用签名及锁文件均无 diff；测试直接沿用现有 spawnAdapterHost、invoke 与 close，调用方无需 OS 选项或路径转换。

完整原始日志与诊断脚本保留在本机忽略目录，不随 PR 上传；本记录提供可复核的命令、结果及对应仓库测试。

## 最新 main 提交前复核

2026-10-19 更新 PR 分支至 ab3ded527db4599f50bbab4c2045b4b025086f3d 后，重新执行以下命令；日志保留在本机忽略目录 `.cache/issue-37/`。

| 检查 | 结果 | 本机日志 |
| --- | --- | --- |
| pnpm typecheck | 退出 0，含 workspace 构建 | pr-typecheck.log |
| pnpm format:check、pnpm lint、pnpm lint:names | 全部退出 0 | pr-format-check.log、pr-lint.log、pr-lint-names.log |
| pnpm test:suites | 退出 1；Node 1249 项：1166 通过、53 失败、0 取消、30 跳过；WebUI UI 35/35 | pr-full-suites.log |

最新完整测试包含本次 manifest 回归，仍为 14 通过、0 失败、1 POSIX skip。新增主分支测试全部通过，剩余 53 个失败名称与初次修复验证一致；下方逐项结果和覆盖限制仍适用。

## 初次修复检查结果

命令均在本 worktree 由`.cache/issue-37/run.mjs`（仅本机保留）执行。命令、UTC 起止时间及退出码见`.cache/issue-37/commands.ndjson`（仅本机保留）。

| 检查 | 结果 |
| --- | --- |
| pnpm install --frozen-lockfile --offline --ignore-scripts（显式本机 store） | 退出 0 |
| 修复前 pnpm typecheck | 退出 0 |
| 修复前 tool overrides focused test | 退出 1，真实 c: ESM 错误 |
| 修复后 pnpm typecheck | 退出 0；沿用产物执行后续测试 |
| pnpm format:check、pnpm lint、pnpm lint:names | 全部退出 0；仅格式化本次修改的代码 |
| node --test test/adapter-host-manifest.test.js | 退出 0，14 通过、1 POSIX skip |
| node --test test/channel-tool-environment.test.js test/cli.test.js test/playboard.test.js | 退出 1，29 项中 14 通过、15 失败 |
| pnpm test:suites | 退出 1；Node 1156/53/30，WebUI UI 35/35 |
| git diff --check；生成类型/锁文件/公开入口 diff 检查 | 通过，无漂移 |
| 原仓库 .octospec/scripts/lint.py | 退出 1；14 个已有跨仓库 Markdown 链接在当前机器无目标，未修改对应文件；本次知识文件无新增报错 |

专门回归覆盖 Windows 正反斜杠盘符、UNC（不访问共享）、中文、空格、#/% 编码，manifest 相对路径和两种 Windows 分隔符，file URL 与包解析，缺失文件/包、缺失导出、无效 Adapter 与语法错误。正向调用检查唯一 run.completed、预期回复、输入不被改写，以及有界 close 后子进程真实退出。

## Issue 的 12 项直接失败复测

下表结果在指定三文件复测及随后全套测试一致；`.cache/issue-37/affected.log`（仅本机保留）、`.cache/issue-37/full-suites.log`（仅本机保留）均保留。

| 原直接失败用例 | 修复后实际结果 |
| --- | --- |
| tool overrides cross a real Host subprocess and reach child tools without changing Context | 通过，包括该次关闭后日志断言；不代表 #38 普遍修复 |
| adapter-host readiness timeout advances the restart staircase | 导入错误消失；继续到测试提供的 d.sock，listen EACCES |
| daemon close cancels a hung adapter-host replacement handshake | 导入错误消失；继续到测试提供的 d.sock，listen EACCES |
| temporary daemon renders ordered context and leaves no identity or process state | 执行已完成，关闭阶段 PLAYBOARD_DAEMON_EXITED_ABNORMALLY |
| real Codex adapter emits native frames through temporary daemon IPC | 关闭阶段异常退出，测试未能完成后续断言 |
| native pending interaction fails without hanging or auto-approving | 关闭错误覆盖预期 PLAYBOARD_INTERACTION_REQUIRED |
| real Codex adapter emits canonical frames through temporary daemon IPC | 关闭阶段异常退出，测试未能完成后续断言 |
| canonical pending interaction fails without hanging or auto-approving | 关闭错误覆盖预期 PLAYBOARD_INTERACTION_REQUIRED |
| Ctrl+C cancels execution and reaps the temporary daemon and Host | 已输出 fixture 消息；实际 code=null，测试期望 130；尚未证明完整取消合同 |
| malformed stdin, unknown arguments and unsupported native mode fail clearly | 通过 |
| temporary IPC and parallel playboards preserve a resident daemon and persistent profile | 导入错误消失；测试提供的 resident.sock 在 listen 阶段 EACCES |
| OpenClaw uses daemon startup configuration, refreshes its source and retains device identity | 关闭阶段异常退出；不声称后续全部配置/身份断言已验收 |

三项原受阻断言：

| 用例 | 修复后实际结果 |
| --- | --- |
| provider failure and deadline exit nonzero with terminal frames | 通过 |
| closing the NDJSON consumer cleans up Host and provider execution | 通过 |
| cancelling daemon startup waits for resource cleanup and preserves prepared configuration | 关闭阶段异常退出覆盖 startup cancelled；后续清理/配置断言仍未验收 |

## 新暴露的独立关闭问题

未修改产品代码的`.cache/issue-37/probe-close.mjs`（仅本机保留）只给当前探针子进程加载退出事件观察器。使用绝对路径 fake Adapter，实际收到最后一帧 run.completed；随后 daemon exit 事件为 code=null、signal=SIGTERM，CLI 最终 code=1，并返回 PLAYBOARD_DAEMON_EXITED_ABNORMALLY，见`.cache/issue-37/playboard-close-probe.log`（仅本机保留）。

对应源码 apps/cli/src/temporary-daemon.ts 的 close 先 child.kill("SIGTERM")，随后以 code !== 0 报异常；启动失败/取消的 catch 又先 await close，可能覆盖原错误。这是 loader 之后的独立生命周期问题，不能通过修改 #37 的导入判断解决。本轮没有修改该文件或把问题归为已解决；后续与 #13/#38 的关闭工作协调，但不将 Playboard 问题自动等同于 #38 的日志根因。

其余三文件失败包括 F24 的 POSIX 0600 断言，以及已有 Unix socket fixture 假设。全套中的 F31 日志失败和 WebUI HTTP 500 仍存在，分别继续由 #38/#39 跟踪；不修复无关失败、不弱化断言。

## 覆盖限制与知识回流

- macOS/Linux 未运行，Windows 10 未运行；POSIX 专用用例已加入，等待对应机器运行。同平台转换测试不替代真机跨平台验收。
- UNC 只验证正确 file URL 转换；未验证实际网络共享可用性。
- 原 29 个 skip 及文件级测试异常仍是原有覆盖缺口，本次新增 1 个 POSIX skip；未启用真实模型、业务 API 或长时间任务。
- 文档检查的 14 个错误均指向本机未具备的兄弟仓库，不能将全仓知识校验标为通过。
- 单一发行包构建/安装验收、真实 SDK 消费产品、#14 总矩阵不在本次范围；本地修复不等于发布完成。
- 将本机路径识别、manifest 相对解析及 SDK 无平台分支的可复用合同写回 [Adapter 元数据规则](../../rules/adapter-metadata.md#manifest-模块路径)。此次不添加新的产品策略或公开选项。
