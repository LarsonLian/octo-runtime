# Octo Runtime 开发与联调

日期：2026-10-14。当前架构见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)和[架构说明](ARCHITECTURE.md)。

## 1. 开发原则

先验证不依赖云端的本地身份、IPC 与真实执行，再按宿主选择分别验证 Worker 和 IM。注册失败、未启用设备在线或频道断线不能成为本地启动失败的理由。

HostApp 负责安装计划、业务目标、defaults／mandatory 和每轮 Context；底层校验并转发协议，不补业务背景、不自动创建 Agent。Run 7 与 Context v3 独立保持。更新范围及迁移方式遵循[基础架构规则](.octospec/rules/architecture.md)，历史重置授权不作为后续 Runtime 状态清理依据。

fake Provider 和临时 SQLite 适用于合同测试。调试真实服务必须使用 `https://im-test.deepminer.com.cn/`；涉及桌面 UI／真实接口时还须驱动真实 renderer，单元测试不能代替实机验收。

## 2. 环境与构建

要求 Node.js 24+、pnpm 11+。实际 Provider 执行还需要宿主明确安装对应引擎并完成其认证。不要在 Runtime 探测、注册或 Run 中隐式下载依赖。

在本仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

修改 package 元数据、入口、manifest 或 TypeScript 后，使用当前构建物并重启受影响进程。修改协议还须同步 Worker、Runtime 和桌面应用，按根 AGENTS.md 验证内置 Runtime；npm link 完成不等于旧进程已替换。

可选源码 CLI link：

```bash
npm link --foreground-scripts
octo-runtime --help
```

CLI 是运维入口，客户 SDK 不依赖其 app launcher 或原生服务安装。

## 3. 纯本地验证

使用独立 app-owned Home，按 [SDK 接入指南](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#1-原生启动-octo-runtime)提供稳定 appId、subject 与完整 tenant 集合。不要复用或覆盖正在运行的 Work App／standalone Home。

检查：

1. 首次本地初始化即有 Runtime ID；重启复用同一身份。
2. IPC 实际就绪后可探测并 invoke；不要求 Human Token、Worker URL 或 enrollment。
3. 没有登记可选模块时不加载或连接 Worker／IM。
4. 显式启用缺失模块返回错误，但本地执行继续可用。
5. 停止单个模块保留共享 Host；关闭账号／应用回收进程。
6. 本地事件按原源游标修复，不重执行；历史由应用保存。

独立生产部署验证：

```bash
pnpm --filter @mininglamp-oss/octo-runtime-daemon deploy --prod /absolute/staging/daemon
node scripts/verify-daemon-deployment.mjs /absolute/staging/daemon
```

前台 CLI 诊断可使用 `octo-runtime --home /absolute/test-home daemon run`，一次本地 Adapter 调试可使用 `playboard`。已保存云端 profile 的 CLI 仍可能恢复 Worker 连接，因此不能拿该 Home 代替“未携带 Worker 包”的最小部署证明。

## 4. 可选真实接入验证

Octo 测试环境根地址为 `https://im-test.deepminer.com.cn`，Worker API 为 `https://im-test.deepminer.com.cn/agentworker/api`。Human 身份与租户授权由真实服务校验，本地 SDK 的业务 subject 不能替代远程认证。

Worker 测试由 HostApp 显式提供工厂和注册配置。记录本地 Runtime ID、真实注册回执和实际连接分别成立；注册复用本地 ID，不自动创建 Agent。当前工厂组合注册、WS 与远程执行，最终 access／设备连接职责仍待评审。

IM 测试独立提供 channel-im 与 Bot 配置，不启用 Worker。分别记录频道连接、输入、Provider 终态和回发结果，不能因为 Bot 在线便声明设备远程可寻址。

凭据从受保护的本地配置／当前授权态取得，不贴入文档、日志或命令参数；secret.md 不入库。凭据失败只处理对应授权或模块，不清空本地身份或自动重新建 Runtime。

## 5. 真实 Work App 验证

按 Work App 的 dev／CDP 说明启动并确认真实 renderer。协议、别名或 SDK 构建变化后须干净重启 Electron 应用与 dev server，避免旧进程持有失效构建物或单实例锁。

验证本地 IPC、真实回复、完整源事件与应用 SQLite 的一致性，以及历史界面回显。Worker 默认关闭时上述路径仍应成功。额外验证 IM 时保持独立配置。

当前包与接入边界见 [Runtime 合同](.octospec/rules/runtime-lifecycle.md)。包拆分后的构建、进程重启和真实环境验收需针对最终工作树单独记录，不能复用旧包验证结论。

## 6. 排障与结果记录

按照 [运维指南](.octospec/guides/operations.md)区分身份、本地进程、Provider、注册、Worker 和 IM 故障。命令或模块接纳不是执行完成；云端 online 不是本地 ready；实时事件窗口不是 durable outbox。

记录场景、构建版本、实际服务地址、运行身份、真实终态和未验证项。历史研究中的注册必经、Worker Agent 配置、业务 Event API 或 durable ACK 不得作为现行接入依据。
