---
type: Journal
title: daemon 进度、配置读取和插件状态验证
description: 终端友好输出、extraget 与 Extra 自定义 JSON 汇总的实施证据。
tags: [cli, lifecycle, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 结果

服务管理默认输出即时步骤与摘要；--json 保留结构化结果并关闭进度。start 在安装前、后台启动前和等待 IPC 前提示，失败不打印最终成功。摘要列出识别的 Adapter、已加载 Extra 与未就绪项的实际阶段。前台 run 保持原日志行为。

extraget name 输出完整持久化 JSON，保留 enabled 的显式值或缺省状态以及任意插件 config，不导入模块。名称、文件权限、大小与声明校验复用既有读取入口。status 和 daemon status 为每个 loaded Extra 通过既有 extra.status IPC 读取自定义 JSON；单项查询失败标记 status_error，其他状态继续返回。终端 daemon status 展开完整插件 JSON。

后续按用户要求，extraget 成功读取后先向 stderr 输出配置文件绝对路径，stdout 保持纯 JSON，重定向与管道仍可用。测试同时断言路径行与完整 JSON 分流。

# 验证

- workspace 构建、根 tsc --noEmit、pnpm lint 通过。
- 提交前将暂存快照导出到独立目录，离线安装依赖并验证构建、类型检查和 lint；Extra 状态回调、命名查询与三个内置插件状态接线随 CLI 一起提交，其余协议与生命周期重构保留在工作区。
- cli-home、cli、cli-channel、cli-status 共 38 项自动化测试通过；包括终端与纯 JSON、首次安装、已安装、失败、配置读回、权限拒绝、真实 daemon IPC 的插件 JSON 汇总及查询故障隔离。
- 发行包打包与离线安装验证通过；本机全局命令已更新。实际 daemon start 显示检查、已安装、后台启动、等待就绪、最终成功，列出 12 个 Adapter 与 channel-gateway。
- 对用户现有默认 Home 仅做本地读取及幂等 start，extraget 结果与原文件完整一致；实际插件状态含 bots、errors。其配置指向 im.deepminer.com.cn，未向该业务服务发起测试请求，不将其作为 im-test 业务验收。
- CDP 读取现有 Work App 的公开状态，确认 server 为 https://im-test.deepminer.com.cn、phase=running；新 daemon status --json 读取其 .octo-runtime-work Home，PID 匹配且 ready=true。该测试 Runtime 当前 extras 为空，因此它只验证真实测试环境的状态读取，不证明额外插件连接验收。
- 没有重启已有 daemon、删除或重建 Home、身份和配置；不改变 Run/Context 或内部 IPC 协议。

任务与验收见 [任务简报](../../tasks/cli-daemon-output/brief.md)。
