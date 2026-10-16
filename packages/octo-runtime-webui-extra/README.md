# octo-runtime-webui-extra

本地浏览器工作台，Extra 名称 `webui`，默认地址 `http://127.0.0.1:13888/`。复用宿主的 AdapterHost，不启动另一套执行内核。界面与事件投影从 `octo-work-app` 移植，来源和适配边界见 [porting-map.md](porting-map.md)。旧 SSE demo 已移除。

## CLI

宿主明确设置会话 JSON 的绝对路径。示例中的 Home 使用 CLI 默认值；自定义 `--home` 时同步调整路径：

```sh
octo-runtime extraset webui <<JSON
{
  "module": "@mininglamp-oss/octo-runtime-webui-extra",
  "enabled": true,
  "config": {
    "port": 13888,
    "sessionStorePath": "$HOME/.octo-runtime/extras/webui/sessions.json"
  }
}
JSON
octo-runtime daemon run
```

`daemon run` 是前台启动；已安装后台服务时使用 `octo-runtime daemon restart` 读取新声明，再用 `octo-runtime status` 查看状态。保存声明不自动重启当前实例。CLI 没有单插件装卸命令；宿主可使用下述 SDK 装卸单个 Extra。旧 demo 的用户配置不会被自动删除，需要手动停用旧声明。

## SDK

SDK 不依赖 React。HostApp 安装并选择此包，显式加载时才导入服务端模块；React、Markdown、图标和样式在构建时打包为 `dist/web` 静态资源，浏览器打开页面后才加载。

```ts
import { fileURLToPath } from 'node:url';

await runtime.loadExtra({
  name: 'webui',
  module: fileURLToPath(import.meta.resolve('@mininglamp-oss/octo-runtime-webui-extra')),
  config: {
    port: 13888,
    sessionStorePath: '/absolute/host-owned-home/extras/webui/sessions.json'
  }
});
await runtime.extraStatus('webui');
await runtime.unloadExtra('webui');
```

`runtime` 是已经启动的 `createDaemonRuntime()` 实例。也可把同一声明放进其 `extras` 数组。宿主须提供 Extra 的 `adapterHost.list` 只读端口；daemon 的共享 Host 已实现。旧宿主缺少此端口时返回 `ADAPTER_LIST_UNAVAILABLE`，不会虚构可用引擎，也不会安装 Provider。

## 数据与接口

- 配置：`port` 默认 `13888`，仅绑定 `127.0.0.1`；`sessionStorePath` 必须为绝对路径；`defaultProjectPath` 可覆盖默认的 `~/octo-runtime-workspace`。
- 项目是服务所在机器的真实目录。默认目录首次创建，其他目录通过页面目录选择器添加，项目列表、选择、文本草稿和模型 ID 保存在 `sessionStorage`。
- 会话 JSON 格式为 `{version:1,sessions:[...]}`，最多 100 条，按最近活动顺序淘汰未运行会话。完整不透明 `providerSession` 原样保存；`sessionId` 不等于 Provider binding。文件以 `0600` 原子替换，串行写入并校验 revision。总大小上限 32 MiB，超限明确失败，损坏文件不覆盖。
- 单条删除和全部清理仅删除本 WebUI 记录，取消其在途连接并等待清理；迟到的 PATCH 返回 404/409。不会删除项目文件、Provider 原生会话或 Runtime 身份。
- `GET /api/bootstrap`、`/adapters`、`/directories?path=...`、`/sessions`、`/sessions/:id`；`POST /api/sessions`、`/invoke`、`/invocations/:id/cancel`、`/invocations/:id/respond`；`PATCH /api/sessions/:id`；`DELETE /api/sessions[/:id]`。
- 页面设置 HttpOnly/SameSite cookie；接口校验 Host，写入校验同源 Origin 与页面 token，不开放 CORS。令牌不写磁盘。限制请求字节、最多 4 个在途调用、每会话单一调用；SSE 经 Node pipeline 背压转发，断连和卸载传递取消信号。
- 输入使用 `InvokeInput`、Context `octo.context-envelope/v3` 和 canonical 输出；SSE 完整传递原事件，投影只在浏览器运行。EOF 未收到终态显示断线，不当作完成，不自动重发。模型业务上下文只发送本轮 inputs；续接仅使用真实 Provider binding。
- 模型菜单保留原版引擎子菜单、默认/自定义模型、四挡 effort、重置及键盘行为。引擎来自真实 Adapter 探测，自定义模型 ID 在本 WebUI 本地设置中维护。

状态返回 `{listening,host,port,activeRequests,errors}`。配置错误和端口占用保留明确错误码；`phase:loaded` 不代表监听成功，应同时检查 `listening` 和 `errors`。卸载关闭连接与监听，其他 Extra 和共享 Host 继续运行。

## 验证

```sh
pnpm --filter @mininglamp-oss/octo-runtime-webui-extra build
pnpm --filter @mininglamp-oss/octo-runtime-webui-extra test:ui
node --test test/webui-extra.test.js
```

浏览器测试须通过真实页面发送、刷新续聊、展开过程、切换目录及清理会话；自动化 fake Provider 与真实 Provider 证据分别记录在 OctoSpec 任务中。
