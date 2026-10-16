# SDK 完整原生接入指南

已有 Electron 项目，按下面三步接入：**启动 Octo Runtime → 配置需要的特性 → 可选地直接调用 Agent**。只需要 Octo IM 的项目（建议 OctoBuddy 采用）直接看 [Channel Gateway 接入指南](SDK_CHANNEL_GATEWAY_GUIDE.md)。桌面程序必须使用 SDK，不通过 CLI 接入。

## 1. 原生启动 Octo Runtime

### 1.1 加入 submodule

以下从已有 Electron + TypeScript 项目开始，以 ESM、pnpm 11+ 和 Node.js 24+ 为例。Runtime 子仓保留自己的 workspace，宿主无需修改 `pnpm-workspace.yaml`；保留宿主原有依赖、脚本和 Electron 版本。CommonJS 项目需将本节 Runtime 辅助文件单独编译为 ESM，不能直接修改整个项目的模块制式。

```bash
# 在已有 Electron 项目（例如 OctoBuddy）的根目录执行
git submodule add git@codex.mlamp.cn:dmwork/octo-harness-ecosystem/octo-runtime.git octo-runtime
git submodule update --init --recursive
```

后续克隆宿主仓库使用 `git clone --recurse-submodules <宿主仓库地址>`。宿主提交固定 submodule 的 commit；无需让终端用户安装 Runtime CLI。

### 1.2 配置依赖并构建

子仓位于宿主的 `octo-runtime/` 子目录。宿主通过 `link:./octo-runtime/packages/<包目录>` 引用具体包，路径相对于声明该依赖的 `package.json`，指向包含目标包 `package.json` 的目录。例如 core 包对应 `link:./octo-runtime/packages/octo-runtime-core`。

只需 Codex + OpenClaw 时，宿主根目录的 `package.json` 合并以下 4 项直接依赖：

```json
{
  "type": "module",
  "dependencies": {
    "@mininglamp-oss/octo-runtime-daemon": "link:./octo-runtime/packages/octo-runtime-daemon",
    "@mininglamp-oss/octo-runtime-adapter-host": "link:./octo-runtime/packages/octo-runtime-adapter-host",
    "@mininglamp-oss/octo-runtime-adapter-codex": "link:./octo-runtime/packages/octo-runtime-adapter-codex",
    "@mininglamp-oss/octo-runtime-adapter-openclaw": "link:./octo-runtime/packages/octo-runtime-adapter-openclaw"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.3"
  },
  "scripts": {
    "build:octo:deps": "pnpm --dir octo-runtime --filter @mininglamp-oss/octo-runtime-daemon... run build",
    "build:octo:host": "tsc -p tsconfig.octo.json"
  }
}
```

这四项分别是 SDK、Host、Codex Adapter 和 OpenClaw Adapter。Runtime 内部包的 `package.json` 和内部 `workspace:*` 保持原样；这些包不独立发布到 npm。

```bash
# 在宿主根目录执行：先安装、构建 Runtime，再安装宿主
pnpm --dir octo-runtime install --frozen-lockfile
pnpm run build:octo:deps
pnpm install
```

`link:` 只建立符号链接，不会替目标包安装依赖，因此第一条命令不可省略。强制依赖没有遗漏：

| 包 | 如何安装与声明 |
| --- | --- |
| 上述 4 项 | 宿主直接使用，列入宿主 `dependencies` 并链接到子仓中各包的相对路径 |
| `octo-runtime-protocol`、`octo-runtime-core`、`octo-runtime-adapter-sdk` | 已在 Runtime 包的依赖中声明，由子仓安装和构建；宿主直接 import 时再添加直接依赖 |
| 其他 Adapter 及第三方库 | 按现有包依赖传递安装；只注册 Codex/OpenClaw 不会裁剪这部分依赖 |
| `octo-runtime-extra-channel-gateway` | 需要 Octo IM 时再添加，按 [Channel Gateway 指南](SDK_CHANNEL_GATEWAY_GUIDE.md)操作 |

正式包仍须携带完整生产依赖，不能只复制这 4 个目录，见 1.6 节。宿主不依赖子仓根 CLI 包，也不执行 CLI 的安装或启动命令。

其他机器或 CI 按相同子目录检出 submodule 后即可使用这些相对路径。运行时仍通过包名 import。

### 1.3 选择 Codex 和 OpenClaw

```ts
// src/main/octo/adapter-host.ts：只由独立 Host 子进程执行，main 不 import 此文件。
import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { openclawAdapter } from "@mininglamp-oss/octo-runtime-adapter-openclaw";

// 本产品只注册这两个 Adapter；新增框架支持不会自动加入。
serveAdapterHost([codexAdapter, openclawAdapter]);
```

