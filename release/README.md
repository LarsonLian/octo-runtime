# Octo Runtime

提供 `octo-runtime` 命令的本地 Agent Runtime。要求 Node.js 24 或以上。

```bash
npm install -g @mininglamp-oss/octo-runtime
octo-runtime --help
```

也可以在项目内安装，通过 `npx octo-runtime --help` 调用。

内部模块随 CLI 一起打包、升级，只发布一个 npm 包，不提供独立 SDK 导出。
包的 exports 为空，按包名导入根入口及子路径都会被拒绝。此限制不提供源码加密或文件访问隔离。
Provider 程序由宿主或用户另行选择安装，安装此包不会自动下载 Provider。
升级程序保留已有 Runtime Home、身份与配置；已运行的进程需要重启才能使用新版本。
