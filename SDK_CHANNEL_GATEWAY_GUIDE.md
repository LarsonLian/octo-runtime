# SDK Channel Gateway 接入指南

**已有 Electron 项目，只需要接入 Octo IM，按本篇操作；建议 OctoBuddy 使用本篇。** 宿主只需管理配置、启动和重载，无需自行编写 Agent 请求或消息转发。桌面程序通过 SDK 启动，不执行 Runtime CLI。

以下从已有 Electron + TypeScript 项目开始，要求使用 pnpm 11+ 安装和构建，因为宿主采用独立的 pnpm workspace，将 `octo-runtime/` submodule 内所需的内部包统一纳入。采用预编译：先生成 Runtime 的 `dist`，再由宿主使用；预编译直接合入 App 原有的 `dev` / `build` 流程。示例使用 ESM 和 Node.js 24.x；保留宿主原有依赖、构建步骤和 Electron 版本。CommonJS 项目需将 Runtime 辅助文件单独编译为 ESM，不能直接修改整个项目的模块制式。

宿主若当前使用 npm，先完成包管理器迁移；以下安装、构建和 CI 命令均在宿主根目录通过 pnpm 执行。

前置准备：将 Runtime 作为 submodule 检出到宿主的 `octo-runtime/` 目录：

```bash
# 在已有 Electron 项目（例如 OctoBuddy）的根目录执行
git submodule add -b feat/open-source-github https://github.com/Mininglamp-OSS/octo-runtime.git octo-runtime
git submodule update --init --recursive
```

当前开发接入使用 GitHub 仓库的 `feat/open-source-github` 分支。后续克隆宿主时使用 `git clone --recurse-submodules <宿主仓库地址>`。将 submodule 指针随宿主代码提交，固定集成版本；指定分支不会让后续检出自动跟随分支最新提交。

