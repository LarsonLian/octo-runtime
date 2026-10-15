---
type: Rule
title: 内部中文协作与提交约定
description: 内部项目直接使用中文，保留 Conventional Commits 类型及真实验证依据。
tags: [commit, git, documentation]
timestamp: 2026-10-15T00:00:00Z
id: commit
tier: repo
priority: 70
load_bearing: false
inject_when:
  paths: ["**"]
  touches: [commit, git, documentation]
source: self
supersedes: []
---

# 内部中文协作与提交约定

此规则以同 `id: commit` 覆盖全局提交规则，保留 Conventional Commits 结构，说明使用中文。

- 文档、任务简报、评审、MR 和提交描述直接使用中文。代码标识、API 字段、路径、命令及专有名称保留原文；不要求中英文双份文档。
- 提交格式为 `<type>(<scope>): <中文说明>`，例如 `docs(spec): 接入 OKF 工程规范`。一个提交表达一个逻辑变更；标题不超过 72 个字符且不加句号。
- 有关联任务时填写实际任务引用，不虚构编号。作者使用实际身份，不冒充他人。
- 不提交密钥、token 或本机秘密配置。联调地址可以在内部说明中显式记录，凭据不得随地址写入。
- MR 关联简报或需求，说明实际行为与验证结果。架构或关键合同变更还要回答：改变了什么、可能影响谁、以什么证据证明有效。
- 收尾可以准备提交与 MR 内容；实际提交、推送及创建 MR 按用户授权执行。
