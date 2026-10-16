# Octo Runtime 使用与接入入口

按使用场景选择指南，具体操作和示例只在对应指南维护。

| 场景 | 文档 | 责任 |
| --- | --- | --- |
| 云端设备的定制接入、部署和运维 | [CLI 使用指南](CLI_USAGE_GUIDE.md) | 使用完整 CLI 发行物及系统管理、自启服务 |
| Electron 项目只接入 Octo IM；OctoBuddy 推荐 | [SDK Channel Gateway 指南](SDK_CHANNEL_GATEWAY_GUIDE.md) | submodule、依赖、IM 配置、主进程启动与重载 |
| 自行装配 Runtime 或直接调用 Agent | [SDK 完整原生接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md) | 原生启动、特性配置、可选 Agent 调用 |

**Electron、Tauri 2 桌面程序严禁通过 CLI 接入，必须使用 SDK。** SDK 管理的 daemon、Host、Provider 子进程以及 Adapter 依赖的 Provider CLI 不等于以 Octo Runtime CLI 接入。

CLI 默认包含全部 Adapter、Extra，以及系统管理、开启自启等服务能力；默认包含不表示安装后全部启用或已注册自启。SDK 宿主自行选择需要的依赖和装配范围。

- 配置来源与对象契约：[SDK 配置说明](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#22-加载和重载-extra)。
- CLI Extra 文件配置：[接入 Octo IM](CLI_USAGE_GUIDE.md#4-接入-octo-im)。
- SDK Extra 装配：[SDK Extra 管理](SDK_CHANNEL_GATEWAY_GUIDE.md#5-保存或重新加载-im-配置)。
- 发行与打包：[DEPLOYMENTS.md](DEPLOYMENTS.md)。
- 架构合同：[基础架构](.octospec/rules/architecture.md)、[Runtime 生命周期](.octospec/rules/runtime-lifecycle.md)。

本文件仅作选型导航；原接入正文已拆入上述两份指南。