本地信任边界：同一操作系统账号内、能够访问实例 IPC 的客户端互信；SDK 不额外区分 APP 身份，不要求 APP 注册或共享 Token。多个 Home 不提供同账号应用隔离。协议校验、执行权限、审批及 Extra 的外部业务授权仍按各自合同执行。参见[本地 IPC 架构约束](.octospec/rules/architecture.md#本地信任边界同一操作系统账号内互信)。

## 1. 配置 pnpm-workspace.yaml

在宿主根目录新建或合并 `pnpm-workspace.yaml`，保留宿主已有的 packages、allowBuilds 等配置，纳入 Runtime 内部包并用 `!` 排除当前 SDK 接入不需要的包：

```yaml
packages:
  - "octo-runtime/packages/*"
  - "!octo-runtime/packages/octo-runtime-cross-service"
  - "!octo-runtime/packages/octo-runtime-extra-channel-wecom"
  - "!octo-runtime/packages/octo-runtime-extra-webui"

allowBuilds:
  esbuild: true

sharedWorkspaceLockfile: true
```

该配置保留 Gateway、`adapter-sdk`、`protocol`、`core`、daemon/Host 及其 Adapter 依赖，排除以下三个不在本示例依赖闭包内的包：

| 排除包 | 本示例不需要的用途 |
| --- | --- |
| `octo-runtime-cross-service` | CLI 的系统服务安装、自启等管理能力；SDK 启动不引用它 |
| `octo-runtime-extra-channel-wecom` | 企业微信接入，本示例只接 Octo IM |
| `octo-runtime-extra-webui` | 本地 WebUI，本示例使用宿主自己的界面 |

普通 `pnpm install` 会安装所有 workspace 项目的依赖，仅不在宿主 dependencies 声明某包不能阻止其安装。排除项使这些包及其专用依赖不进入安装范围；宿主需要某项扩展时，再移除对应排除项、声明其直接依赖并合并所需 allowBuilds。排除依据是实际依赖关系，不能仅按包名或未启用的功能推断；当前 daemon/Host 仍依赖其他 Adapter，必须保留它们。

SDK 接入不需要把子仓根 CLI 包或 `octo-runtime/apps/*` 加入宿主 workspace。子仓原有 workspace 文件和 lockfile 保留，集成安装统一从宿主根目录执行，使用宿主 workspace 配置及 lockfile。

## 2. 添加 dependencies 并构建

只需 Codex + Octo IM 时，将以下内容合并到宿主根目录的 `package.json`。所有 Runtime 依赖统一使用 `workspace:*`：

```json
{
  "type": "module",
  "packageManager": "pnpm@11.19.0",
  "dependencies": {
    "@mininglamp-oss/octo-runtime-daemon": "workspace:*",
    "@mininglamp-oss/octo-runtime-adapter-host": "workspace:*",
    "@mininglamp-oss/octo-runtime-adapter-codex": "workspace:*",
    "@mininglamp-oss/octo-runtime-extra-channel-gateway": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^6.0.3"
  }
}
```

`daemon` 提供 SDK；`adapter-host` 承载执行；Codex Adapter 对接本机 Codex；`extra-channel-gateway` 负责 Octo IM。内部包不独立发布到 npm，其 `package.json` 和内部 `workspace:*` 保持原样。

```bash
# 在宿主根目录执行，统一安装宿主和 Runtime 的依赖
pnpm install
# 调用 Runtime 包已有的 build，无需新增宿主 script
pnpm --filter @mininglamp-oss/octo-runtime-extra-channel-gateway... run build
```

`pnpm install` 自动链接同一 workspace 中的内部依赖，例如 `Codex → adapter-sdk → protocol`，并安装第三方依赖。上述 4 项是宿主直接使用的包，公共包不需要重复列到宿主；宿主代码直接 import 某个公共包时，再将它以 `workspace:*` 加入宿主直接依赖。

构建筛选器末尾 `...` 表示同时按依赖顺序构建 Gateway 及其完整依赖闭包。安装建立依赖链接，构建生成包入口所需的 `dist`；完成后即可按包名 import，无需手动配置路径别名或额外链接脚本。

日常开发将预编译直接合入 App 原有的 `dev` / `build` 命令。以下以 electron-vite 为例，包含第 4 节独立 Host 入口的编译：

```json
{
  "scripts": {
    "dev": "pnpm --filter @mininglamp-oss/octo-runtime-extra-channel-gateway... run build && pnpm exec tsc -p tsconfig.octo.json && electron-vite dev",
    "build": "pnpm --filter @mininglamp-oss/octo-runtime-extra-channel-gateway... run build && pnpm exec tsc -p tsconfig.octo.json && electron-vite build"
  }
}
```

将示例中的 `electron-vite dev` / `electron-vite build` 换成宿主原有的完整命令，保留已有类型检查、环境配置和打包步骤；若原流程已编译 `tsconfig.octo.json`，无需重复该步骤。完成第 4 节的文件后，照常执行 `pnpm dev` 或 `pnpm build`，预编译失败时不会继续启动或构建 App。无需配置安装时的 `prepare`，也无需额外的 Runtime 构建脚本文件。

启动开发前预编译一次 Runtime，随后由原有 App 开发服务处理 App 源码变化；开发期间修改 Runtime 源码时需重新执行 `pnpm dev`，不会自动监听 Runtime 源码重新编译。过滤构建不包含上述三个排除包，但构建过滤不能代替第 1 节的安装范围排除。

将宿主生成的 `pnpm-lock.yaml` 随宿主代码及 submodule 指针一起提交。后续机器或 CI 先检出 submodule，再在宿主根目录执行 `pnpm install --frozen-lockfile` 和已合并预编译的 `pnpm build`，无需再单独执行过滤构建；更新 submodule 后重新安装、构建，并提交宿主 lockfile 的实际变化。

当前 daemon/Host 还依赖其他 Adapter，下面只注册 Codex 并不裁剪安装依赖。正式包须携带完整生产依赖并保留可解析布局，见第 6 节。

## 3. 准备 IM 配置

通过宿主自己的方式取得 JSON 配置数据：可以从 SQLite 查询、读取本地 JSON 文件，也可以实时生成。配置来源、读取和持久化由宿主决定；SDK 接收的是已经取得的配置对象，不要求固定文件名或存放路径。对象格式如下，替换 Bot ID、Token、工作目录和模型 ID：

**`config.bots` 是数组：一个 Bot 填一项，多个 Bot 填多项。** 下例配置两个 Bot；只接一个时保留一项即可，每项填写对应 Bot 的凭据和执行配置。

`config.bots[i].context` 是加载 Gateway 时传入的静态 Context，可以省略。需要每轮取得宿主最新提示词或业务材料时，由宿主提供 `loadContexts` 函数；SDK 已提供函数装配，使用方式和本地验证范围见第 7 节。函数不写入 JSON。

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
          "workdir": "/absolute/workspace",
          "model": "<CODEX_MODEL_ID>",
          "effort": "high"
        },
        "context": {
          "schema": "octo.context-envelope/v3",
          "items": [
            {
              "namespace": "octo.control",
              "name": "instructions",
              "payload": {
                "entries": [
                  {
                    "text": "我是明略科技的Octo助理"
                  }
                ]
              }
            }
          ]
        }
      },
      {
        "api_url": "https://im.deepminer.com.cn/api",
        "bot_id": "<CODEX_BOT_ID_2>",
        "bot_name": "Codex 助理 2",
        "bf_token": "<CODEX_BF_TOKEN_2>",
        "adapter": {
          "adapter_type": "codex",
          "workdir": "/absolute/workspace-2",
          "model": "<CODEX_MODEL_ID>",
          "effort": "high"
        },
        "context": {
          "schema": "octo.context-envelope/v3",
          "items": [
            {
              "namespace": "octo.control",
              "name": "instructions",
              "payload": {
                "entries": [
                  {
                    "text": "我是明略科技的Octo助理"
                  }
                ]
              }
            }
          ]
        }
      }
    ]
  }
}
```

`config.bots` 就是 Channel Gateway 的 IM 配置。宿主将上面的完整对象交给下文的配置辅助函数，由辅助函数把 `config` 对象传给 SDK；配置来源变化时，传入的对象格式保持一致。

**配置生效方式：`channel-gateway` 是 Runtime 的 Extra 插件。桌面宿主已启动 Runtime 后，新增、修改或删除 Bot，需卸载并重新加载这个 Extra；仅保存配置不会自动生效。daemon 和 AdapterHost 执行内核无需重启，其他 Extra 无需重载。** 重载会重建该插件内所有 Bot 的连接；每次传入完整 `bots` 数组，未列出的 Bot 不保留。具体顺序见[保存或重新加载 IM 配置](#5-保存或重新加载-im-配置)。

这里的重载针对传入的 JSON 配置快照。若已通过函数依赖接入 `loadContexts`，仅更新该函数读取的宿主提示词或业务数据，下一轮即可重新取得，无需重载；该能力与当前 SDK 的接线限制见[第 7 节](#7-逐轮加载-agent-系统提示词与业务-context)。

| 字段 | 填什么 |
| --- | --- |
| `api_url` | Octo IM 的 API 根地址；示例使用正式环境 |
| `bot_id` / `bf_token` | 对应 Octo Bot 的 ID 和 Token |
| `adapter_type: codex` | 本机 Codex，执行前已安装并完成认证 |
| `adapter.model` | 可选，填写当前 Codex 可用的模型 ID；示例占位符需替换或删除该字段 |
| `adapter.effort` | 可选，思考强度为 `low` / `medium` / `high` / `xhigh`；示例为 `high` |
| `context` | 可选，该 Bot 的 Context v3 配置；系统提示词使用 `octo.control/instructions`，见下节 |
| 顶层 `enabled: false` | 停用整个 IM 插件；Bot 内的 `enabled: false` 仅停用该 Bot |

**模型 `adapter.model` 和思考强度 `adapter.effort` 都是可选配置；未填写的项采用 Codex 默认配置。需要默认值时直接省略对应字段，不要传空字符串。本示例不指定固定的默认模型或思考强度。**

限制 Octo Space 时在 `config` 中增加 `authorized_space_ids`，填写认证应允许的真实 Space ID；不需要宿主额外限制时省略。完整字段见 [Gateway config-schema.json](packages/octo-runtime-extra-channel-gateway/config-schema.json)。

### 3.1 配置 Agent 的 IM 系统提示词

给 Agent 开通 IM 通道时，宿主在配置该 Bot 时确定专用系统提示词，并通过 octo-contexts 的 `octo.context-envelope/v3` 协议写入 **`config.bots[i].context`**。上面的完整 JSON 已给出配置位置：item 使用 `namespace: "octo.control"`、`name: "instructions"`，提示词正文放在 `payload.entries[].text`；每个条目只保留 `text`，不填写 `source`。

每个 Bot 分别配置自己的提示词；没有提示词时省略该 item。将包含 `context` 的完整配置对象按第 4、5 节加载即可，配置的指令会随每轮调用传递，无需宿主自行拼接到 IM 消息正文。

这份静态 Context 在 Extra 加载时成为配置快照，并非每轮重新读宿主数据库。Agent 提示词经常变化时，采用[第 7 节的宿主动态加载设计](#7-逐轮加载-agent-系统提示词与业务-context)。系统指令进入新 Provider 会话的时机与普通业务 Context 不同，不能仅凭每轮提交就认定已有会话已经应用新 system 指令，具体边界见第 7.6 节。

参考 [Work App 的 imChannelBotConfig](../octo-work-app/src/main/im-channel-service.ts)：它将通道设置中保存的 `channel.instructions` 转成上述 item，空白提示词不生成 item，再与该 Bot 的连接和 Adapter 配置一起交给 Gateway。这里的提示词来自宿主授权的 Agent 配置入口，IM 消息正文不能冒充该来源；协议说明见 [Context 输入合同](.octospec/rules/context-input.md)。

### 3.2 群与话题准入

宿主在 config.bots[i] 中配置 groups_enabled 和 group_ids；SDK 只负责装配，Channel 解释和校验这些字段。CLI 与 SDK 使用同一合同：

| 字段和值 | 群/话题效果 | 私聊效果 |
| --- | --- | --- |
| groups_enabled 省略或 true | 开启入口，继续检查范围、授权和真实 @ | 不受此字段影响 |
| groups_enabled: false | 关闭所有群/话题，优先于范围名单 | 不受此字段影响 |
| group_ids 省略、null 或 [] | 不增加群范围限制 | 不受此字段影响 |
| group_ids: ["G1"] | 只允许父群 G1 及其话题继续检查其他条件 | 不受此字段影响 |

例如默认 owner 在 G1 中 @Bot，默认配置、null 和 [] 均可处理；名单为 ["G2"] 或 groups_enabled: false 时拒绝。话题 G1____T1 按 G1 校验，回复留在 G1____T1。groups_enabled 的 null 或非布尔值非法；group_ids 的错误类型和空 ID 非法。不保留旧空数组禁用群的兼容行为，需要禁用时明确使用 false。

以上只定义群范围，不放开发送者：allowed_sender_ids 省略仍仅允许服务端认证所得 owner，显式名单替代 owner，[] 拒绝所有发送者，null 非法。真实 @、Space 和拒绝自身消息的检查继续生效。宿主不需要处理 Gateway 内部权限对象，亦不要在 SDK、AdapterHost 或 loadContexts 中补救准入；详见[架构合同](.octospec/rules/channel-integration.md#本轮输入)与[事故计划](.octospec/tasks/channel-group-admission/plan.md)。

## 4. 在主进程启动 daemon 和 IM

### 4.1 创建独立 Host 入口

```ts
// src/main/octo/adapter-host.ts：只由独立 Host 子进程执行，main 不 import 此文件。
import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";

