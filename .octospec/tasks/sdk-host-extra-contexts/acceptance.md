---
type: TestPlan
title: 宿主完整 SDK 接入的验收
description: 按启动、加载、更新数据、查询、重载和退出验证接入流程，内部接线由 SDK 团队回归。
tags: [sdk, testing, extra, lifecycle]
timestamp: 2026-10-17T00:00:00Z
---

# 宿主完整 SDK 接入的验收

本地 SDK 已实施，以下区分仓内自动化与后续宿主验收。用户本轮只要求 SDK 接口和 daemon 单测，不修改第三方 App；实际检查见[交付记录](../../journal/shared/2026-10-17-sdk-host-extra-contexts.md)。

仓内已通过 [SDK 13 项测试](../../../test/sdk-host-extras.test.js)及[执行流回执在途取消测试](../../../test/embedded-invoke.test.js)。测试使用 fake Provider 与 SDK 自己启动的独立 Host；不连接真实 IM，不证明第三方 App 已接通。

## 面向宿主的一条完整流程

后续以 [register-demo](../../../../octo-runtime-channel-gateway-register-demo/src/main/index.ts) 为主要样例，沿现有 submodule/workspace 编译和 SDK 接入方式验证。保持它的独立 Host 入口，不在 demo 中创建 ExtraPlugins 或执行桥。本轮暂不修改或运行该 App。

| 步骤 | 宿主操作 | 必须观察到的结果 |
| --- | --- | --- |
| H01 | 创建 runtime 并 startAccount | 已有身份与 Home 不因本需求被重建，独立 Host 就绪；demo 自有临时 Home 仍按其原有约定管理 |
| H02/H03 | 将已有 persona.loadContexts 传给 runtime.loadExtra | 完整 Gateway 加载；函数在宿主进程执行，没有第二组 Bot 连接 |
| H04 | 第一轮读取 A；修改宿主数据为 B 后发第二轮 | 同一个回调读取新值，当前轮快照不变，连接和 Host 不因数据修改重启 |
| H05 状态 | 查询 extraStatus/health | 同一公开接口返回真实生命周期和业务状态，错误不被隐去 |
| H05 重载 | await unload，再以新 JSON 或函数引用 load | 旧实例完成清理，新实例用新值；不影响其他 Extra 和共享 Host |
| H06 | await stop，或切账号后重新提交配置和函数 | 旧连接、任务与回调被纳入清理；新账号不沿用旧闭包；失败如实报告 |

上述流程通过统一 SDK 连续完成，才标为宿主接入目标 100%。函数版本更新与 Provider system 指令生效分别验证：普通 Context 逐轮变化；系统指令按原会话合同在业务显式 reset 后的新会话验证。

## SDK 团队的必要回归

这些场景不要求宿主新增业务代码，仅用于证明原有接口在新装配方式下保持有效：

- JSON descriptor、自带 CLI 静态配置和 SDK 函数路径都可加载；同名实例只存在一份。
- 未启动时 load 明确失败；加载中 unload、重复卸载和初始化失败都先 abort，再按现有宽限清理。
- 真实执行沿原 daemon/独立 Host；源帧、取消、交互回答及 executionEnvOverrides 保持原合同，身份映射由 SDK 管理。
- 停止、退出、切账号和 runner 故障使旧代次失效；不自动重放旧 Run，不把旧回答发到新账号。
- 回调抛错、非法返回、超时和满额沿既有合同失败；不回退旧动态结果，不因反复重载绕过未结束操作。
- extraStatus/health 不被 runner 轮询抹掉本地项；日志沿现有显式目录和白名单，不含函数参数、正文或凭据。
- 反复加载/卸载后释放实例、函数和监听器；复用既有内存回归，不为本次另建测试平台。

## 真实验证和交付记录

真实 Gateway 调试使用 im-test.deepminer.com.cn 的获准隔离 Bot/会话，经 **createDaemonRuntime → runtime.loadExtra(module, config, dependencies)** 到本机 Codex 完成执行。先验证连续两轮数据更新，再验证执行中的取消/卸载及重新加载成功。不能用直接创建 loader 的脚本冒充 SDK 接入证据。

标准交互回答需走原 invocation。自动化接线回归与真人按钮回调分别记结果；无法完成的真实场景明确标未验，不伪造通过。宿主构建、重启和真实测试环境验证按实际影响执行，不能用仅构建库代替已运行应用更新。

按改动运行受影响包构建、类型、lint、SDK/loader/Channel 相关回归及文档链接检查；共享执行行为改变时执行全量回归。交付记录引用 H01–H06 实测结果，指南给出不包含内部装配的完整示例。当前不新增 npm 发布或分发平台验收，也不授权重建用户身份或切换其应用环境。
