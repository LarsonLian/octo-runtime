---
type: Journal
title: Runtime 小时日志与四项资源整改收尾
tags: [runtime, storage, lifecycle, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 实现

Host debug、SDK 子进程和 CLI 托管服务分别接入 SDK 的 HourlyLogWriter。按 UTC 当前及前两个小时保留，每类别最多 3 文件，每文件最多 100 MiB。达到上限后持续读取并丢弃，下一小时恢复；启动、切小时及 60 秒空闲检查时清理。同步追加无无限写队列，按实际文件大小继承重启容量；小时独占锁保证并发不超写，锁竞争不等待。崩溃遗留锁只影响该小时，过期随桶清理。

只处理明确命名的普通文件，拒绝符号链接目录/文件和多硬链接写入。清理失败不持续新增文件；诊断最多一次且不递归。旧固定日志、身份/Home、配置、Provider 原生存储和用户文件不删除。保留上限属于每类别受管日志，不是整个 Runtime Home 或系统日志的磁盘上限。

SDK 和托管 launcher 排空 stdout/stderr 后关闭日志；子进程退出但输出未关闭时最多再排空 1 秒，回收旧管道和定时器。前台终端及信号/退出码保留。CLI ServiceSpec 不再把输出接入固定 service.out.log/service.err.log，而传 --managed-logs。已有服务须显式 daemon install 更新后重启，不在本次自动重装用户服务。

Host RPC trace 改为元数据，保留方法、身份、事件类型和大小，不归档 canonical 输入正文、Context、base64 或可信工具环境。debug 默认关闭，模块 import 本身不创建日志清理器，实际 Host 日志生命周期才初始化。

# 验证范围

构建、ESLint、根项目 TypeScript 与命名检查通过。最终根目录 `node --test test/*.test.js` 共 889 项，881 通过、8 跳过、0 失败；协议目录另 18 项全部通过，合计 907 项、899 通过、8 跳过、0 失败。本批小时日志 9 项通过。此前定向联合日志、debug、CLI Home、跨平台 ServiceSpec、SDK Extra 清理及工具环境回归 50 项通过。覆盖模拟 24 小时和空闲删除、100 MiB 精确边界/同小时重启、时钟倒退、并发写、失败恢复、符号链接目录/文件与 legacy 保留。真实 macOS launcher 和 SDK 重启通过，SDK 排空最后一条 dispose 输出。

三种平台 ServiceSpec 生成测试通过；Linux/Windows 原生服务安装以及 macOS launchd 全局启停没有实测。本次只启动临时 Home 的进程，不重装正在使用的 Runtime 服务。`verify-runtime-hourly-logs-live.mjs` 在 im-test 连续两轮真实连接上线、关闭通过，同一个小时文件从 59 字节增长到 118 字节，dispose 最后输出已排空，未记录 Bot 凭据。脚本采用短临时目录，规避 macOS Unix socket 路径长度限制。

# 四批提交

1. c96c8b3：Channel 64 Bot、64 个配置管理操作及单份 256 KiB。
2. a514f08：OpenClaw 入队过滤、4096 条/4 MiB、失败及时清理及 GC 验证。
3. 8524f3f：32 MiB 整请求、多模态独立 Host 与 Codex 回显/续聊。
4. 本批：小时日志、100 MiB/文件及四项文档收尾。

origin 的 SSH 22 和 HTTPS 443 均连接失败；前三批已在 main 本地提交，推送尝试失败，最终以 git push 的真实结果为准，不将本地提交当成远端交付。