// 本示例只注册 Codex；新增框架支持不会自动加入。
serveAdapterHost([codexAdapter]);
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

开发时 PATH 中须有 Node.js 24.x。本地示例使用稳定的 `local-user/local`，不要求宿主先接 Octo 登录；已有账号体系时使用真实稳定 UID 和租户 ID，并保持原 Home。

### 4.3 应用宿主取得的 IM 配置对象

```ts
// src/main/octo/im.ts
import { assertStoredExtra, type StoredExtra } from "@mininglamp-oss/octo-runtime-daemon";
import { runtime, runtimeModule } from "./runtime.js";

const gateway = "@mininglamp-oss/octo-runtime-extra-channel-gateway";
// 宿主按自己的存储方式保存完整对象；实时生成且无需保存时不提供此回调。
type PersistImConfiguration = (value: StoredExtra) => Promise<void>;
// 所有本插件的保存/重载串行处理，避免两个设置操作互相覆盖。
let pending: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

async function applyIm(value: unknown, persist?: PersistImConfiguration) {
  assertStoredExtra(value);
  if (value.module !== gateway) throw new Error("IM_MODULE_INVALID");
  await runtime.unloadExtra("channel-gateway"); // 等待清理；失败则不继续保存和加载。
  if (persist) {
    await persist(value);
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

// 启动或重新加载：宿主先取得最新完整对象，再传入；不在这里读取配置来源。
export function reloadIm(value: unknown) {
  return enqueue(() => applyIm(value));
}

// 设置页由可信主进程提交完整对象及宿主保存函数；保存后立即生效。
export function saveImConfiguration(value: unknown, persist: PersistImConfiguration) {
  return enqueue(() => applyIm(value, persist));
}
```

