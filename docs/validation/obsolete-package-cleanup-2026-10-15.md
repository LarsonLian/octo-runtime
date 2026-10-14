# 废弃包与安装链接清理

2026-10-15：在已有 Context Builder、Worker Access 删除及渠道 Extra 拆分改动基础上，清理主 checkout 的安装残留。其他历史 worktree 不在本次清理范围内。

## 清理结果

- 删除 Runtime 中 71 个旧 `octo-harness-*` 失效依赖链接。
- 删除 `packages/octo-runtime-worker-access` 的残留依赖目录；Context Builder 残留目录已在前一步清除。
- 删除当前 Node 24 全局 npm 中的 `octo-harness`、`octo-harness-embedded` 包链接及 `octo-harness`、`octo-harness-daemon` 命令链接，保留有效的 Runtime 链接。
- Work App 同步清理旧 kit 链接、构建别名及旧桌面打包产物，重新生成内置 Runtime。
- 主 checkout 全目录复查：失效依赖链接为 0，旧 Harness / Context Builder / Worker Access / Channel IM 依赖链接为 0。Electron Singleton 锁不作为依赖链接处理。

## 验证

- Runtime 全 workspace 构建及根类型检查通过。
- 全量 Node 回归：731 项，724 通过、7 跳过、0 失败。
- 独立图标包构建及 6 项测试通过。
- Work App 重启后通过 CDP 连接真实 renderer，服务器为 `https://im-test.deepminer.com.cn`，已登录，内置 Runtime 为 running。
- 同一会话 A、空、B、重复 B 四轮调用成功，文档和对象选区构造正确，无捕获的 renderer 异常。
- `cloudConnected=false`；以上验证证明本地 Host invoke，不声明云端 Worker 执行链路通过。

日志位于 `/tmp/octo-runtime-cleanup-test.log`、`/tmp/octo-runtime-cleanup-typecheck.log`、`/tmp/octo-runtime-cleanup-tsc.log`；实机报告和截图位于 `/tmp/octo-context-invoke-live.json`、`/tmp/octo-context-invoke-live.png`。
