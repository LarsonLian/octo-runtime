---
type: Journal
title: 第三方插件飞书指南与隐藏高级清单帮助
description: 完整开发指南、独立示例验证及 SDK/CLI 兼容边界。
tags: [extra, adapter, documentation, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 第三方插件飞书指南与 CLI 帮助

已创建[飞书开发接入指南](https://my.feishu.cn/docx/IW30d2KL6o137ExHKHRc2yrJngh)，包含公开类型、独立 TS 工程、Extra 生命周期与 Agent Run、结构式 Adapter、高级显式 manifest、Dify 转换检查点、SDK/CLI 兼容矩阵和验收。内部 packages 仍 private，/adapter 与自动追加清单仍标为待实施；没有把 Dify 或所有宿主写成已验证。

用户进一步要求普通 --help 不展示 --manifest。apps/cli/src/help.ts 只过滤帮助显示，保留 command.flags 的解析许可和原执行流程；根/Playboard 帮助明确默认使用内置 Adapter，无需配置。

## 验证

- Runtime pnpm build 通过。初次直接运行针对性测试时 dist 尚未生成，报模块缺失；构建后重跑通过，不将该前置缺失当作业务回归结论。
- SDK 装配/重启/崩溃恢复、daemon 默认路径、Extra 生命周期与实际加载共 19 项针对性回归通过。
- 两个飞书代码示例在仓库外的隔离目录，仅从本地 tgz 安装业务依赖，skipLibCheck=false 编译通过；结构式 Echo Adapter 用显式 manifest 执行后返回 run.completed 和精确标记，Extra 被 daemon 真正加载后调用同一 Adapter 并得到精确输出。示例不调用 Dify，不是模型联调。
- CLI 重建通过；实际 helpText 输出不含 --manifest，仍说明默认无需 Adapter 配置；validateCommand 继续接受该参数。help.ts ESLint 与 git diff --check 通过。
- 飞书 XML Draft Profile Check passed，创建成功，回读核对关键代码、类型、追加清单与兼容章节。未修改分享权限、发送消息、发布 npm 或替换运行中的用户安装。

## 兼容结论

公开 /extra、/protocol 与 ExtraAdapterHost 是增量导出/同签名类型收敛，不改变既有 invoke、交互和取消调用。SDK/CLI 默认行为保持，但工作树另有 CLI 默认 JSON 与 SDK import 入口拆分，使用旧 config/adapters.json 或 SDK 复制清单物理路径的宿主需迁移，详见[该项验证](../../tasks/adapter-composition-ownership/brief.md)。不能将本次示例和针对性回归扩大为全部历史发行物、Work App/CDP 或 Dify 验收通过。