宿主在调用前处理自己的配置获取失败；辅助函数会向调用方抛出声明校验、卸载、保存或加载错误。保存成功后加载失败，宿主已保存的完整配置不回滚，修正后可再次重载。Bot 认证失败可能表现为插件已加载、Bot 的 `state` 为 `failed`，须查看返回的插件状态。

### 4.4 启动与退出

```ts
// 合并进宿主已有的 Electron main 入口及退出流程。
import { app } from "electron";
import { runtime, startOcto } from "./octo/runtime.js";
import { reloadIm } from "./octo/im.js";

// 宿主从自己的配置流程取得对象后，调用并等待此函数。
export async function startOctoWithIm(imConfiguration: unknown) {
  await app.whenReady();
  await startOcto();
  await reloadIm(imConfiguration); // 配置对象与第 3 节格式相同。
}

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

宿主在自己的启动流程中取得第 3 节格式的 `imConfiguration`，再调用并等待 `startOctoWithIm(imConfiguration)`，随后继续原有窗口创建等流程。配置获取或启动失败由宿主原有错误处理流程接住，不把 Token 或完整配置写入日志。这里的 `runtimeHome` 用于 Runtime 自身状态，与 IM 业务配置的来源无关。

宿主原有 main 构建和 Electron 启动前执行：

```bash
pnpm exec tsc -p tsconfig.octo.json
```

## 5. 保存或重新加载 IM 配置

宿主已取得配置对象、只需应用时调用 `reloadIm(完整配置对象)`。需要保存设置并立即生效时，在主进程现有设置处理函数中调用 `saveImConfiguration(完整配置对象, 宿主保存函数)`，保存函数接收完整对象并返回 Promise，可以写 SQLite、本地文件或宿主已有配置服务。实时生成且无需持久化的配置直接调用 `reloadIm`。这是上一节提供的两个宿主辅助函数，不是额外 SDK API。

上述辅助函数按以下顺序执行：

1. `await runtime.unloadExtra("channel-gateway")`，等待插件连接、订阅等资源清理成功；失败时不继续保存和加载。
2. 调用宿主保存函数，保存最新完整配置；只重新应用时省略此步。
3. `await runtime.loadExtra({ name: "channel-gateway", module: runtimeModule("octo-runtime-extra-channel-gateway"), config: value.config })`，传入最新完整 `bots` 数组；若顶层 `enabled: false`，则保持卸载状态。

**只重载整个 `channel-gateway` Extra，不重启 daemon 或 AdapterHost 执行内核。** 同插件内的所有 Bot 连接一起重建，未列入新数组的 Bot 不保留。两个辅助函数已串行执行，调用方仍须等待结果并显示失败。

返回的 `lifecycle` 是加载状态，`status` 是插件自己的 Bot 状态。只有 Bot 的 `state: "online"` / `connected: true` 才表示 IM 已连接；`loaded` 不能代替连接成功。真实消息执行还取决于 Codex 认证是否可用。主进程自行解释状态，不向 renderer 回传 Token 或整份配置。

## 6. 打包到 Electron 正式程序

开发时要求 PATH 中有 Node.js 24.x；正式包随应用携带固定 Node，资源放在 ASAR 外。保持以下路径与 `runtime.ts` 一致：

```text
resources/octo-runtime/
  package.json                    # 至少包含 {"type":"module"}
  adapter-host.js                  # dist/main/octo/adapter-host.js
  node/bin/node                   # Windows：node/node.exe
  node_modules/@mininglamp-oss/
    octo-runtime-daemon/dist/...
    octo-runtime-adapter-host/dist/...
    octo-runtime-adapter-codex/dist/...
    octo-runtime-extra-channel-gateway/dist/...
    ...                           # 完整生产依赖，包含 daemon/Host 传递依赖的其他 Adapter
