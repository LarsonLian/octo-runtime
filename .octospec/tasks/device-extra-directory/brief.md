---
type: Task
title: 修正 CLI Extra 的设备级配置目录
description: 将 Extra 配置从 default profile 目录改到 Home 根目录并保护既有状态。
tags: [extra, runtime, lifecycle]
timestamp: 2026-10-15T00:00:00Z
---

# 目标与范围

用户指出 `~/.octo-runtime/default/extra/channel-gateway/config.json` 错误地将设备级 Extra 放进 profile。CLI 的保存、读取、诊断与 daemon 扫描统一使用 `<home>/extras/<name>/config.json`。profile 只区分虚拟 Runtime；`extras` 保留为 Home 基础目录名。

不修改 Run 7、Context v3、SDK 的宿主自有存储合同或 Runtime 身份。当前版本尚未发布，直接实施唯一目录；不增加历史目录探测、兼容、迁移、提醒或自动复制逻辑，不操作现有 Home/profile 或身份。

# 决策理由

SDK 接收宿主显式提供的声明，不限制宿主选择文件、SQLite 或其他配置来源。CLI 自身就是宿主，必须对自己的持久化位置给出唯一合同：同一 Home 的 daemon、AdapterHost 与 Extra 共享生命周期，profile 只区分虚拟 Runtime。Home 是宿主运行实例边界，不等同于整台物理机器；不同 Home 保持独立。

若允许 `<home>/<profile>/extra` 与 `<home>/extras` 同时作为配置源，同名配置将产生优先级、覆盖与重复加载歧义。用户可能修改一个实际未读取的文件，却误以为生效。因此 CLI 不支持 Extra 的 profile 分区，不按目录顺序猜测配置，不以兼容回退维持多个有效位置。

CLI 保存、读取与 daemon 启动扫描只使用 `<home>/extras/<name>/config.json`。不探测其他位置，也不提示迁移；extraset/extraget 拒绝 `--profile`，避免参数看似改变配置范围。临时执行仍不扫描 Extra。保存成功不代表运行中的插件已应用，CLI 继续要求重启 daemon。

# 实施计划

1. [x] 记录 Home、profile、Extra 的归属与 SDK/CLI 的区别，明确唯一目录。
2. [x] 统一 CLI/daemon 路径，保留凭据权限与原子写入；保留 `extras` 基础目录名，不增加旧布局逻辑。
3. [x] 同步现行规则、接入文档和示例，补充不同 profile、不同 Home、前台启动和临时执行的回归覆盖。
4. [x] 构建、类型、lint、58 项相关回归及 im-test 实机验证，范围见 [验证记录](../../journal/shared/2026-10-15-cli-extras-directory.md)。
5. [ ] 仅提交本需求的代码与文档，并推送当前分支。

# 验收

- extraset/extraget 与 daemon 使用同一 Home 级目录，切换默认 profile 不改变 Extra。
- 不探测其他 Extra 目录，不迁移或修改现有配置与身份，凭据不回显。
- 构建、类型检查、lint 与相关 CLI/daemon 测试通过；真实调试连接 im-test，单独记录结果。
