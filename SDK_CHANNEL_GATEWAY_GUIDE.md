# SDK Channel Gateway 接入指南

**已有 Electron 项目，只需要接入 Octo IM，按本篇操作；建议 OctoBuddy 使用本篇。** 宿主只需管理配置、启动和重载，无需自行编写 Agent 请求或消息转发。桌面程序通过 SDK 启动，不执行 Runtime CLI。

## 1. 把代码加入宿主项目

以下从已有 Electron + TypeScript 项目开始，以 ESM、pnpm 11+ 和 Node.js 24+ 为例。宿主不需要新建或修改 `pnpm-workspace.yaml`，也不需要把 Runtime 的 packages 纳入宿主 workspace。依赖接入只需在宿主 `package.json` 中增加下文的 `link:` 声明；Runtime 子仓保留自己已有的 workspace 文件，独立安装和构建。保留宿主原有依赖、脚本和 Electron 版本。CommonJS 项目需将本节 Runtime 辅助文件单独编译为 ESM，不能直接修改整个项目的模块制式。

本篇源码接入方式要求宿主和 Runtime 子仓均使用 pnpm。宿主若当前使用 npm，须先完成包管理器迁移再按本篇接入；不能将下文命令直接替换为 `npm install`：npm 不支持这里的 `link:`，也不能解析子仓的 `workspace:*` 依赖。

```bash
# 在已有 Electron 项目（例如 OctoBuddy）的根目录执行
git submodule add -b feat/open-source-github https://github.com/Mininglamp-OSS/octo-runtime.git octo-runtime
git submodule update --init --recursive
```

当前开发接入使用 GitHub 仓库的 `feat/open-source-github` 分支。后续克隆宿主时使用 `git clone --recurse-submodules <宿主仓库地址>`。将 submodule 指针随宿主代码提交，固定集成版本；指定分支不会让后续检出自动跟随分支最新提交。

## 2. 配置 package.json 和构建

子仓位于宿主的 `octo-runtime/` 子目录。宿主通过 `link:./octo-runtime/packages/<包目录>` 引用具体包，路径相对于声明该依赖的 `package.json`，指向包含目标包 `package.json` 的目录。例如 core 包对应 `link:./octo-runtime/packages/octo-runtime-core`。

只需 Codex + OpenClaw + Octo IM 时，将这 5 项宿主直接依赖合并到宿主根目录的 `package.json`。这不是完整依赖清单；`adapter-sdk`、`protocol`、`core` 等公共包仍须在 Runtime 子仓中安装和构建，步骤见下文：

```json
{
  "type": "module",
  "dependencies": {
    "@mininglamp-oss/octo-runtime-daemon": "link:./octo-runtime/packages/octo-runtime-daemon",
    "@mininglamp-oss/octo-runtime-adapter-host": "link:./octo-runtime/packages/octo-runtime-adapter-host",
    "@mininglamp-oss/octo-runtime-adapter-codex": "link:./octo-runtime/packages/octo-runtime-adapter-codex",
    "@mininglamp-oss/octo-runtime-adapter-openclaw": "link:./octo-runtime/packages/octo-runtime-adapter-openclaw",
    "@mininglamp-oss/octo-runtime-extra-channel-gateway": "link:./octo-runtime/packages/octo-runtime-extra-channel-gateway"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.3"
  },
  "scripts": {
    "build:octo:deps": "pnpm --dir octo-runtime --filter @mininglamp-oss/octo-runtime-extra-channel-gateway... run build",
    "build:octo:host": "tsc -p tsconfig.octo.json"
  }
}
```

`daemon` 提供 SDK；`adapter-host` 承载执行；两个 Adapter 对应 Codex/OpenClaw；`extra-channel-gateway` 负责 Octo IM。内部包不独立发布到 npm，其 `package.json` 和内部 `workspace:*` 保持原样。

```bash
# 在宿主根目录执行：先安装、构建 Runtime，再安装宿主
pnpm --dir octo-runtime install --frozen-lockfile
pnpm run build:octo:deps
pnpm install
```

两次安装处理的是两个独立项目：

- `pnpm --dir octo-runtime install --frozen-lockfile` 读取子仓的 `pnpm-workspace.yaml` 和 lockfile，将内部 `workspace:*` 解析为子仓包，并安装它们的第三方依赖。这一步建立公共包的实际依赖链接，不能省略。
- `pnpm run build:octo:deps` 的筛选器末尾 `...` 表示同时构建 Channel Gateway 及其依赖闭包，包括 `adapter-sdk`、`protocol`、`core` 等公共包，按依赖顺序生成 `dist`。
- 宿主的 `pnpm install` 只为这 5 项 `link:` 建立符号链接，不会替目标包安装传递依赖。Node.js 默认按符号链接的真实路径解析模块，因此 OpenClaw 使用的是子仓已安装的公共包：

