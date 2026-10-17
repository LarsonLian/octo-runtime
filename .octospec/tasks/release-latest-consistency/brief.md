---
type: Task
title: npm 与 GitHub latest 单调一致性修复
description: 修复多 tag 并发发布和同 tag 恢复导致 latest 回退的问题，使不可变版本交付与共享 latest 提升可独立重试并最终一致。
tags: [release, concurrency, testing]
timestamp: 2026-10-17T00:00:00Z
---

# 背景与评估结论

PR #19 的两条阻塞意见均成立，不是误报：

1. 当前 npm publish job 和外层 release workflow 都按 tag 使用并发键。两个不同版本可以同时
   读取同一个旧 `@latest`，都决定以 `latest` 发布；较低版本后完成时会把 npm latest 回退，
   GitHub Release 也可能按过期决定回退。
2. 当前版本与 npm latest 相等时，比较逻辑把它归为历史版本并输出 `release-X.Y.Z`。同 tag
   恢复随后执行 `gh release edit --latest=false`，会把本来就是 latest 的 GitHub Release 降级。

第二项直接违反原任务的同版本幂等恢复合同。第一项说明原任务中“不同 tag 使用独立并发键”
只隔离了不可变版本，却错误地把共享 `latest` 也当成了 tag 私有状态；原 brief、CI 文档和实施
记录必须随实现修正。

# 目标

每个稳定版 tag 仍能独立构建、验证和交付自己的不可变版本；npm `latest` 与 GitHub Latest
Release 则作为同一个包级共享状态管理。无论两个版本以何种顺序构建、发布、恢复或完成，最终
两端 latest 都必须指向已完整交付的最高稳定版本，且同版本恢复不改变原有 latest 归属。

# 责任与输入

- **业务目标：** `npm install -g @mininglamp-oss/octo-runtime@latest` 和 GitHub Latest Release
  始终选择最高的完整稳定版，不因任务时序回退。
- **决定权：** tag 决定不可变版本号；发行工作流只根据 registry 与 GitHub Release 的真实状态
  维护共享 latest，不从任务启动顺序或缓存输出推断。
- **显式输入：** 已校验 tag、精确 commit、已验证 tgz、npm 版本及完整性、npm dist-tags、
  GitHub Release 与资产状态。
- **合同内动作：** 发布或核对不可变 npm 版本、创建或修复对应 Release、提升共享 latest、
  在状态变化时重新读取并有界重试。
- **越界动作：** 覆盖同版本不同内容、把旧版本提升为 latest、因恢复旧版本而降级当前 latest、
  依赖 GitHub concurrency 的执行顺序表达版本顺序。

# 目标设计

## 1. 分离不可变交付与共享提升

每个 tag 的构建、完整 CI、tgz 验证以及不可变版本交付继续独立。新 npm 版本先使用版本专属的
非共享 dist-tag（例如 `release-1.2.0`）发布；已有同版本先核对 `dist.integrity`，一致则跳过，
不一致立即失败。该阶段不得写 `latest`。

对应 GitHub Release 可以按 tag 创建或修复并上传同一 tgz。创建时明确不自动成为 latest；修复
现有 Release 时不得先执行 `--latest=false`，避免恢复过程临时或永久降级已有 latest。

## 2. 使用显式版本关系

不得再用单个 `dist_tag` 字符串同时代表 npm 发布标签和 GitHub latest 决策。状态判定至少输出
`first`、`newer`、`equal`、`older` 四种关系，并分别派生动作：

| 关系    | 不可变版本动作 | npm latest   | GitHub latest            |
| ------- | -------------- | ------------ | ------------------------ |
| `first` | 发布或核对     | 提升当前版本 | 提升当前 Release         |
| `newer` | 发布或核对     | 提升当前版本 | 提升当前 Release         |
| `equal` | 核对并跳过覆盖 | 保持         | 保持或修复为当前 Release |
| `older` | 发布或核对     | 不改变       | 不改变                   |

## 3. 包级 latest 协调器

不可变包和对应 Release 就绪后，进入包级共享 promotion 临界区，在临界区内重新读取 npm 与
GitHub 的当前状态，选择已经完整交付的最高稳定版本，再同时收敛 npm latest 和 GitHub Latest
Release。写入后必须重新读取两端状态；若期间出现更高完整版本，则按最新事实有界重试，而不是
继续使用进入 job 前计算的 `dist_tag`。

npm latest 与 GitHub Latest 两个现有指针共同构成不可回退下界。若当前 latest 的 Release 资产
在修复期间短暂不可见，协调器不得把任一指针写向更旧的完整版本，而应保持零写、有界重读，
资产仍未恢复时失败。对应 tag 的 Release 创建和资产替换保持独立执行；资产就绪后同一工作流
会进入可重算的 promotion 协调器，因此中间状态不会造成回退，也不会丢失某个 tag 的资产交付。

