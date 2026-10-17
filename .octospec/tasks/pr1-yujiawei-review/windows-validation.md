---
type: Task
title: Windows 既有实现的真机验收与问题跟踪
description: 明确 Windows 支持要求，记录现有实现、待核实的后代回收行为和用户计划补充的真机验证。
tags: [review, lifecycle, testing, windows]
timestamp: 2026-10-17T00:00:00Z
---

# Windows 验收

跟踪 [GitHub issue 2](https://github.com/Mininglamp-OSS/octo-runtime/issues/2)。Windows 已有实现，本轮未真机验证；用户计划后续补测。此前“不保证 Windows”表述撤回，平台支持是明确要求。

## 实现与证据

process-cleanup 已有 Windows child.kill、退出检查、有界等待及幂等清理路径。Windows 不使用 POSIX 负 PGID；当前函数直接观察 child 状态。父进程先退出时工具后代是否结束仍须真机核实，不提前写成已复现故障，也不以父进程退出作为后代已结束的验收证据。

当前 CI 仅 Linux/macOS，POSIX 进程组测试跳过 Windows；Windows 自动化覆盖是确定的待补项。本轮没有改动产品代码或 CI。

## 验收与修复

1. 记录 Windows / Node 24 版本、Runtime commit、Provider、步骤与脱敏日志。
2. 验证正常执行、连续调用、取消、重复和并发关闭；覆盖 ACP、NDJSON、Host launcher、ZCode。
3. 专门验证父先退、工具后代持续工作的情况，检查后代 PID 及文件写入停止；兄弟任务与用户其他进程不得受影响。
4. 验证 spawn/管道错误隔离、清理超时及真实失败原因。
5. 发现故障后登记和修复；确认持续执行或共享 Host 退出时按 P1 处理，不以 Windows 平台差异豁免。
6. 补 Windows CI、对应回归、打包和离线安装，并接入 CI Gate。真机及 CI 结果共同记录后关闭 issue。

产品目标不需要再次决策；当前待完成的是用户计划的真机验证、自动化覆盖及据结果确定的修复。
