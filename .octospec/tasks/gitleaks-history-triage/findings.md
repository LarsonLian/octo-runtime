---
type: Task
title: Issue 22 历史告警逐条处置台账
description: 固定基线复现的 45 个指纹及源码核验依据，不包含匹配值。
tags: [security, git, testing]
timestamp: 2026-10-19T14:45:00Z
source: self
---

# 历史告警逐条处置台账

原失败基线 `62d10ac46e7c2c3505b42c362229f7b91f328e5b` 与固定 main
`ab3ded527db4599f50bbab4c2045b4b025086f3d`，均使用 Gitleaks 8.30.1 内置规则：
45 条告警、45 个不同指纹、7 个历史提交、7 个文件。两次复现的指纹集合完全相同，
与 Issue 的规则/文件分布一致；main 无新增告警。全部核验为非秘密内容，待确认 0，确认凭据泄露 0。

## 核验依据

每行均检查其原始提交和文件，以下分类复用同一语义依据；不因测试目录或字段含 key 就放行。
候选值只在进程内核对，不复制到台账、日志或例外文件。

- **FP-R（30 条）**：所有匹配值均满足 UUID v4 格式。28 处是资源配置/协议 fixture，
  2 处是本地资源准备和协议测试，服务于资源增删、排序、重复身份和插件材料准备。
  提交 `86c8128c010b637fcc41a515d2b518e8dd3b3c63` 中，
  `packages/octo-harness-protocol/src/context.ts:225,332` 校验 UUID，
  `context.ts:187-190` 按种类/身份排序，`context-configuration.ts:7` 用作资源合并键；
  `packages/octo-harness-daemon/src/context-preparation.ts:105,194` 用作安装身份和缓存目录。
  `test/context-configuration-protocol.test.js:62-65` 验证相同 UUID 的不同资源种类独立；
  `test/context-preparation.test.js:11-15` 从内联测试材料构造资源。不是鉴权凭据。
- **FP-S（14 条）**：全部是相同的固定会话示例格式（conversation 加数字序号），在内联测试请求中使用。
  包含旧 `session_key` 3 条、`agent_session_key` 3 条及 `session_affinity_key` 8 条。
  提交 `617e401c3c5bb5dd025b18319bac875ee3cc6fc7` 的
  `packages/octo-harness-daemon/src/agent-work-runtime.ts:2346` 将旧字段映射为业务 sessionKey；
  提交 `13f02516ede14f51a2424c10f64921fb1be1f86a` 同文件 `:2547,2570`
  分别传递会话亲和键和执行会话标识。测试鉴权由独立工具授权/请求头表达，不由这些标识承担。
- **FP-D（1 条）**：提交 `ea1486fe153b63484a60e5f68df94596499ec8b6` 的 README 明确为本地 SSE 演示，
  配置 `:17` 与 curl 头 `:33` 使用同一人工可读的本地演示占位口令，含 local/demo/token 标识。
  该提交 `packages/octo-runtime-extra-sse-demo/src/index.ts:17-24` 强制调用方提供 token，无预置默认口令；
  `:80-84` 仅与调用方配置比较。因此是自行配置的合成文档样例，不是外部服务签发的凭据。
  判断不只依赖 loopback 地址；本项不代表实际部署可以安全复用文档口令，未执行网络有效性探测。

## 计数与证据边界

Issue 记载原 CI 扫描 454 个提交。本地仅保留固定 SHA 的 HEAD 及祖先，没有其他分支/tag refs：
原基线 Git 可达提交 477、Gitleaks 报告 444；main 可达提交 498、Gitleaks 报告 463。
扫描器计数不同于 Git 总数；CI 原完整 ref 集合未保存，不宣称精确复原该 CI 的扫描范围。
45 条告警的规则、文件及来源提交分布一致，两个本地基线的完整指纹集合逐项相同。
本台账给出原提交复现得到的全部指纹，不声称已独立下载并比较 CI 原日志中的完整指纹清单。

## 逐指纹处置

待确认告警及尚未处置的真实凭据必须继续阻塞扫描，Issue 保持开放。只有确认误报才添加例外。
下表全部有明确分类、依据和处置，不包含广泛路径、字段、提交或规则豁免。

