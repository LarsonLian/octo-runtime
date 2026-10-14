# WeCom Channel

`@mininglamp-oss/octo-runtime-extra-channel-wecom` 独立持有企业微信 Bot WebSocket 鉴权、心跳、消息映射、stream 回复、ACK 顺序和连接替换处理。它不依赖 Octo Gateway Channel，不使用 Octo REST、悟空连接或卡片协议。

目录与 gateway 类似：`transport/`、`application/`、`lifecycle/`、`execution/`、`delivery/`、`presentation/`。每个 channel 独立演进，没有跨平台 connector registry 或按 type 分发的底层工厂。

```ts
import { ImChannelManager } from '@mininglamp-oss/octo-runtime-extra-channel-wecom';
const channel = new ImChannelManager({ host }); // invoke / cancel / respondInteraction
await channel.upsert({
  type: 'wecom', bot_id: botId, app_secret: secret,
  adapter: { adapter_type: 'codex', workdir: absoluteWorkdir },
  context: { schema: 'octo.context-envelope/v3', items: [] }
});
await channel.close();
```

SDK 动态入口为 `./daemon-module` 的 `createImModule`，模块 ID 为 `channel-wecom`。支持 `upsert`、`remove`（`connection_key`）和 `status`。额外插件入口默认导出，`name='channel-wecom'`，配置为 `{ bots: [...] }`。HostApp 决定是否携带、何时启用及卸载。

显式文件入口读取 `wecom.json`，凭据可以内联或用 `app_secret_file` 指定，含凭据的文件要求 0600。默认 WS 为 `wss://openws.work.weixin.qq.com`。连接探针为 `scripts/probe-wecom.mjs`。

本包作为 Event 发起方提交本轮 Context，空输入与显式重复有效；不会按会话补齐上下文。执行配置独立校验，不进入模型文本。Run=7、Context=v3。会话与回执使用有界内存，不承诺跨重启恢复；真实企业微信客户端显示效果需平台验收。
