# Octo Gateway Channel

`@mininglamp-oss/octo-runtime-extra-channel-gateway` 只负责 Octo IM 接入：Bot 认证、悟空长连接、消息与卡片、typing、Context v3 和结果回发。企业微信由独立的 `octo-runtime-extra-channel-wecom` 持有。

本包是 IM Event 发起方，决定本轮 Context 的内容、顺序和发送时机。允许空上下文或显式重复；Host 只校验、转发和固定渲染，不从历史补齐上下文。执行配置与模型上下文独立，Run=7、Context=v3。

## 结构

`transport/` 持有 Octo 协议和 REST API；`application/` 管理单 Bot 会话与调用；`lifecycle/` 管理配置和启停；`execution/`、`delivery/`、`presentation/` 负责本包的调用与输出。没有跨平台 connector registry，不依赖 WeCom channel。

## 使用

```ts
import { ImChannelManager } from '@mininglamp-oss/octo-runtime-extra-channel-gateway';
const channel = new ImChannelManager({ host }); // invoke / cancel / respondInteraction
await channel.upsert({
  bot_id: botId, bf_token: token,
  api_url: 'https://im-test.deepminer.com.cn/api',
  adapter: { adapter_type: 'codex', workdir: absoluteWorkdir },
  context: { schema: 'octo.context-envelope/v3', items: [] }
});
await channel.close();
```

SDK 宿主通过通用 Extra 声明及 `configureExtra` 配置入口装配插件；Bot 数组和连接管理由插件解释，不在 daemon/CLI 添加平台分支。

统一通过 Extra 使用：入口默认导出插件，`name='channel-gateway'`，配置为 `{ bots: [...] }`，共享宿主执行端口并在卸载时关闭连接。CLI 保存完整声明到 `<home>/default/extra/channel-gateway/config.json`，SDK 显式传入声明；多个 Bot 放在同一 `config.bots` 数组中。

凭据只用于连接，不进入模型输入或状态。会话和投递回执有界保存在内存中，不承诺跨进程恢复或 exactly-once。
