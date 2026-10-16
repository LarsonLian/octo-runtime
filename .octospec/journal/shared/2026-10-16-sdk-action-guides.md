---
type: Journal
title: SDK 按宿主操作拆分
description: 完整原生与 Channel Gateway 两篇从 Electron 实际操作开始，旧文档收敛为导航。
tags: [documentation, runtime, installation]
timestamp: 2026-10-16T00:00:00Z
---

# SDK 按宿主操作拆分

按用户反馈新增 [完整原生接入指南](../../../SDK_NATIVE_INTEGRATION_FULL_GUIDE.md)与 [Channel Gateway 指南](../../../SDK_CHANNEL_GATEWAY_GUIDE.md)。前者按启动 Runtime、配置特性、可选直接调用 Agent 组织；后者作为 OctoBuddy 推荐入口，覆盖 submodule、宿主 workspace/package.json、Codex/OpenClaw 注册、IM 文件格式、SDK 启动及配置重载。原 SDK 文档只保留选型导航，概念与协议通过源码和规则链接查阅。

示例使用当前 SDK：主进程 startAccount 启动 daemon/Host；Gateway 重载明确卸载、保存、加载，并串行处理设置操作。宿主读取文件后传对象，不给插件增加文件取值机制。OpenClaw 按实际账号及租户 profile 配置 URL/Token，保持设备身份；不误用 IM bf_token。当前 daemon/Host 传递依赖仍含其他 Adapter，不把选择加载两个写成依赖自动裁剪。

验证通过：两套完整 TypeScript 示例按 strict/NodeNext、skipLibCheck=false 检查均为零诊断；Electron API 使用最小环境类型声明，SDK 及内部依赖使用当前编译声明。5 个 JSON 代码块可解析，直接 workspace 依赖均对应真实包；IM 示例将 Token 占位符替换为非秘密样例值后通过实际 Gateway schema。34 处 SDK 指南链接和章节锚点通过。

原样提取 IM 配置函数，在隔离内存文件及模拟 Runtime 中执行：首次加载、串行保存、停用、卸载失败不覆盖文件、加载失败保留最新保存配置、失败后重新加载、拒绝其他模块均通过。此验证覆盖宿主编排，不代替 Electron 实机与真实 IM 收发验收。

OKF lint 与 git diff --check 通过。本轮仅文档；不修改产品运行代码、不重启服务、不进行真实 IM 收发，也不改变既有 Home、身份及 SQLite。

## 宿主相对路径引用修正

上一轮 Agent 将路径要求误解为绝对路径。用户已纠正：子仓在宿主项目的 `octo-runtime/` 子目录，各包通过相对路径引用。两篇指南统一使用 `link:./octo-runtime/packages/<包目录>`，submodule 和构建命令也使用 `octo-runtime`。Runtime 各 package 不改，宿主不修改 workspace，先在子仓执行 frozen-lockfile 安装及过滤构建，再安装宿主。Runtime 内部 `workspace:*` 继续由其自己的 workspace 解析；`link:` 不替目标包安装依赖。

宿主示例直接依赖仍为 daemon、Host、Codex、OpenClaw，IM 再加 Gateway。protocol、core、adapter-sdk 等已由内部包声明，子仓负责安装和构建；宿主直接 import 时再添加直接依赖。当前其他 Adapter 仍在传递依赖中，加载两个不代表裁剪安装依赖，正式发行需完整生产依赖闭包。相对路径以声明依赖的 package.json 为基准，开发机与 CI 保持相同子目录即可使用。

在无 pnpm-workspace.yaml 的隔离宿主中，将现有 Runtime 仓映射到 `octo-runtime/` 子目录，以与文档完全一致的 5 条相对 `link:` 依赖执行 pnpm 11.19.0 离线安装成功；两篇指南 JSON 与包路径校验通过。Node 实际导入 5 包成功，从 daemon 入口解析 protocol/core/adapter-sdk 成功，且宿主没有这三项直接依赖。只验证导入与依赖解析，不启动 daemon、Host 或 IM。行为依据同时核对 [pnpm link 官方文档](https://pnpm.io/cli/link)。

## 宿主统一 pnpm workspace（当前方案）

用户随后明确改用统一 workspace，取代上节的独立子仓安装与 `link:` 接入步骤。要求使用 pnpm 安装和构建；submodule 在 `octo-runtime/`，开发来源为 GitHub 的 `feat/open-source-github` 分支。第一步配置宿主 `pnpm-workspace.yaml`，纳入 `octo-runtime/packages/*`；第二步在宿主 package.json 添加 `workspace:*` dependencies。宿主统一安装、过滤构建并维护 lockfile，不新增宿主构建 script。两篇 SDK 指南与工作区指南已同步；子仓原 workspace 文件及 lockfile 保留，集成时从宿主根目录执行。范围及验收见[任务记录](../../tasks/sdk-host-workspace/brief.md)。

使用无 node_modules/dist 的独立仓库副本验证，宿主只声明五个直接包。首次构建发现七个 Adapter 直接 import protocol 而未声明直接依赖；已在各包补齐 `workspace:*` 并同步 Runtime lockfile，修复依赖声明所在边界，不让宿主添加公共包来掩盖缺失。全部包纳入 workspace 不表示自动启用全部 Adapter/Extra。

pnpm 11.19.0 实测发现首次安装的原生依赖构建需要宿主显式允许：示例合并 `esbuild` 与 `@parcel/watcher` 的 allowBuilds，保留宿主现有配置。修复后宿主安装及 offline frozen-lockfile 重装通过，发现 24 个 workspace 项目；Gateway 及其依赖闭包的 20 个包全部构建通过。Node 实际导入 daemon、Host、Codex、OpenClaw、Gateway 成功，`OpenClaw → adapter-sdk → protocol` 链路断言通过。两篇指南的 7 个 JSON/YAML 代码块全部可解析。该验收仅验证安装、构建和模块解析，不启动 Provider、不连接 IM，不改变已有 Runtime 身份、Home 或配置。
