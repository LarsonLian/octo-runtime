---
type: Task
title: daemon 终端进度与摘要
description: 服务管理默认显示执行步骤，JSON 通过显式选项保留。
tags: [cli, lifecycle]
timestamp: 2026-10-15T00:00:00Z
---

# 范围与验收

start、restart、stop、install、uninstall 输出即时进度与最终摘要；status 输出简短状态。start 在实际安装前提示安装，在后台启动和等待本地 IPC 前提示步骤。摘要列出识别到的 Adapter、已初始化的 Extra 及其他真实阶段，不将 loading 或 failed 报成已激活，不由本地就绪推断云端连接成功。

显式 --json 保持完整 JSON，无进度混入。前台 run 保留现有日志。服务管理、Home、身份、配置与执行协议保持既有行为。验证自动化的首次安装、已安装、失败、纯 JSON 输出，再对实际 Runtime 和 im-test 做真实检查。

新增 extraget name 返回完整持久化声明，不加载模块。status 与 daemon status 汇总每个已加载 Extra 的自定义 JSON，不投影业务字段；单项失败返回明确 status_error，未加载项保留生命周期。配置读取继续遵守权限、大小和字段校验。