```

宿主打包流程负责复制同次构建的完整依赖闭包，并保留可解析的 node_modules 布局；不能只复制入口文件或悬空的 pnpm 链接。宿主 main 中的 SDK 保留为外部依赖，独立 Host 入口单独编译，不并入 main bundle。参考 [Work App 打包脚本](../octo-work-app/scripts/prepare-embedded-runtime.mjs)和 [部署说明](DEPLOYMENTS.md)。更新程序时保留原 `runtimeHome`、身份和配置。

需要自己的本地对话 UI 时再看 [完整指南的可选 Agent 调用](SDK_NATIVE_INTEGRATION_FULL_GUIDE.md#3-原生调用-agent可选)。其他行为直接查 [Gateway README](packages/octo-runtime-extra-channel-gateway/README.md)、[SDK 类型](packages/octo-runtime-daemon/src/runtime/types.ts)和 [Extra 合同](.octospec/rules/extras.md)。

## 7. 逐轮加载 Agent 系统提示词与业务 Context

### 7.1 使用场景与实现状态

SDK 同进程函数装配已完成本地实现和自动化，见[独立专项](.octospec/tasks/sdk-host-extra-contexts/brief.md)。SDK 完成内部 loader、执行端口及完整生命周期，宿主仅调用通用 loadExtra 并提供 JSON 和业务函数。第三方 App 和真实 IM 接入本轮暂不进行；下文不是这些产品已通过验收的声明。

复杂 HostApp 通常自行管理 Agent 定义：用户编辑系统提示词、项目说明或业务规则后，下一次 IM 任务应读取更新后的值。仅在启动时将这些值放入 `config.bots[i].context`，运行实例仍持有旧快照；每次编辑都重载 Gateway 会重建它管理的连接。

因此两阶段 Extra 支持在初始化时独立注入 `loadContexts` 函数。函数由宿主实现，Channel 每轮调用；宿主保存新数据后，无需重启或重载 Channel Gateway。插件仍以整个 Extra 为封装和生命周期单位，不向宿主开放内部 Bot、manager、连接或队列。完整架构与合同见 [Octospec 专题](.octospec/guides/channel-dynamic-contexts.md)。

**当前可用范围须分清：**

| 入口 | 当前状态 |
| --- | --- |
| `ExtraPlugins.load(module, jsonConfig, { loadContexts })` | 已实现的同进程代码装配接口 |
| Gateway/WeCom 的每轮调用与静态动态合并 | 已实现；未提供函数时使用静态配置 |
| 第 4、5 节 `createDaemonRuntime` / `runtime.loadExtra(descriptor)` | 当前只接收 JSON descriptor，在 runner 子进程加载 Extra，不能直接传闭包 |
| runtime.loadExtra(module, config, dependencies) | 已实现；Extra 与函数在宿主 Node 主进程，执行复用原 daemon 与独立 Host |

本节提供宿主业务函数示例和完整 SDK 流程。第 4.3 节的 `runtime.loadExtra(descriptor)` 继续只接收 JSON；注入函数使用三参数重载，不把函数、函数源码或函数名写入 descriptor/config。

### 7.2 宿主提供什么函数

**普通函数和 async 函数都支持。** 返回类型是 `readonly ContextItem[] | Promise<readonly ContextItem[]>`，由宿主按自己的数据源选择：

| 数据源 | 宿主实现方式 | 注意事项 |
| --- | --- | --- |
| 内存中的当前 Agent 配置 | 普通函数直接返回数组 | 每次读当前值，不在初始化时永久捕获旧结果 |
| 同步 SQLite 驱动 | 普通函数查询后返回数组 | 查询占用宿主线程；async 包装不会消除同步阻塞 |
| 异步 SQLite 驱动或宿主数据库服务 | async 查询后返回数组，或直接返回 Promise | 保留宿主自己的连接和授权；按驱动实际能力取消查询 |
| HTTP 等异步 IO | async 读取并构造本轮 item | 将 signal 传给支持取消的 IO，传播真实失败 |

这种设计让宿主保留 SQLite/文件/远端服务的管理权，同时使 Channel 每轮取得最新业务数据，无需重载其连接。`extra(ctx, config)` 返回 initializer 是装配阶段；initializer 接收 loadContexts 等函数依赖，每次加载执行一次。loadContexts 则由 Channel 每轮调用，两者不能混为“初始化时读一次”。整体理由见[架构约定](.octospec/rules/architecture.md#宿主函数注入与逐轮业务数据读取)。

业务函数类型从 workspace 的 daemon 包导入，ContextItem 从 protocol 包导入。本节直接引用协议包，宿主还需在第 2 节的 dependencies 中增加 `"@mininglamp-oss/octo-runtime-protocol": "workspace:*"`；它已包含在 Gateway 的预编译依赖闭包中。

```ts
import type {
  JsonObject,
  LoadContexts
} from "@mininglamp-oss/octo-runtime-daemon";
import type { ContextItem } from "@mininglamp-oss/octo-runtime-protocol";

// 宿主自己的业务读取接口，允许同步内存读取，也允许异步存储/HTTP IO。
type ReadAgentContexts = (
  botConfig: JsonObject,
  options: { readonly signal: AbortSignal }
) => readonly ContextItem[] | Promise<readonly ContextItem[]>;

export function createAgentContextLoader(readCurrent: ReadAgentContexts): LoadContexts {
  return async (botConfig, { signal }) => {
    signal.throwIfAborted();
    // readCurrent 每次查询当前版本；不能在创建此函数时只读一次并永久捕获旧结果。
    const current = await readCurrent(botConfig, { signal });
    signal.throwIfAborted();
    return current;
  };
}
```

`ReadAgentContexts` 是本示例定义的宿主函数类型，不是另一项 Runtime API。业务团队实现 `readCurrent`：在宿主已有的账号/租户授权范围内，根据 Bot 与 Agent 的映射读取提示词并构造 item。框架提供的第一参数是**当前单个 Bot 的完整 JSON 配置副本**，不是整个 `bots` 数组，也不提供本轮消息或 session。多环境/多租户的查找不能只靠裸 `bot_id`；配置可能含凭据，不记录整个参数。

读取内存时，也可直接提供同步函数，例如以下宿主业务类：

```ts
import type { LoadContexts } from "@mininglamp-oss/octo-runtime-daemon";
import type { ContextItem } from "@mininglamp-oss/octo-runtime-protocol";

export class CurrentAgentContexts {
  #current: readonly ContextItem[] = [];

  // 一个实例对应一个已确定业务作用域的 Agent；仅保留当前版本，不累计旧版本。
  replace(items: readonly ContextItem[]): void {
    this.#current = structuredClone(items);
  }

