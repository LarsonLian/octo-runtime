---
type: Task
title: PR 1 第二轮评审新增项与遗漏整改
description: 记录 Jerry-Xin 的 Codex 进程回收遗漏与 yujiawei 的共享 workflow 版本固定要求，明确证据、评分及验收。
tags: [review, lifecycle, ci, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 第二轮评审

两份新评审均针对 55e977f249b6b0fae85d43c79748db1ff35bb719。当前状态：R06b 待修复；R07 经公司规范核对后改为证据回应，保留 @v1；此前本地测试通过记录仍有效，但不表示已覆盖以下新发现。此次只更新分析与计划，不修改产品代码或 workflow，也不发送评审回复。

| 编号 | 来源及问题 | 与上一轮的关系 | 严重程度 | 修改必要性 / 100 | 技术可执行性 / 100 | 处理目标与状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R06b | Jerry-Xin：Codex app-server 退出后，close 提前返回，未完成本次进程组回收 | R06 的遗漏路径；之前 Codex S01 只修了管道错误隔离 | P1，真实执行资源隔离缺陷 | 100 | 100 | 修复；待实施、待本地新增回归 |
| R07 | yujiawei 建议将 11 个公司共享 workflow 固定 SHA；公司规范明确使用滚动 @v1 | 新评审建议，与已删除 API 无关；已补组织合同核对 | 评审 P1；本次不认定为偏离公司规范的本仓 P1 缺陷 | 0（本仓单独改 SHA） | 100（证据回应） | 与组织对齐，保留 @v1；评审讨论未关闭 |

分数含义沿用[原评分口径](assessment.md)：可执行性 100 表示处理方式清楚，不表示实现、目标 SHA 内容审查或验证已完成。当前没有新的产品决策需求。

## R06b：Codex 回收遗漏

来源：[Jerry-Xin 新评审](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556594844)，北京时间 2026-10-17 14:13:49。

reviewer 明确确认 ACP 启动失败、共享 Host 兄弟任务存活、ACP/NDJSON 后代回收四项原始探针已通过；此次不是原修复完全失效。

本轮源码核对：Codex 的 app-server.ts close 在 #exited 为 true 时直接返回，两次 leader-exit 等待成功也直接返回；重复调用只看到 #closed 后返回，没有等待同一清理结果。defaultSpawn 在非 Windows 创建独立进程组，leader 退出不足以证明组内工具已退出。

reviewer 通过 public runCodexAppServerTurn、生产 defaultSpawn 与合成 app-server 复现取消和正常完成两种场景，每种三次；返回后 300 ms 内后代继续写文件 13–14 次。该运行结果来自 reviewer，本轮仅独立核对源码，尚未独立重跑，不能记录为本地已复现或真实 Codex 模型验收。

之前实现覆盖：ACP 与公共 NDJSON 已接入回收函数，Claude Code 使用 spawnJsonLines，随公共实现生效；Host、ZCode 已接入；Codex 仅补管道错误隔离，独立关闭流程漏接。上一轮“同类整改完整完成”的总结过早。

方案与验收：

1. Codex close 接入按所有权、有界、可等待的回收；清理结果用同一 Promise 共享，不以 #closed 或 leader exit 代替完成证据。
2. 保留正常执行终态、取消语义及首次真实错误，清理失败不得被吞掉或伪造成功。
3. 核对现有 stdin EOF、协议 interrupt、取消定时器与 Host 预算，避免叠加等待或清理竞态；不得结束外部连接实例或其他调用的进程。
4. 两个回归分别覆盖取消和正常完成：父进程先退出，后代忽略 TERM 且使用独立 stdio。调用返回后后代不存在、文件不再写入；覆盖重复 close、兄弟调用隔离。
5. 运行 Codex/Host 相关及完整门禁；Windows 已有实现、待真机验收，沿[Windows 跟踪](windows-validation.md)记录，不降低支持要求。

## R07：与公司共享 workflow 版本策略对齐

来源：[yujiawei 新评审](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556602456)，北京时间 2026-10-17 14:16:37。

本轮独立检索确认 11 个文件引用 Mininglamp-OSS/.github 的 @v1：codeql、dependency-review、history-check、issue-welcome、labeler、pr-title-lint、release-drafter、release-publish、secret-scan、stale、workflow-sanity。

通俗解释：本仓未改一行，中央仓库只要移动 v1，下一次触发就可能运行不同的共享流程。部分调用授予 contents:write、issues:write 或 pull-requests:write，因此这不只是构建结果可重复性问题。公司共享仓库是可信来源，但信任来源和固定实际执行版本是两个不同要求。

初评接受固定 SHA 的方案前，没有核对公司共享流程的正式版本策略，判断依据不完整。用户要求与其他项目对齐后，已查询以下仓库默认 main 的全部 .github/workflows 文件；仅统计 Mininglamp-OSS/.github 共享 workflow 引用，不统计第三方 action，不声称穷尽全组织。

| 仓库 | 检查提交 | 共享 workflow 引用 | 引用方式 |
| --- | --- | --- | --- |
| octo-cli | d564a63bbd8ec2dd4305a40a64fe0179ca9c667f | 9 | 全部 @v1 |
| octo-server | 8326c67afdcd0fb8cd3b9f98548e2ed40ed49a62 | 14 | 全部 @v1 |
| openclaw-channel-octo | b6d6fdf83e6f186a61044eb5bba7d727ea762b21 | 12 | 全部 @v1 |
| codex-channel-octo | f3ca7657f82a069a4b357a6ec6cdc1295c432c05 | 0 | 当前只有自有 ci.yml，不能算 SHA 固定的先例 |

证据：[octo-cli](https://github.com/Mininglamp-OSS/octo-cli/tree/d564a63bbd8ec2dd4305a40a64fe0179ca9c667f/.github/workflows)、[octo-server](https://github.com/Mininglamp-OSS/octo-server/tree/8326c67afdcd0fb8cd3b9f98548e2ed40ed49a62/.github/workflows)、[openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo/tree/b6d6fdf83e6f186a61044eb5bba7d727ea762b21/.github/workflows)、[codex-channel-octo](https://github.com/Mininglamp-OSS/codex-channel-octo/tree/f3ca7657f82a069a4b357a6ec6cdc1295c432c05/.github/workflows)。

更直接的依据是组织仓库的[workflow 架构第 5 节](https://github.com/Mininglamp-OSS/.github/blob/47f5d8daba096ded76ff24b07a21199a3cb460d7/docs/workflow-architecture.md#5-foundation-versioning--distribution-p0--everything-rests-on-this)：明确要求所有调用方使用滚动 @v1，采用 vX.Y.Z 版本标签及 vX 主版本别名。[release.yml](https://github.com/Mininglamp-OSS/.github/blob/47f5d8daba096ded76ff24b07a21199a3cb460d7/.github/workflows/release.yml) 实现稳定版本发布后移动主版本别名，预发布不移动。该文档将第三方 actions 固定 SHA 另列要求，不应将两类引用混同。

**当前决定：octo-runtime 保留公司共享 workflow 的 @v1，与现行规范及已核对项目一致。本项从本仓代码修复改为基于组织合同的评审回应；不单独固定 SHA，不降低现有第三方 action 的 SHA 固定要求。**

风险判断仍保留：v1 可移动并且上游共享代码可能带写权限；组织滚动版本策略不等于引用不可变，也不等于风险为零。正式发布机制有意让下游接收同一主版本更新。若要改为每仓固定 SHA，应在组织共享 workflow 的版本治理中统一评审、实施和迁移，不在本仓孤立改制。没有证据表明上游已遭攻击或本仓已泄露凭据。

R07 的本仓单独修改必要性由 90 调整为 0；证据回应可执行性 100。reviewer 是否接受尚未确认，不能把本地决定写成 GitHub Changes Requested 已解除。本轮未发送评审回复、未修改 workflow。

后续处理：提供上述正式策略和项目快照作为讨论依据；如维护者决定调整组织政策，再统一确定 SHA 更新与迁移机制。现阶段无需选择或审查一个用于本仓替换的新 SHA。

## 其他观察与关闭条件

Jerry 提到隔离 checkout 下有 14 个指向兄弟仓库的文档链接缺失，属于原有记录，不是本轮新增阻塞。需要后续区分生态工作区导航与独立仓库可用性；不写成当前两项 P1，也不把本地生态目录的检查通过等同于独立 checkout 的文档完整性。

R06b 修复后单独提交，正文写明 reviewer、编号、决策和验证；R07 按公司合同证据回应，等待评审达成一致，不制造 workflow 变更。不得以第一轮全绿关闭第二轮问题。原 R01/R02/R03/S01 等已完成项保持完成；R06 总项因 Codex 遗漏恢复为部分完成。Windows 真机测试按用户计划继续跟踪。
