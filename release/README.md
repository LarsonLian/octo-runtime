# Octo Runtime

提供 `octo-runtime` 命令的本地 Agent Runtime。要求 Node.js 24 或以上。

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

也可以在项目内安装，通过 `npx octo-runtime --help` 调用。

内部模块随 CLI 一起打包、升级，只发布一个 npm 包。第三方插件可使用两个公开入口：

```ts
import type { ExtraPlugin, ExtraContext, CanonicalEvent } from "@mininglamp-oss/octo-runtime/extra";
import { InvokeInput, isTerminal } from "@mininglamp-oss/octo-runtime/protocol";
```

`/extra` 提供完整插件生命周期、声明、JSON 配置、注入执行端口和协议类型；`/protocol` 提供全部协议类型，以及输入检查、Context/事件/帧/交互校验和终态工具。invoke 使用 ctx.adapterHost 注入实例，支持 native/canonical 类型推导。客户 TS 工程局部安装本包及 TypeScript、@types/node，以 NodeNext/ESM 编译为 JS，再通过 extraset 配置入口绝对路径并重启 daemon 加载。

根入口和未声明的内部子路径继续拒绝包名导入；不提供独立宿主 SDK 工厂。此限制不提供源码加密或文件访问隔离。第三方 Adapter 公开入口及 extra_adapters.json 加载仍待实施，不是本版本已有功能。
Provider 程序由宿主或用户另行选择安装，安装此包不会自动下载 Provider。
升级程序保留已有 Runtime Home、身份与配置；已运行的进程需要重启才能使用新版本。