  readonly loadContexts: LoadContexts = (_botConfig, { signal }) => {
    signal.throwIfAborted();
    return this.#current;
  };
}
```

该类只是宿主内存存储示意，不是 Extra 对象。多 Bot 时由宿主按配置映射到各自当前值。更新时调用宿主自己的 `replace`，Extra 下次调用同一个函数就读取新值；不是重新调用 initializer。读取 HTTP/数据库时使用上一例的 async 形式，将 `signal` 传到底层 IO，并在宿主完成返回值校验和授权；不要捕获错误后返回旧缓存或 `[]`，把真实读取失败伪装成成功。

### 7.3 宿主完整流程与 SDK 调用

三参数 loadExtra 已实现，下面展示用法；静态 JSON 接入继续按第 4、5 节使用。宿主接入函数时只需多提供 `loadContexts`，内部加载器、执行端口、取消和清理由 SDK 完成。本地单测已覆盖该流程，第三方 App 与真实 IM 待后续接入。

```ts
import * as gatewayModule from "@mininglamp-oss/octo-runtime-extra-channel-gateway";

// runtime 已按第 4 节创建并 startAccount；jsonConfig 为第 3 节的 config 对象。
// agentContexts 是宿主自己的数据读取对象，例如第 7.2 节 CurrentAgentContexts。
await runtime.loadExtra(gatewayModule, jsonConfig, {
  loadContexts: agentContexts.loadContexts
});

const status = await runtime.extraStatus("channel-gateway");

// 应用退出时等待 SDK 清理；插件内部资源不由宿主逐项操作。
await runtime.stop("quit");
```

| 阶段 | Buddy / 自研 Node CLI 宿主的操作 | 运行结果 |
| --- | --- | --- |
| 准备与启动 | 沿第 1–4 节安装、构建，创建 runtime 并 startAccount | 原有 daemon 与独立 AdapterHost 就绪 |
| 加载 | 传入模块、JSON config 和业务函数 | SDK 装配完整 Extra，宿主不创建 loader 或模型执行桥 |
| 修改业务数据 | 更新第 7.2 节函数读取的内存、文件或数据库当前值 | 下一任务调用同一函数读取最新数据，无需重载连接 |
| 查询状态 | extraStatus/health | 取得公开生命周期和业务状态；初始化完成不等于每个 Bot 在线 |
| 更换配置或函数引用 | await unloadExtra 后重新 loadExtra 完整新值 | 只重载整个 Gateway，复用共享独立 Host；卸载失败先处理错误，不强行替换 |
| 退出或切账号 | await stop；新账号启动后重新提交自己的配置和函数 | SDK 清理旧实例、所属调用和旧函数引用，宿主不逐 Bot 清理 |

这些步骤适用于调用 SDK 的 Buddy 和自研 Node CLI。自带 `octo-runtime` CLI 保持现有纯 JSON 装配，使用静态 Context；它不从 JSON 读取函数。函数方式运行在宿主 Node 主进程，Provider 和 AdapterHost 保持原执行链，宿主无需直接处理 invocationId/runId 转换。

同一 Gateway 只通过一种入口加载，不同时再提交同名 JSON descriptor。不要在每条消息时重新 load；业务数据更新与 JSON/函数引用替换的区别见上表。动态读到系统指令也不等于旧 Provider 会话立即更换 system，继续按第 7.6 节的会话边界处理。

本次接线与验收见[宿主完整 SDK 接入计划](.octospec/tasks/sdk-host-extra-contexts/brief.md)。[内部实现附录](.octospec/tasks/sdk-host-extra-contexts/flows.md)仅供 SDK 实现者阅读，不能要求接入方照着创建 ExtraPlugins、执行端口或插件内部对象。

### 7.4 静态与动态的覆盖规则

每个新逻辑轮从 `config.bots[i].context.items` 重新取得静态基线，再合并本轮函数返回的数组。按 `(namespace, name)` 匹配，**动态整项替换静态项**：

| 情况 | 最终配置项 |
| --- | --- |
| 静态 `[A, B]`，动态 `[B2, C]`，B 与 B2 同 key | `[A, B2, C]`；被替换位置不变，新 key 按动态顺序追加 |
| 动态与静态同 key | 整项替换；不深合并 payload，不拼接 entries，不补旧 guidance |
| 动态返回 `[]` 或未注入回调 | 保留静态项；空数组不是删除命令 |
| 上一轮返回动态项，下一轮不再返回 | 下一轮仅按静态基线与本轮结果重算，不沿用上轮动态值 |
| 任一来源内部重复 key，或输出非法/超预算 | 本轮准备失败，不调用 Provider |

例如，静态 `octo.control/instructions` 含 `[{ "text": "我是明略科技的Octo助理" }]`，动态也返回 instructions，则动态必须给出完整最终列表：

```json
[
  {
    "namespace": "octo.control",
    "name": "instructions",
    "payload": {
      "entries": [
        { "text": "我是明略科技的Octo助理" },
        { "text": "回答前先核对宿主提供的项目规则。" }
      ]
    }
  }
]
```

回调返回的是 item 数组，不是 envelope。instructions 的 entries 是仅含 `text` 的列表，不加 `source`。若动态只返回第二条指令，静态固定人设也会被替换，框架不会偷偷补回。希望保留静态人设、仅逐轮提供项目背景时，动态返回自己的 `extra.<domain>/<name>` 普通业务项即可。

### 7.5 什么时候读取，失败与内存如何处理

函数在通过消息准入、队列接纳后，任务真正开始准备时调用一次；不是 socket 每收到一条报文就调用。加载完成后再组织渠道材料和提交模型。本轮在途数据不随宿主后续编辑而追写；Provider 自动重试复用该轮快照，新任务再读取。控制命令不调用这个函数。

可在 Gateway 的顶层 config 中设置以下普通 JSON；它与 `bots` 同级，不放在单个 Bot 下：

```json
{
  "context_loading": {
    "timeout_ms": 5000,
    "max_in_flight": 8
  }
}
```

这只是配置片段。默认值即上例；范围分别为 1..30000 ms 和 1..32，额度由整个 Extra 的所有 Bot 共用。超时、取消、抛错或拒绝导致本轮准备失败，不用上轮值兜底；满额直接失败，不建立新的回调等待队列。超时 Promise 只要实际没结束就继续占额，迟到结果被忽略；卸载取消并等待清理，失败阻止同名重载。

动态结果及最终 envelope 受 Context v3 的 32 项/65,536 字节预算约束，需给渠道材料留出预算。框架只保留本轮与已有有界重试快照，不累计动态历史。宿主须让 IO 响应 signal，避免无限缓存或闭包保留历史大对象；同进程函数可以自行分配内存，函数式接口本身不能保证任意业务实现都不会 OOM。

### 7.6 系统提示词的 Provider 会话边界

逐轮加载保证**本轮请求取得最新 Context**。普通业务 Context 按当轮材料交给模型；`octo.control/instructions` 则走可信控制通道，当前按 Provider 新会话初始化合同应用，正常续聊不重复注入。更新宿主提示词不等于已有 Provider 会话已接受新 system 指令，Channel 不因此自动 reset。

产品要求新系统指令实际生效时，由业务方显式新建/reset Provider 会话，再让下一轮读取新指令；这不要求重载 Gateway 或重启 daemon。会话内替换 system 的支持范围须逐 Provider 核实，不能把动态取值成功当作原生 Provider 应用成功。实际合同见 [Context 输入规则](.octospec/rules/context-input.md#系统指令的会话时机与协议变更)。

### 7.7 群与话题续聊的历史缺口

同一Provider session不表示模型看过未 @ 它的讨论。Gateway只观察授权群/话题的位置，不因普通讨论执行任务或新增本地聊天库；再次被 @ 时，模型前固定输入准备直接调用现有TypeScript API层的`getChannelMessagePage`，将正文放入`extra.im/history`，将加载状态放入`extra.im/history-gap`。不委托模型调用CLI，不分类“总结”等关键词，独立问题也遵循相同的有缺口才补取策略。Host和Adapter仍只消费本轮快照。

未知基线与冷启动共用最近最多15条的上限，已知缺口为min(15,跨度)；本轮冷/续聊合并为最多一次sync API、10秒、1 MiB响应，禁用429自动重试和分页，代码再按冻结范围过滤、去重并截至15条/1500 Unicode码点。较早记录、非文本或截断使材料不全时明确标注；失败不换身份或频道、不自动启动CLI补救，不阻断当前任务。材料被最终预算移除时改为omitted，不声称已提供；失败或省略保留待补边界。reset、重启及淘汰不恢复旧游标，同代次重试不重新采集；自定义session store未实现可选原子metadata patch时只能按unknown处理。模型额外业务工具调用仍使用宿主提供的octo-cli，与此流程无关。当前本地实现及尚未完成的线上验收见[实施记录](.octospec/tasks/channel-context-gap/implementation.md)。

## 8. 宿主会话存储与重载恢复

Gateway 的函数式入口支持可选 `GatewayDependencies.createSessionStore`。它解决 SDK 宿主已拥有 SQLite 等存储、但 Extra 实际仍使用默认 Memory 的装配缺口。未提供工厂时继续使用原有有界内存存储；自带 CLI 的 JSON 装配不读取函数，也不会自动开启持久化。WeCom 不使用此 Gateway 专属接口。

### 8.1 公开接口与装配

单一 npm 发行包提供 `@mininglamp-oss/octo-runtime/extras/channel-gateway` 函数式模块入口；依赖类型可从该入口或 `/extra` 取得。源码 workspace/submodule 接入仍可从 `@mininglamp-oss/octo-runtime-extra-channel-gateway` 根入口导入相同模块与类型。宿主固定包含本次改动的发行版本后再验收；文档不代表该版本已发布。

```ts
import * as gatewayModule from "@mininglamp-oss/octo-runtime/extras/channel-gateway";
import type {
  GatewayDependencies,
  ImSessionStore,
  JsonObject
} from "@mininglamp-oss/octo-runtime/extra";

