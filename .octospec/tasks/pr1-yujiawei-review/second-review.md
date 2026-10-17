---
type: Task
title: PR 1 第二轮评审新增项与遗漏整改
description: 记录 Jerry-Xin 的 Codex 进程回收遗漏与 yujiawei 的共享 workflow 版本固定要求，明确证据、评分及验收。
tags: [review, lifecycle, ci, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 第二轮评审

两份新评审均针对 55e977f249b6b0fae85d43c79748db1ff35bb719。当前状态为两项待修复；此前本地测试通过记录仍有效，但不表示已覆盖以下新发现。此次只更新分析与计划，不修改产品代码或 workflow，也不发送评审回复。

| 编号 | 来源及问题 | 与上一轮的关系 | 严重程度 | 修改必要性 / 100 | 技术可执行性 / 100 | 处理目标与状态 |
| --- | --- | --- | --- | --- | --- | --- |
| R06b | Jerry-Xin：Codex app-server 退出后，close 提前返回，未完成本次进程组回收 | R06 的遗漏路径；之前 Codex S01 只修了管道错误隔离 | P1，真实执行资源隔离缺陷 | 100 | 100 | 修复；待实施、待本地新增回归 |
| R07 | yujiawei：11 个共享 workflow 使用可移动的 @v1 | 新发现的 CI 依赖固定问题，与已删除 API 无关 | 评审 P1；同意合入前处理，实际利用依赖上游引用变更或受损 | 90 | 100 | 修复；待核对目标内容并固定完整 SHA |

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

## R07：共享 workflow 固定完整提交

来源：[yujiawei 新评审](https://github.com/Mininglamp-OSS/octo-runtime/pull/1#pullrequestreview-5556602456)，北京时间 2026-10-17 14:16:37。

本轮独立检索确认 11 个文件引用 Mininglamp-OSS/.github 的 @v1：codeql、dependency-review、history-check、issue-welcome、labeler、pr-title-lint、release-drafter、release-publish、secret-scan、stale、workflow-sanity。

通俗解释：本仓未改一行，中央仓库只要移动 v1，下一次触发就可能运行不同的共享流程。部分调用授予 contents:write、issues:write 或 pull-requests:write，因此这不只是构建结果可重复性问题。公司共享仓库是可信来源，但信任来源和固定实际执行版本是两个不同要求。

意见成立；当前没有上游被攻击、引用已恶意移动或凭据已泄露的证据，不应表述为已发生安全事故。使用 @v1 也有集中升级的收益；固定 SHA 的代价是升级需显式提交评审，这是本次建议接受的治理成本。旧 R01/R02 的删除没有被此次评审否定。

本轮只读查询 v1 得到候选 8feb64b77fcd794571ba9a959f7f745bc7a0650c。解析成功不等于已审查该提交内容；不得据此把它直接记为可信或已批准版本。

方案与验收：

1. 审查候选提交中的 11 个目标 workflow，核对路径、workflow_call 输入、secrets、权限及其嵌套依赖；记录实际使用的完整 SHA 和选择依据。
2. 将本仓 11 处 @v1 改为审查过的完整 SHA，保留公司共享流程；后续升级通过显式依赖变更评审，不静默追踪可移动引用。
3. 固定入口 SHA 不等于所有传递依赖均不可变。发现嵌套可移动引用时单独记录归属与处理，不声称固定一层已解决所有供应链风险。
4. 检查 YAML、actionlint、diff、工作流输入和权限；推送后验证安全检查及 workflow sanity。发布相关流程做静态或安全验证，不为验收实际发布版本或包。
5. 全量检索共享 workflow uses，确认没有漏掉可移动引用；不机械替换项目版本或 release tag。

## 其他观察与关闭条件

Jerry 提到隔离 checkout 下有 14 个指向兄弟仓库的文档链接缺失，属于原有记录，不是本轮新增阻塞。需要后续区分生态工作区导航与独立仓库可用性；不写成当前两项 P1，也不把本地生态目录的检查通过等同于独立 checkout 的文档完整性。

R06b 和 R07 修复后分别提交，正文写明 reviewer、编号、决策和验证；不得以第一轮全绿关闭第二轮问题。原 R01/R02/R03/S01 等已完成项保持完成；R06 总项因 Codex 遗漏恢复为部分完成。Windows 真机测试按用户计划继续跟踪。