| 编号 | 指纹（原提交:文件:规则:起始行） | 分类 | 依据 | 处置 |
| --- | --- | --- | --- | --- |
| F01 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-archive-runtime.test.js:generic-api-key:100` | 确认误报 | FP-S | 精确历史例外 |
| F02 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-archive-runtime.test.js:generic-api-key:101` | 确认误报 | FP-S | 精确历史例外 |
| F03 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-materials.test.js:generic-api-key:122` | 确认误报 | FP-S | 精确历史例外 |
| F04 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-materials.test.js:generic-api-key:124` | 确认误报 | FP-S | 精确历史例外 |
| F05 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-materials.test.js:generic-api-key:254` | 确认误报 | FP-S | 精确历史例外 |
| F06 | `13f02516ede14f51a2424c10f64921fb1be1f86a:test/task-materials.test.js:generic-api-key:255` | 确认误报 | FP-S | 精确历史例外 |
| F07 | `1e607474697679bf38e55c184310f06dd18ca461:test/task-archive-runtime.test.js:generic-api-key:101` | 确认误报 | FP-S | 精确历史例外 |
| F08 | `1e607474697679bf38e55c184310f06dd18ca461:test/task-materials.test.js:generic-api-key:124` | 确认误报 | FP-S | 精确历史例外 |
| F09 | `1e607474697679bf38e55c184310f06dd18ca461:test/task-materials.test.js:generic-api-key:255` | 确认误报 | FP-S | 精确历史例外 |
| F10 | `2c9f2a32fbabc6e2a8dd5b9f67428db012c49016:test/task-archive-runtime.test.js:generic-api-key:101` | 确认误报 | FP-S | 精确历史例外 |
| F11 | `2c9f2a32fbabc6e2a8dd5b9f67428db012c49016:test/task-materials.test.js:generic-api-key:277` | 确认误报 | FP-S | 精确历史例外 |
| F12 | `4bebb2ed3f1e1a3eb9fade054988f7fc2eedc85b:test/task-materials.test.js:generic-api-key:60` | 确认误报 | FP-S | 精确历史例外 |
| F13 | `4bebb2ed3f1e1a3eb9fade054988f7fc2eedc85b:test/task-materials.test.js:generic-api-key:132` | 确认误报 | FP-S | 精确历史例外 |
| F14 | `617e401c3c5bb5dd025b18319bac875ee3cc6fc7:test/task-archive-runtime.test.js:generic-api-key:99` | 确认误报 | FP-S | 精确历史例外 |
| F15 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:306` | 确认误报 | FP-R | 精确历史例外 |
| F16 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:323` | 确认误报 | FP-R | 精确历史例外 |
| F17 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:341` | 确认误报 | FP-R | 精确历史例外 |
| F18 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:346` | 确认误报 | FP-R | 精确历史例外 |
| F19 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:362` | 确认误报 | FP-R | 精确历史例外 |
| F20 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:365` | 确认误报 | FP-R | 精确历史例外 |
| F21 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:390` | 确认误报 | FP-R | 精确历史例外 |
| F22 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:409` | 确认误报 | FP-R | 精确历史例外 |
| F23 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:434` | 确认误报 | FP-R | 精确历史例外 |
| F24 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:452` | 确认误报 | FP-R | 精确历史例外 |
| F25 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:479` | 确认误报 | FP-R | 精确历史例外 |
| F26 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:501` | 确认误报 | FP-R | 精确历史例外 |
| F27 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:523` | 确认误报 | FP-R | 精确历史例外 |
| F28 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:553` | 确认误报 | FP-R | 精确历史例外 |
| F29 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:574` | 确认误报 | FP-R | 精确历史例外 |
| F30 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:601` | 确认误报 | FP-R | 精确历史例外 |
| F31 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-configuration-fixtures.json:generic-api-key:620` | 确认误报 | FP-R | 精确历史例外 |
| F32 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:2` | 确认误报 | FP-R | 精确历史例外 |
| F33 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:3` | 确认误报 | FP-R | 精确历史例外 |
| F34 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:4` | 确认误报 | FP-R | 精确历史例外 |
| F35 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:5` | 确认误报 | FP-R | 精确历史例外 |
| F36 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:513` | 确认误报 | FP-R | 精确历史例外 |
| F37 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:516` | 确认误报 | FP-R | 精确历史例外 |
| F38 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:538` | 确认误报 | FP-R | 精确历史例外 |
| F39 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:543` | 确认误报 | FP-R | 精确历史例外 |
| F40 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:585` | 确认误报 | FP-R | 精确历史例外 |
| F41 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:612` | 确认误报 | FP-R | 精确历史例外 |
| F42 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:packages/octo-harness-protocol/schema/context-fixtures.json:generic-api-key:637` | 确认误报 | FP-R | 精确历史例外 |
| F43 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:test/context-configuration-protocol.test.js:generic-api-key:63` | 确认误报 | FP-R | 精确历史例外 |
| F44 | `86c8128c010b637fcc41a515d2b518e8dd3b3c63:test/context-preparation.test.js:generic-api-key:13` | 确认误报 | FP-R | 精确历史例外 |
| F45 | `ea1486fe153b63484a60e5f68df94596499ec8b6:packages/octo-runtime-extra-sse-demo/README.md:curl-auth-header:32` | 确认误报 | FP-D | 精确历史例外 |
