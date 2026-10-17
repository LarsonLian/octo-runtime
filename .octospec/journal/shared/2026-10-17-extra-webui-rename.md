---
type: Journal
title: WebUI Extra 统一包名与核心注释
description: 更正包与目录命名，更新发行链路并解释 Extra 的生命周期和动态 Context 资源约束。
tags: [extra, packaging, testing, documentation]
timestamp: 2026-10-17T00:00:00Z
---

# 改动范围

用户纠正 WebUI 包的命名顺序。本轮从 `ab6c010` 开始，将目录统一为 packages/octo-runtime-extra-webui，包名统一为 @mininglamp-oss/octo-runtime-extra-webui。Extra 稳定名称仍为 webui，CLI 配置目录与公开 /extras/webui/config-schema.json 入口保持原合同，不为旧模块名增加别名。

同步根 package.json、pnpm-lock.yaml、lint/TypeScript 路径、源码同步脚本、发行验证、测试、CLI/SDK 指南、配置 Schema 和当前 OKF 说明。历史 journal 的命令保留当时名称，文件链接更新至现行目录；历史名称不代表当前仍可加载。未修改其他宿主应用的 SDK 接入，未改写已有 Runtime Home、身份、profile 或插件配置。

用户同时要求核心代码写好注释。已在共享 loader、动态 Context 加载器、两个 Channel 和 WebUI 的关键分支补充中文说明：两阶段接口的数据/函数边界；同 key 整项覆盖及顺序；超时仅终止等待、未结束 Promise 继续占额；满额直接拒绝而不排队；迟到结果丢弃；校验前预算；准备阶段取消；逆序且只执行一次的清理；清理失败阻止重载及闭包引用释放。注释解释设计原因和边界，没有新增运行行为。

# 验证记录

- pnpm install --offline --frozen-lockfile --ignore-scripts 通过，workspace 链接改为新包名，锁文件无新增依赖版本。
- pnpm build、根 TypeScript、eslint、名称检查通过；WebUI 两份 Vitest 测试共 35 项通过。
- 最终全量 Node 共 1062 项：1053 通过、9 跳过、0 失败。首次运行小时日志测试跨整点产生两个文件，固定单文件断言失败；构建结束后完整复验通过，未修改无关日志实现或断言。
- 发行包离线安装通过，公开严格 TS 编译和外部 Extra 加载通过；断言新 WebUI 依赖存在、旧包目录不存在，三个内置插件均 loaded 且内部 errors 为空，WebUI HTTP 200；卸载保留测试 Home。未发布 npm。
- im-test 域名可达，HTTP 200。本轮没有新增或改变真实接口与 UI 行为，未新增真实模型、IM 消息或桌面 CDP 联调，不把域名检查当成业务执行证据。
- OKF 格式与本地链接、git diff --check 通过。更名和核心注释完成后提交，并重新生成干净提交的 build-info，用本次发行包更新本机全局 CLI；保留既有用户配置和数据。
