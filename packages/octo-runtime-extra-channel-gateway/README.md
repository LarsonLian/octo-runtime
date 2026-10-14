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
  type: 'octo', bot_id: botId, bf_token: token,
  api_url: 'https://im-test.deepminer.com.cn/api',
  adapter: { adapter_type: 'codex', workdir: absoluteWorkdir },
  context: { schema: 'octo.context-envelope/v3', items: [] }
});
await channel.close();
```

SDK 动态管理入口为 `./daemon-module` 的 `createImModule`，模块 ID 为 `channel-gateway`。支持 `upsert`、`remove`（`connection_key`）和 `status`。HostApp 显式登记并启动，不因导入而连接。

也可作为 extra 使用：入口默认导出插件，`name='channel-gateway'`，配置为 `{ bots: [...] }`，共享宿主执行端口并在卸载时关闭连接。文件入口只在宿主选择时读取 `im.json`，不主动扫描目录。

凭据只用于连接，不进入模型输入或状态。会话和投递回执有界保存在内存中，不承诺跨进程恢复或 exactly-once。
