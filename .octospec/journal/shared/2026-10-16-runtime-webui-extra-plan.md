---
type: Journal
title: 本地 WebUI Extra 规划与需求补充
description: 记录旧 demo 替换、Work App 代码移植、固定端口和 WebUI 专属有界 JSON 会话计划的交付边界。
tags: [extra, architecture, stream, workspace, interaction, adapter, testing]
timestamp: 2026-10-16T00:00:00Z
---

# 本地 WebUI Extra 计划

已建立[任务简报](../../tasks/runtime-webui-extra/brief.md)和 context.yaml，并更新知识索引与 log。本轮按用户要求只产出 OctoSpec 计划，未实施运行代码、删除旧包、修改运行配置、启动服务或连接线上环境。

已合入用户在本轮补充的约束：

- 删除 `octo-runtime-extra-sse-demo`，新包名准确使用 `octo-runtime-webui-extra`，本机端口固定 `13888`。
- 从当前 Work App 尽量直接复制代码、样式、资源和测试，完整复刻 thinking/工具展开收缩、输入区及右下角模型/引擎/effort 菜单，不自行重设计。
- 完整相同的 canonical 协议由前端解析；Extra 提供本地接口并复用共享 Host 的 Adapter 列举和实际探测，不新增能力目录。
- 默认项目 `~/octo-runtime-workspace`，项目等于本机目录，选择记录用 sessionStorage。
- sidebar sessions 改用 WebUI 专属临时 JSON，跨项目合计最多 100 个，超限淘汰最旧的已结束记录，保存真实 opaque Provider session 绑定，支持刷新、单条及全部清理。此项取代计划初版的纯浏览器会话存储，不改变其他入口的存储合同。

实施按 M0 来源与接口、M1 Extra 接线、M2 原版聊天协议、M3 工作台和会话、M4 真实验收分阶段。验收包含同流回放对比、迁入交互测试、JSON 淘汰与迟到写入、Provider 真实执行、CDP/Playwright、im-test 既有 Extra 共存及仓库外发行安装，均尚未执行。

文档检查使用 `uv run --with pyyaml python .octospec/scripts/lint.py`，OKF 元数据、规则索引和本地文件链接通过；`git diff --check` 通过。系统 `python3` 缺少 PyYAML，改用 uv 临时环境完成检查，未修改项目依赖。未为纯文档变更运行构建、代码测试或模型调用。
