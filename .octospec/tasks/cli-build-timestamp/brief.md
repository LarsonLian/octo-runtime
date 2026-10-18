---
type: Task
title: CLI UTC 构建时间
description: Issue 31 的版本元数据、安装产物与同版本发布恢复合同。
tags: [cli, build, release]
timestamp: 2026-10-18T00:00:00Z
---

# 目标与范围检查

关联 Mininglamp-OSS/octo-runtime#31。用户希望判断当前安装产物何时构建，属于 CLI 诊断元数据，不属于 Provider、会话或业务体验策略。用户显式授权展示 UTC 构建时间并提交 PR 合并 main。时间来源归构建流程，运行时只读发行物；不读取调用者 Git，不初始化 Home，不启动 daemon，不调整任何接入产品默认配置。

# 合同

- 构建时生成 `buildTime`，规范为带毫秒和 Z 的 UTC ISO 8601；根帮助及所有版本别名增加 `build:` 行。
- 旧发行物、缺失或无效时间显示 `build:unknown`，不伪造当前时间。commit/dirty 语义不变。
- 打包和安装原样携带 metadata；发行验证比较 archive 和安装后的 metadata。
- 新发行流程在验证阶段捕获一次构建会话时间，矩阵及重复构建共用；恢复已发布版本时校验 registry archive 的 SHA512、来源 SHA 和 clean 状态，复用原时间。旧发行物没有时间时保持旧流程。发布阶段仍严格比较完整 tgz integrity，不能覆盖或绕过已发布版本。
- 普通独立构建默认生成新的真实构建时间；显式 `OCTO_RUNTIME_BUILD_TIME` 仅用于构建流程复用原始时间，不影响运行时。

# 验收

覆盖无 Git、clean/dirty、UTC 与时区、旧/损坏元数据、只读帮助与版本别名、原样安装及同版本恢复。运行相关测试、全仓检查及三平台 PR CI；独立评审通过后合并，不创建或移动发行 tag。
