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

## 保留预编译并合入 App 开发构建

用户最终选择保留预编译，不采用宿主直接编译 Runtime 源码的集成方式。两篇指南补充现有 `dev` / `build` 命令的合并示例：先按依赖顺序构建 Runtime，再编译宿主独立 Host 入口，最后执行宿主原有完整命令；保留原有类型检查、环境配置和打包步骤，不增加安装时 prepare 或额外脚本文件。CI 安装后执行已合并的 `pnpm build`，无需重复预编译。App 热更新沿用宿主流程，Runtime 源码变更需重新编译，不宣称自动监听 Runtime。

同时明确安装范围与构建范围的区别：`packages/*` 会使普通安装包含 WebUI 的开发依赖。OctoBuddy 示例增加 `!octo-runtime/packages/octo-runtime-webui-extra`，并移除只为 WebUI 安装准备的 watcher allowBuilds；宿主自己的 allowBuilds 继续保留。隔离 workspace 实测排除后发现 23 个项目，安装移除 132 个依赖包，lockfile 不含 WebUI importer；offline frozen-lockfile 重装及五包实际 import、公共依赖链路断言通过。两篇指南的 9 个 JSON/YAML 块、dev/build 命令 Shell 语法及前后步骤顺序、OKF 链接和 diff 检查通过。未运行真实 Electron 开发服务器或 IM 收发；本轮仅修改文档。

## 按 SDK 依赖闭包补齐排除项

用户要求继续排除 CLI 专用及其他不需要的包。核对包内 dependencies/devDependencies/optionalDependencies 及源码引用后，当前 cross-service 仅由 CLI 引用，用于系统服务管理；Gateway 接入还不需要企业微信 Extra 和 WebUI。Gateway 指南用 `!` 排除这三个包，基础 SDK 指南再额外排除 Gateway。需要某项 Extra 时先移除对应排除项，再声明宿主直接依赖并安装、构建。daemon/Host 当前依赖的所有 Adapter 仍保留，不按是否启用或包名猜测可排除范围。

文档配置与隔离宿主实际配置、宿主 lockfile importers 及从宿主直接依赖递归得到的内部依赖闭包逐项一致：Gateway 保留 20 个 Runtime 包，基础 SDK 保留 19 个 Runtime 包，均无多余 workspace 包或缺失内部依赖。Gateway 隔离宿主安装/frozen-lockfile 重装、20 包构建及五包 import 通过；基础 SDK 另建无 node_modules/dist 的源码副本，安装/frozen-lockfile 重装、19 包构建及四包 import 通过。两篇指南的 9 个 JSON/YAML 块、OKF 和 diff 检查通过。本轮仅修改文档，不改变 CLI 自身的依赖、Runtime 执行逻辑、Home 或身份，不进行线上接口验收。
