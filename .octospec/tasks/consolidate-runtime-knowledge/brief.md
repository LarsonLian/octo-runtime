---
type: Task
title: 按当前实现整理 Runtime 工程知识并移除 docs
description: 核对源码、Git 演进与全部旧文档，提炼当前规则、操作指南和历史结论。
tags: [architecture, context, protocol, documentation]
timestamp: 2026-10-15T00:00:00Z
---

# 目标

以当前工作树和 Git HEAD `df63c8f` 为基准，读取根 docs 的全部 30 份文档及协议包的 Invoke 指南。有效内容纳入 OKF，根 docs 与协议包 docs 目录均移除。

## 关键合同

- 当前实现优先；Git 用于解释决策的引入、撤回和替代，不以曾经提交过证明仍有效。
- 当前规则放 rules，操作指南放 guides，过往验证及被否定设计的理由放 journal。
- 已知未实现的目标单独放任务，不留在当前合同中暗示支持。
- Run=7、Context=v3 和 Adapter transport=2 保持独立，不修改执行代码或增加旧格式兼容。
- 保留用户已修改的 INTEGRATION 内容，仅更新受迁移影响的引用。

## 范围外

本次不发布项目，不修改 Runtime 行为，不重新执行真实模型或线上接口联调，不重写 Git 历史。

## 验收

- 31 份原始材料都有去向和取舍理由。
- 当前合同提供对应源码和适用测试入口，旧设计只保留演进结论。
- docs 目录不存在；仓库引用更新，无指向已删除文件的本地链接。
- 全部新知识单元符合 OKF，规则索引与 frontmatter 一致；中文同步重复执行稳定。
- 记录本次文档检查与历史验证的不同范围。