不能仅把现有 publish job 改成一个全局 GitHub concurrency group：该机制不承诺 FIFO，且新的
等待项可能取代旧等待项。若使用全局 concurrency，它只能保护可重算的 promotion 协调器；每个
协调器都必须收敛全局最高完整版本，而不是只处理触发自己的 tag。即使中间 promotion 被取代，
最后保留下来的运行也必须能修复全部共享 latest 状态。

## 4. 失败与恢复

- npm 不可变版本成功、GitHub Release 失败：版本保留在专属 dist-tag，不提前改变 latest；
  `recover` 修复 Release 后再运行共享协调器。
- latest 提升中断：不可变版本与 Release 保持可恢复；重新运行同 tag 或协调器必须收敛，而不是
  重发不同内容。
- 历史版本补发或恢复：只补齐该版本及资产，不改变两端 latest。
- 当前 latest 恢复：保持 npm latest，并确保 GitHub latest 仍指向同版本。
- dry-run：执行同一状态读取和决策验证，但 npm、dist-tags 与 GitHub Release 均零写入。

# 实施步骤

1. 将稳定 SemVer 比较和 `first/newer/equal/older` 判定提取为可单测的发布状态模块，输入输出不
   复用含混的 `dist_tag` 字符串。
2. 调整 npm reusable workflow：不可变版本只用版本专属 dist-tag 发布；保留完整性冲突拒绝与
   provenance；dry-run 不产生写操作。
3. 调整 Release workflow：先创建或修复 tag 对应 Release，不在恢复现有 Release 时主动清除
   latest；新增包级 promotion 协调步骤，在共享临界区内重新读取、收敛并复核 npm/GitHub。
4. 为 npm/GitHub 命令边界建立本地 fixture，模拟 registry dist-tags、不可变版本、Release 与
   资产状态；测试实际工作流脚本或其共用模块，不能只测试复制出来的伪逻辑。
5. 修正 `single-npm-release` brief、`.github/CI.md`、`DEPLOYMENTS.md` 和实施 journal 中关于不同
   tag 并发、恢复与 latest 的描述，明确独立构建不等于共享状态独立写入。
6. 运行双轴 code review，确认实现同时满足仓库并发保护标准与本计划状态合同。
7. Windows 发行验收继续执行全局 `.cmd` daemon shim，但停止时必须回收整个进程树并确认包装
   进程退出，不能只终止可能留下子 daemon 的 shell。

# 验收矩阵

| 场景                                | 预期 npm                    | 预期 GitHub              |
| ----------------------------------- | --------------------------- | ------------------------ |
| 尚无 latest，首次发布 `1.0.0`       | `latest=1.0.0`              | `v1.0.0` 为 latest       |
| 当前 `1.0.0`，发布 `1.1.0`          | 提升到 `1.1.0`              | 提升到 `v1.1.0`          |
| 当前 `1.1.0`，恢复 `1.1.0`          | 同完整性 no-op，保持 latest | 修复资产并保持 latest    |
| 当前 `1.1.0`，补发 `1.0.0`          | 独立版本存在，latest 不变   | Release 存在但非 latest  |
| 当前 `1.1.0`，恢复 `1.0.0`          | 同完整性 no-op，latest 不变 | 修复资产但不改变 latest  |
| 同版本 tgz 完整性不同               | 失败且 dist-tags 零变化     | Release 零变化           |
| `1.1.0` 与 `1.2.0` 并发，旧版先完成 | 最终 `latest=1.2.0`         | 最终 `v1.2.0` 为 latest  |
| `1.1.0` 与 `1.2.0` 并发，新版先完成 | 最终 `latest=1.2.0`         | 最终 `v1.2.0` 为 latest  |
| promotion 等待项被更新版本取代      | 存活运行收敛最高完整版本    | 存活运行收敛对应 Release |
| 当前 latest 资产替换中或替换失败    | 重读期间零写，latest 不回退 | Latest 不回退            |
| 任一 dry-run                        | 版本、dist-tags 零变化      | Release 与资产零变化     |

Windows 验收还必须证明真实 `octo-runtime-daemon.cmd` 启动后使用 `taskkill /T /F` 或等价机制回收
整棵进程树，后续卸载不被残留 daemon、端口或文件句柄阻塞。

除状态 fixture 外，继续运行 workflow actionlint/YAML 检查、`pnpm format:check`、相关 Node 测试、
动态版本打包和离线全局安装验证。不得用真实 tag、真实 npm 发布或真实 GitHub Release 变更完成
本计划的自动化验收。

# 范围外

- 不改变 tag 命名、`0.0.0` 源码占位版本或单一公开包边界。
- 不引入预发布版本或 `next` 策略。
- 不改变 CLI、daemon、公开 TypeScript API、Runtime Home 或 Provider 行为。
- 不在本任务中创建或推送 `v1.0.0`，也不执行真实 npm/GitHub 发布。
