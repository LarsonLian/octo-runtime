---
type: Journal
title: 英文协作说明与首次 PR 工程检查
description: 记录 Node 24、共享测试、格式门禁与 main 保护的实现及本地和远端验证边界。
tags: [ci, testing, documentation, git]
timestamp: 2026-10-17T00:00:00Z
---

# 英文协作说明与首次 PR 工程检查

需求见[任务](../../tasks/company-development-checks/brief.md)。按用户明确要求，CONTRIBUTING、GitHub CI 说明和 PR 模板使用英文；内部知识记录保留中文。删除说明中的旧架构、旧目录、SQLite 队列和 Node 20 要求，SDK、独立 AdapterHost、Extra 与宿主责任按当前合同描述。

## 实现与范围

- Node 统一 24.x，根包与 cross-service engines 为 >=24 <25，.nvmrc 为 24；CI 使用 node-version-file，发行流程原有固定 24 保持一致。README、CLI/SDK/部署指南和受影响 Adapter 的前置条件同步。
- pnpm test 构建后调用 test:suites，CI 经过 typecheck 构建后调用同一测试集合，保留既有调试插件 35 项测试，不新增生产 UI 验收。
- Prettier 明确自有源码、测试、脚本、JSON/YAML 配置、GitHub 协作文件和 CONTRIBUTING 范围，命令的 write/check 模式使用同一文件集合。协议生成类型、锁文件、上游同步浏览器源码及历史知识正文不机械格式化。对 130 个源码/测试/脚本等既有文件逐个核对：当前内容等于 HEAD 内容经 Prettier 格式化的结果，没有夹带业务修改；cross-service 后续仅另行收紧 Node engines。
- 命名门禁发现此前 SDK 文档中的本机绝对路径包含旧名称，改成指向同一外部 demo 文件的相对链接，不修改 demo。
- CI Gate 等待 Ubuntu/macOS 完整矩阵，只有 success 才通过。使用临时验证脚本实际执行 workflow 的 shell，success=0，failure/cancelled/skipped/空结果=1。

## main 保护

通过 GitHub API 配置并回读 Mininglamp-OSS/octo-runtime 的 main：必须 PR、一次批准、新提交撤销旧批准、解决 review conversation、分支跟上基线、GitHub Actions app（实际查询 ID 15368）提供 CI Gate；管理员同样适用，强推和删除关闭。没有创建 PR、合并或向 main 推送。

首次 PR 尚未运行，因此不能声称 hosted runner 或独立安全检查已通过。pull_request_target 元数据工作流依赖 main 已有其定义，不把尚未能产生的检查设为 required。其余安全 workflow 按原配置保留，后续按真实运行结果评估 required checks。

## 验证

- 本地 Node v24.19.0；format:check、ESLint、lint:names、typecheck 通过。最初并发执行清理构建与类型 ESLint 导致暂时缺失 dist，按正确依赖顺序完成构建后 lint 通过；CI 安装 prepare 构建完成后才执行 lint，不存在该并发。
- Node 1083 项：1074 通过、9 条按原有显式条件跳过、0 失败；调试插件 35 项通过。
- 与组织相同版本 actionlint v1.7.12 通过；全部 workflow YAML 无 tab 且能解析；共享测试入口、Node 24 和 format/check 范围验证通过。
- pack-release 与 verify-release 通过：空缓存离线安装、公共 API 类型、第三方 Extra、内置插件、daemon 就绪及卸载保留 Home。构建为未提交工作区，元数据如实 dirty=true，不冒充正式发行。
- 生成协议与 pnpm-lock.yaml 无漂移，git diff --check 通过。Octospec 格式和本地链接通过；Python YAML 工具依赖使用仓库外临时 venv，不修改项目生产依赖。

本轮未修改 Run/Context 协议或业务执行行为，不涉及 Worker/桌面应用重建、真实模型执行、IM 联调或用户 Runtime 重启。GitHub runner 与真实 PR 的门禁验收仍待首次 PR，不能以本地检查代替。