在宿主根目录增加 `tsconfig.octo.json`，将独立入口和下面的 SDK 辅助模块编译到固定位置：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [
      "node"
    ],
    "rootDir": "src/main/octo",
    "outDir": "dist/main/octo",
    "skipLibCheck": false
  },
  "include": [
    "src/main/octo/**/*.ts"
  ]
}
```

已有构建工具可以实现相同输出；必须保留独立的 `dist/main/octo/adapter-host.js`。

### 1.4 创建 SDK 实例

```ts
// src/main/octo/runtime.ts
import { app } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonRuntime } from "@mininglamp-oss/octo-runtime-daemon";

export const appId = "octobuddy";
export const runtimeHome = join(app.getPath("userData"), "octo-runtime");
// 示例使用固定本地身份。已接入账号的产品改用真实稳定 UID 和租户 ID。
export const subjectId = "local-user";
export const tenantId = "local";
const resources = join(process.resourcesPath, "octo-runtime");

// 主进程先解析绝对入口，避免 daemon 从自己的目录查找宿主依赖。
export function runtimeModule(packageName: string): string {
  return app.isPackaged
    ? join(resources, "node_modules", "@mininglamp-oss", packageName, "dist", "index.js")
    : fileURLToPath(import.meta.resolve("@mininglamp-oss/" + packageName));
}

export const runtime = createDaemonRuntime({
  appId,
  home: runtimeHome,
  development: !app.isPackaged,
  distribution: app.isPackaged
    ? {
        nodePath: process.platform === "win32"
          ? join(resources, "node", "node.exe")
          : join(resources, "node", "bin", "node"),
        runnerPath: join(resources, "node_modules", "@mininglamp-oss",
          "octo-runtime-daemon", "dist", "runtime", "runner.js"),
        adapterHostEntrypoint: join(resources, "adapter-host.js")
      }
    : {
        adapterHostEntrypoint: fileURLToPath(new URL("./adapter-host.js", import.meta.url))
      }
});

export async function startOcto() {
  const health = await runtime.startAccount({
    subject: { type: "user", id: subjectId },
    tenants: [{ id: tenantId }]
  });
  if (!health.local.ready) throw new Error("LOCAL_RUNTIME_UNAVAILABLE");
  return health;
}
```

`appId`、`runtimeHome`、`subjectId` 和 `tenantId` 在重启及更新后保持稳定。当前 SDK 要求 subject 和非空 tenants；示例不要求 Octo 登录。

### 1.5 在主进程启动和退出

```ts
// 合并进宿主已有的 Electron main 入口及退出流程。
import { app } from "electron";
import { runtime, startOcto } from "./octo/runtime.js";

void app.whenReady().then(async () => {
  await startOcto();
  // 继续宿主原有的窗口创建等流程。
}).catch(() => {
  console.error("Octo Runtime 启动失败，请检查本地配置和运行状态");
  app.quit();
});

let cleanupFinished = false;
app.on("before-quit", event => {
  if (cleanupFinished) return;
  event.preventDefault();
  // 等待 daemon、Host 和插件退出；清理失败也不能卡住宿主退出。
  void runtime.stop("quit").catch(() => {
    console.error("Octo Runtime 清理失败");
  }).finally(() => {
    cleanupFinished = true;
    app.quit();
  });
});
```

增加这些文件后，在宿主原有 main 构建和 Electron 启动前执行：

```bash
pnpm run build:octo:host
```

`startAccount()` 会启动 daemon 和 Host 子进程，无需 `daemon install/start`。Codex 执行前须安装并认证；OpenClaw Gateway 须已运行且可访问。

### 1.6 准备正式包资源

开发时要求 PATH 中有 Node.js 24+；正式包随应用携带固定 Node，资源放在 ASAR 外。保持以下路径与 `runtime.ts` 一致：

```text
resources/octo-runtime/
  package.json                    # 至少包含 {"type":"module"}
  adapter-host.js                  # dist/main/octo/adapter-host.js
  node/bin/node                   # Windows：node/node.exe
  node_modules/@mininglamp-oss/
    octo-runtime-daemon/dist/...
    octo-runtime-adapter-host/dist/...
    octo-runtime-adapter-codex/dist/...
    octo-runtime-adapter-openclaw/dist/...
    ...                           # 完整生产依赖；Gateway 场景还包含 Extra 包
```

宿主打包流程负责复制同次构建的完整依赖闭包，并保留可解析的 node_modules 布局；不能只复制入口文件或悬空的 pnpm 链接。宿主 main 中的 SDK 保留为外部依赖，独立 Host 入口单独编译，不并入 main bundle。参考 [Work App 打包脚本](../octo-work-app/scripts/prepare-embedded-runtime.mjs)和 [部署说明](DEPLOYMENTS.md)。更新程序时保留原 `runtimeHome`、身份和配置。

## 2. 为 Octo Runtime 配置特性

按实际需要选择下面的模块；不启用 IM 也能直接调用 Agent。

### 2.1 配置 OpenClaw 连接

```ts
// src/main/octo/openclaw.ts：仅使用 OpenClaw 时需要。
import { join } from "node:path";
import { accountKeyFor, profileNameFor } from "@mininglamp-oss/octo-runtime-daemon";
import { configureOpenClawConnection } from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import { appId, runtimeHome, subjectId, tenantId } from "./runtime.js";