```text
宿主/node_modules/@mininglamp-oss/octo-runtime-adapter-openclaw
  → octo-runtime/packages/octo-runtime-adapter-openclaw
    → 该包/node_modules/@mininglamp-oss/octo-runtime-adapter-sdk
      → octo-runtime/packages/octo-runtime-adapter-sdk
        → 该包/node_modules/@mininglamp-oss/octo-runtime-protocol
          → octo-runtime/packages/octo-runtime-protocol
```

`workspace:*` 在子仓安装时由 pnpm 解析，Node.js 执行时沿已建立的链接加载编译产物。宿主代码如果直接 import 公共包，也必须将对应 `link:` 加入宿主直接依赖；例如直接使用 `adapter-sdk` 时增加 `"@mininglamp-oss/octo-runtime-adapter-sdk": "link:./octo-runtime/packages/octo-runtime-adapter-sdk"`。仅在宿主多列几项依赖，不能代替子仓安装。

上述解析依赖 Node.js 默认的真实路径行为，不要为这些入口启用 `--preserve-symlinks`；宿主构建工具也须保持相同解析方式。当前 daemon/Host 还依赖其他 Adapter，下面只注册两个并不裁剪安装依赖；正式包须携带完整生产依赖并保留可解析布局，不能只复制这 5 个目录或开发时的符号链接，见第 6 节。

其他机器或 CI 按相同子目录检出 submodule 后即可使用这些相对路径。运行时仍通过包名 import。

## 3. 准备 IM 配置

将下面内容保存为 Electron `app.getPath("userData")` 目录下的 `im.json`。替换 Bot ID、Token 和 Codex 绝对工作目录；两个 Bot 可同时启用，不需要哪一个就删除其整个对象。

```json
{
  "module": "@mininglamp-oss/octo-runtime-extra-channel-gateway",
  "config": {
    "bots": [
      {
        "api_url": "https://im.deepminer.com.cn/api",
        "bot_id": "<CODEX_BOT_ID>",
        "bot_name": "Codex 助理",
        "bf_token": "<CODEX_BF_TOKEN>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace"
        }
      },
      {
        "api_url": "https://im.deepminer.com.cn/api",
        "bot_id": "<OPENCLAW_BOT_ID>",
        "bot_name": "OpenClaw 助理",
        "bf_token": "<OPENCLAW_BF_TOKEN>",
        "adapter": {
          "adapter_type": "openclaw",
          "provider_agent_id": "main"
        }
      }
    ]
  }
}
```

`config.bots` 就是 Channel Gateway 的 IM 配置；SDK 接收该对象，不接收文件路径。这里的文件由宿主读取，换成 SQLite 或其他配置来源时仍传相同对象。

| 字段 | 填什么 |
| --- | --- |
| `api_url` | Octo IM 的 API 根地址；示例使用正式环境 |
| `bot_id` / `bf_token` | 对应 Octo Bot 的 ID 和 Token，两个 Bot 分别填写 |
| `adapter_type: codex` | 本机 Codex，执行前已安装并完成认证 |
| `adapter_type: openclaw` | 已运行的 OpenClaw Gateway；还需配置下一节的连接 |
| `provider_agent_id` | OpenClaw 已有 Agent ID，如 `main`，不是 Octo Bot ID |
| 顶层 `enabled: false` | 停用整个 IM 插件；Bot 内的 `enabled: false` 仅停用该 Bot |

不填写 `model` / `effort` 时使用引擎默认值。限制 Octo Space 时在 `config` 中增加 `authorized_space_ids`，填写认证应允许的真实 Space ID；不需要宿主额外限制时省略。完整字段见 [Gateway config-schema.json](packages/octo-runtime-extra-channel-gateway/config-schema.json)。

## 4. 在主进程启动 daemon 和 IM

### 4.1 创建独立 Host 入口

```ts
// src/main/octo/adapter-host.ts：只由独立 Host 子进程执行，main 不 import 此文件。
import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { openclawAdapter } from "@mininglamp-oss/octo-runtime-adapter-openclaw";

// 本产品只注册这两个 Adapter；新增框架支持不会自动加入。
serveAdapterHost([codexAdapter, openclawAdapter]);
```

宿主根目录增加 `tsconfig.octo.json`：

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

### 4.2 创建 SDK 实例

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

