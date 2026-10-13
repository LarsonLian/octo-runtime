# Daemon 启动入口

## 责任边界

- 负责：解析配置、启动现有 Daemon、转发信号，接入既有用户服务管理。
- 不负责：不承载 Worker WS 业务实现，不为 IM 建第二套启动器。
- 接口与现状：实现分别由 daemon、worker-access、adapter-host 包持有。原有小型转导出文件仅用于现有入口调用。

整体架构见 [根 README](../../README.md)。