export async function setOpenClawConnection(url: string, token: string) {
  // 定位当前 SDK 账号及租户的 profile，保留已有设备身份。
  const profileRoot = join(runtimeHome, "accounts",
    accountKeyFor("user", subjectId), profileNameFor(appId, tenantId));
  await configureOpenClawConnection(profileRoot, { url, token });
}
```

在主进程读取宿主保存的 Gateway URL 和 Token 后调用 `setOpenClawConnection(url, token)`，再使用 OpenClaw。不要把 OpenClaw Gateway Token 与 IM Bot 的 `bf_token` 混用；SDK 不自动读取 OpenClaw 的配置文件。多租户宿主需对实际执行使用的每个 profile 配置连接。

### 2.2 加载和重载 Extra

在宿主根目录的 `package.json` 的 `dependencies` 中加入所需模块的 `link:./octo-runtime/packages/<包目录>` 项，再在 Runtime 子仓安装、构建该模块及其依赖。Octo IM 使用 `@mininglamp-oss/octo-runtime-extra-channel-gateway`，完整依赖、文件格式及可直接使用的重载函数见 [Channel Gateway 指南](SDK_CHANNEL_GATEWAY_GUIDE.md#2-配置-packagejson-和构建)。

通用装配代码如下；先完成 `startOcto()`，再调用。保存由宿主自己的文件、SQLite 或配置平台完成。

```ts
// src/main/octo/features.ts
import type { ExtraDescriptor } from "@mininglamp-oss/octo-runtime-daemon";
import { runtime } from "./runtime.js";

export async function enableFeature(
  descriptor: ExtraDescriptor,
  persist: (value: ExtraDescriptor) => Promise<void>
) {
  await runtime.unloadExtra(descriptor.name);
  await persist(descriptor); // 宿主提供自己的保存函数，保存失败则不继续加载。
  if (descriptor.enabled === false) return runtime.extraStatus();
  return runtime.loadExtra(descriptor);
}
```

`descriptor.module` 使用已安装模块的绝对入口；`runtimeModule("octo-runtime-extra-channel-gateway")` 可解析本指南的开发及正式包路径。重载传入最新完整 config，卸载失败时停止操作；同插件连接会重建，其他插件和 Host 继续运行。Extra 配置来源及字段按模块 README 与 schema 处理。

## 3. 原生调用 Agent（可选）

只使用 IM 时跳过本节，Channel Gateway 会接收消息并调用 Agent。需要自己的本地对话 UI 时，在主进程调用实际 SDK 方法 `runtime.invoke()`；当前没有名为 `agentRequest()` 的 SDK 方法。

```ts
// src/main/octo/agent.ts
import { randomUUID } from "node:crypto";
import { runtime, tenantId } from "./runtime.js";

export async function requestAgent(text: string, workdir: string, signal: AbortSignal) {
  const runtimeId = runtime.health().profiles.find(p => p.tenantId === tenantId)?.runtimeId;
  if (!runtimeId) throw new Error("LOCAL_RUNTIME_UNAVAILABLE");
  const runId = "run_" + randomUUID();
  let terminal = false;
  for await (const event of runtime.invoke({
    inputs: [{ type: "text", text }],
    contexts: {
      schema: "octo.context-envelope/v3",
      items: [
        { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } },
        { namespace: "octo.execution", name: "workspace",
          payload: { mode: "fixed", path: workdir } },
        { namespace: "octo.security", name: "approval_policy",
          payload: { mode: "full_access" } }
      ]
    },
    runId,
    invocationId: "invoke_" + randomUUID(),
    runMetadata: { runtimeId },
    protocol_mode: "canonical"
  }, { signal })) {
    // 替换为宿主事件投递；不要把流关闭当作执行成功。
    console.log(event);
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) terminal = true;
  }
  if (!terminal) throw new Error("HOST_ENDED_WITHOUT_TERMINAL");
}
```

`workdir` 传已准备的绝对目录。上例显式全权限执行；需要审批 UI 时改为 `ask`，处理 `interaction.requested` 并调用 `respondRun()`。取消使用 signal 或 `cancelRun(runId)`。续聊保存事件中的真实 `providerSession`，下一轮传回；历史由宿主保存。

字段和更多行为直接读 [SDK 类型](packages/octo-runtime-daemon/src/runtime/types.ts)、[InvokeInput](.octospec/rules/invoke-input.md)、[Extra 合同](.octospec/rules/extras.md)、[OpenClaw 接口](packages/octo-runtime-adapter-openclaw/README.md)及 [参考宿主](../octo-work-app/src/main/daemon-runtime-service.ts)。
