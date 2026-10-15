# Runtime 安装

HostApp 明确选择 Runtime、Provider 及版本，执行层不隐式下载或安装。源码调试按根 README 构建；独立 CLI 可以在宿主选定的环境中安装已发布的固定版本，或对本地源码执行 `npm link --foreground-scripts`。

旧 Worker enrollment 一键安装脚本已随预研迁到生态目录外的 `octo-runtime-worker-access/archive/installers`，只作参考备份，不属于当前 Runtime 发行物。

直接执行 `octo-runtime daemon install` 或 `octo-runtime daemon run`，两者共用默认 Runtime Home，自动准备缺失的本地配置与 machine identity，保留已有数据。CLI 不提供 `login` 命令；登录、登记及共享由按需接入的 Extra 负责。
