# Runtime 安装

HostApp 明确选择 Runtime、Provider 及版本，执行层不隐式下载或安装。源码调试按根 README 构建；独立 CLI 可以在宿主选定的环境中安装已发布的固定版本，或对本地源码执行 `npm link --foreground-scripts`。

旧 Worker enrollment 一键安装脚本已随预研迁到生态目录外的 `octo-runtime-worker-access/archive/installers`，只作参考备份，不属于当前 Runtime 发行物。

CLI 本地初始化为 `octo-runtime login`，随后按需要执行 `daemon install` 或 `daemon run`。它不注册 Worker，不恢复旧 Worker 连接，也没有云端 `--wait-online` 验收步骤。