// 这是宿主现有存储服务的适配接口，不是 Runtime 提供的 SQLite 驱动。
// 实现负责按已授权账号、组织、助理、Bot 和 API 环境分区，并返回独立句柄。
interface HostSessionStorage {
  openBotHandle(config: JsonObject): ImSessionStore;
}

declare const hostSessions: HostSessionStorage;
// runtime 已按第 4 节创建并 startAccount；jsonConfig 是完整 Gateway config。
// agentContexts 为第 7 节宿主自己的逐轮 Context 读取对象。
const dependencies: GatewayDependencies = {
  loadContexts: agentContexts.loadContexts,
  createSessionStore(botConfig) {
    // 参数是一个已校验 Bot 的独立 JSON 副本，保留宿主自有 scope 扩展字段。
    // 必须与宿主当前账号和已保存的 Bot→助理关系核对；不要只用裸 bot_id 分库。
    // 不记录完整配置，因为其中可能包含 bf_token；不从消息正文/路由选择存储 scope。
    return hostSessions.openBotHandle(botConfig);
  }
};

await runtime.loadExtra(gatewayModule, jsonConfig, dependencies);
const status = await runtime.extraStatus("channel-gateway");
// 宿主检查 status.bots/errors；Extra loaded 仅表示初始化完成，不代表所有 Bot 可用。