开发时 PATH 中须有 Node.js 24+。本地示例使用稳定的 `local-user/local`，不要求宿主先接 Octo 登录；已有账号体系时使用真实稳定 UID 和租户 ID，并保持原 Home。

### 4.3 读取和应用 IM 配置

```ts
// src/main/octo/im.ts
import { app } from "electron";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertStoredExtra } from "@mininglamp-oss/octo-runtime-daemon";
import { runtime, runtimeModule } from "./runtime.js";

export const imConfigFile = join(app.getPath("userData"), "im.json");
const gateway = "@mininglamp-oss/octo-runtime-extra-channel-gateway";
// 所有本插件的保存/重载串行处理，避免两个设置操作互相覆盖。
let pending: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

async function applyIm(value: unknown, persist: boolean) {
  assertStoredExtra(value);
  if (value.module !== gateway) throw new Error("IM_MODULE_INVALID");
  await runtime.unloadExtra("channel-gateway"); // 等待清理；失败则不继续保存和加载。
  if (persist) {
    await mkdir(dirname(imConfigFile), { recursive: true });
    const temporary = imConfigFile + ".tmp";
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, imConfigFile);
  }
  if (value.enabled !== false) {
    await runtime.loadExtra({
      name: "channel-gateway",
      module: runtimeModule("octo-runtime-extra-channel-gateway"),
      config: value.config
    });
  }
  const lifecycle = await runtime.extraStatus();
  const status = lifecycle["channel-gateway"]?.phase === "loaded"
    ? await runtime.extraStatus("channel-gateway")
    : undefined;
  return { lifecycle, status };
}

// 启动时或手动点击“重新加载”时，从宿主文件读取最新配置。
export function reloadIm() {
  return enqueue(async () => applyIm(JSON.parse(await readFile(imConfigFile, "utf8")), false));
}

// 设置页由可信主进程提交完整对象；保存后立即生效，无需重启 daemon。
export function saveImConfiguration(value: unknown) {
  return enqueue(() => applyIm(value, true));
}
```

读取失败、声明校验失败、卸载失败或加载失败都会向调用方抛错；保存成功后加载失败，文件仍保留本次完整配置，修正后可再次重载。Bot 认证失败可能表现为插件已加载、Bot 的 `state` 为 `failed`，须查看返回的插件状态。

### 4.4 启动与退出

```ts
// 合并进宿主已有的 Electron main 入口及退出流程。
import { app } from "electron";
import { runtime, startOcto } from "./octo/runtime.js";
import { reloadIm } from "./octo/im.js";

void app.whenReady().then(async () => {
  await startOcto();
  await reloadIm(); // 读取宿主 im.json，通过 SDK 加载 Channel Gateway。
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

宿主原有 main 构建和 Electron 启动前执行：

```bash
pnpm run build:octo:host
```

仅用 Codex 时至此完成。使用 OpenClaw 时，再加入下面的辅助文件，在读取宿主保存的 Gateway URL/Token 后调用 `setOpenClawConnection(url, token)`，然后再调用 `reloadIm()`：

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

OpenClaw Gateway 必须已运行；其连接 Token 与 IM 的 `bf_token` 不同。SDK 不自动读取 `~/.openclaw/openclaw.json`。如果宿主有多个执行 profile，分别配置实际使用的 profile。

## 5. 保存或重新加载 IM 配置

在主进程现有设置处理函数中调用 `saveImConfiguration(完整配置对象)`，等待返回后更新设置页。用户只修改了宿主文件、想重新应用时调用 `reloadIm()`。这是上一节已提供的两个函数，不是额外 SDK API。

操作顺序为 **卸载 channel-gateway → 保存最新完整配置 → 通过 SDK 加载**。同插件内的 Bot 连接一起重建，daemon 和共享 Host 不重启；保存时提交完整 bots 数组，缺席的 Bot 不保留。两个函数已串行执行，调用方仍须等待结果并显示失败。

返回的 `lifecycle` 是加载状态，`status` 是插件自己的 Bot 状态。只有 Bot 的 `state: "online"` / `connected: true` 才表示 IM 已连接；`loaded` 不能代替连接成功。真实消息执行还取决于 Codex 认证或 OpenClaw 连接是否可用。主进程自行解释状态，不向 renderer 回传 Token 或整份配置。

## 6. 打包到 Electron 正式程序

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

需要自己的本地对话 UI 时再看 [完整指南的可选 Agent 调用](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#3-原生调用-agent可选)。其他行为直接查 [Gateway README](packages/octo-runtime-extra-channel-gateway/README.md)、[SDK 类型](packages/octo-runtime-daemon/src/runtime/types.ts)和 [Extra 合同](.octospec/rules/extras.md)。
