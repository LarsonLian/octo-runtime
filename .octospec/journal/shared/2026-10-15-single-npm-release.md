---
type: Journal
title: 单包 CLI 发行验证
description: 内部模块统一随主包发行与隔离安装验证。
tags: [installation, verification]
timestamp: 2026-10-15T00:00:00Z
---

# 发行方式

对外只发布 `@mininglamp-oss/octo-runtime`。内部 packages 标记 private，产物使用根版本号并随 CLI 打包，根 exports 为空。内部项目可手动拷贝完整程序目录，或通过相邻源码仓库的文件入口接入，不要求独立 npm 包。文件级引用不是包名导入，也不受根 exports 限制；这不是源码保密措施。

# 验证

- pnpm pack:release 完成 workspace 构建并生成 0.1.0 tarball。
- 根 TypeScript noEmit、pnpm lint、git diff --check 通过。
- CLI 与渠道相关测试共 16 项通过。
- scripts/verify-release.mjs 使用隔离目录、空 npm 缓存、offline 模式完成全局安装；全局命令、daemon 与 12 个内置 Adapter 动态加载通过。
- 按包名导入根包、CLI 子路径及穿过 node_modules 的子路径均返回 ERR_PACKAGE_PATH_NOT_EXPORTED；独立导入内部 core、daemon 返回 ERR_MODULE_NOT_FOUND。
- im-test 首页 HTTP 200，仅证明环境可达；本次未改接口，未执行云端注册或模型调用，不据此声称云端业务验收通过。

未执行 npm publish，未变更已有 Runtime Home、身份、profile、配置或服务注册。升级在安装路径不变时只需重启；Node/npm prefix/Home 或服务定义改变时需重新 install 更新注册。

macOS 默认临时目录路径过长，首次隔离 daemon 启动触发 Unix socket EINVAL；验证脚本改用 /tmp 短路径后通过。发行器遇到同名多版本或可选生产依赖时明确拒绝，需要扩展打包策略后再发布，避免静默缺包。

# 1.0.0 本地安装

用户确定正式版本为 1.0.0 并授权本地安装；根包、workspace 版本与 daemon 版本同步为 1.0.0。重新构建打包、TypeScript 检查通过，隔离测试确认离线安装、CLI、daemon、12 个 Adapter、包名导入限制通过；额外验证 npm 卸载移除整个包与命令，但保留 Home。

使用本地 tarball 执行 npm install --global --offline，替换此前指向源码目录的全局链接。npm ls 确认 @mininglamp-oss/octo-runtime@1.0.0 已安装且不再链接源码；octo-runtime --help 通过。独立 CLI daemon status 显示服务 not_installed、application.ready=false；本次没有新建系统服务。桌面应用已有的内置 Runtime 进程保持不变，没有上传 npm registry。