// 重载：旧实例收尾和句柄释放成功后，才保存并提交最新完整配置。
await runtime.unloadExtra("channel-gateway");
await runtime.loadExtra(gatewayModule, jsonConfig, dependencies);

// 应用退出：先停止 Runtime，确认清理结果后，再关闭宿主共享数据库。
// 切账号同样先收尾旧账号；新账号启动后重新提供其配置和函数，不复用旧闭包。
await runtime.stop("quit");
```

工厂在每个启用且配置有效的 Bot 初始化时调用一次；`enabled: false` 和无效配置不创建宿主句柄。参数不是整个 `bots` 数组，也没有入站消息字段。Gateway 复制工厂参数，工厂修改副本不影响连接配置；未知 scope 字段只保留，不由框架解释或授权。同一 Bot 的所有群、私聊、话题仍经现有不透明 key 区分，宿主不得拆解 key 推导身份或省略自己的账号/组织/助理分区。

工厂是同步函数，返回 `ImSessionStore`，不返回 Promise。误传 Promise/thenable 会被明确拒绝；其拒绝不会作为未处理 Promise 逃逸，迟到返回的句柄也会尝试回收，回收失败或未结束仍按清理失败处理。接口读写均同步，不能直接返回异步数据库方法的 Promise；`async` 包装不会消除同步 SQLite 阻塞。句柄释放单独允许异步。工厂及数据库只保留在宿主 Node 进程，不写入 JSON、启动参数或独立 AdapterHost IPC。

### 8.2 存储实现合同

| 方法 | 宿主必须实现的语义 |
| --- | --- |
| `read(key)` / `save(key, binding)` | 返回独立快照并完整保存 binding：逻辑 id、generation、Provider session、最近 Run/Event、首轮准备标记及可选 gap；不要只保存 Provider thread |
| `reset(key, controlId)` | 同一控制消息幂等；新 reset 增 generation 并清除旧 session/Provider/gap；对同一 key 原子完成，不影响其他 key |
| `occurrence(key, id)` / `remember(key, id, value)` | 按聊天和消息身份隔离，保存约定的去重及重试快照；宿主制定有界保留策略，不能无限归档所有正文/Context |
| `patchGap?(key, identity, update)` | 可选；原子检查 sessionId/generation 并 patch 最新 gap，身份不符返回 false。缺省时 Gateway 按既有 unknown 策略处理，不能假报已追平 |
| `close?(): void \| Promise<void>` | 只释放本句柄及其监听器/租约，不能关闭整个 Client 数据库；异常向上传播，不伪装释放成功 |

`ImSessionBinding`、`ImSessionOccurrence` 可从公开入口取得。数据过期、容量、事务和 schema 归宿主；Runtime 不增加 SQLite 依赖或迁移旧数据。Provider binding 存在只表示可尝试恢复；Provider 拒绝恢复或显式 fresh_fallback 仍按原合同处理，不保证 thread 永不改变。固定 Agent cwd、reset 后的历史准备及模型执行策略保持原合同。

### 8.3 所有权、失败和关闭顺序

工厂返回的新句柄归 Gateway 的 Manager 管理；每个 Bot 必须返回独立句柄，不能让两个 Bot 共享同一个可关闭句柄。Manager 只在旧实例清理成功后创建替代句柄。底层高级 API 直接注入 `sessions` 仍是借用，Runtime 不关闭它，不能同时配置 `sessions` 与 `createSessionStore`。

卸载、退出和账号切换的顺序为：停止接纳 → 取消连接与执行 → 等待队列及原调用收尾 → 释放句柄。SDK 在停止接纳后按原 receipt 校验调用归属并请求取消，保留原 IPC 事件流至真实终态或清理期限，不因 owner abort 立即断开。普通调用方显式取消仍沿原立即取消语义。停止信号触发不等于句柄立即失效：宿主若有租约状态机，应先进入 draining，允许已接纳调用的有界收尾写入；Gateway 在此期间只保存同 session/generation 的真实 Provider session 更新，不继续展示、交互或发送最终回复。reset 后的旧任务不能覆盖新 binding。

清理最多等待 5 秒，与 Extra loader 的既有共享宽限协调，不按资源逐项延长。超时后 Gateway 拒绝通过旧包装句柄的迟到访问，并报告清理失败；超时不等于宿主句柄已释放。宿主仍须在自己的最终期限撤销外部租约，处理未完成的 IO/句柄，再决定数据库关闭策略。同步阻塞整个事件循环的宿主代码无法由 JS 定时器强制终止。

工厂抛错或返回无效接口时，受影响 Bot 通过 `extraStatus("channel-gateway")` 的 `errors`/`config_error` 报告错误，有效 Bot 仍按原合同初始化；**不会回退到 Memory**。运行中的存储异常沿 `IM_SESSION_STORE_FAILED` 等既有脱敏诊断报告，不泄露数据库原始异常。draining 阶段的存储写入/读取失败即使已被业务诊断捕获，也会使清理失败，不能用句柄 close 成功掩盖绑定未保存。初始化尚未退出时，owner abort 同样立即启动 Manager 的清理和撤权期限。句柄清理失败/超时上报 `EXTRA_DISPOSE_FAILED`，保留失败实例阻止同名 reload；宿主必须显示失败并处理资源，不能忽略错误继续创建新实例。

本地验证入口为 [宿主存储专项](test/im-host-session-store.test.js)：真实 Extra + 临时 SQLite 关闭重开、会话续接、去重/reset、scope 隔离、句柄所有权、在途收尾、失败/超时及 SDK 生命周期。网络 Transport 与模型使用 fake；真实 IM 与 Provider 恢复需要宿主固定版本后单独联验。
