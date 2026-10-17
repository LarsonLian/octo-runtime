---
type: Journal
title: Octo 渠道配置扩展与展示名称验证
description: 记录未知字段透传、Bot 名称和多机器人配置验证范围。
tags: [channel, testing]
timestamp: 2026-10-15T00:00:00Z
---

# Octo 渠道配置扩展与展示名称验证

通用 Extra 配置与加载器保持插件 JSON 对象透传。Octo 插件移除顶层及 adapter 的未知字段白名单，保留已识别字段校验；未知字段被保存，不代表插件已实现该扩展。bot_name 可选，CLI 保存及 SDK 运行状态缺省使用 bot_id，名称不参与连接身份。

channel configure 按平台、API 地址和 bot_id 完整替换一项，保留其他项；extraset 完整替换指定插件声明，多个机器人需由插件自己的 bots 数组表达。名称字段不是通用框架要求。

验证：workspace 构建与 TypeScript 检查通过；cli-channel、extras、channel-packages 共 19 项通过。全量测试 734 项中 714 项通过、13 项失败、7 项跳过；失败包括 WeCom/Host 构建产物缺失及 Host readiness/playboard 用例，不能报告全量通过。全仓 lint 存在未使用变量及类型解析错误，不能报告全仓通过。

线上测试环境 https://im-test.deepminer.com.cn/api/v1/auth/verify-bot 的空凭据请求返回 400。当前仅找到生产环境 Bot 配置，未执行测试环境有效 Bot 鉴权、连接或消息收发；接口可达不等于业务联调通过。生产配置未修改。
