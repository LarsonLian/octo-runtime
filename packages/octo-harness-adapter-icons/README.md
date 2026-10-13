# @mininglamp-oss/octo-harness-adapter-icons

Provider/adapter brand icons for Octo Harness, delivered as **framework-neutral
inline SVG strings** so downstream React / Electron / vanilla apps can bundle
them directly — no copying image files, no local path resolution. This is the
lucide _core_ model: icons are data, not a UI framework binding.

## 安装 & 使用

```ts
import {
  getAdapterIcon,
  adapterIcons,
  codexIcon
} from "@mininglamp-oss/octo-harness-adapter-icons";

// 按 adapter type 查询(未命中返回 undefined,消费方 fallback 到默认图标)
const icon = getAdapterIcon("codex");
// icon = { type: "codex", name: "Codex", svg: "<svg ...>" }
```

React 渲染(SVG 字符串内联,bundler 自动打包,无需拷图):

```tsx
function AdapterIcon({ type }: { type: string }) {
  const icon = getAdapterIcon(type);
  if (!icon) return <TerminalFallback />;
  return <span aria-label={icon.name} dangerouslySetInnerHTML={{ __html: icon.svg }} />;
}
```

- `monochrome: true` 的图标为单色 glyph,建议用 `currentColor` / CSS `maskImage`
  由主题文字色上色,保证明暗主题下可见。彩色图标(`monochrome` 缺省)自带品牌色。
- `darkSvg` 存在时可在暗色主题下改用暗色变体(当前无图标使用)。

## 覆盖的 adapter 类型(12,全部)

| type          | 名称         | 类型                              |
| ------------- | ------------ | --------------------------------- |
| `antigravity` | Antigravity  | 彩色                              |
| `codex`       | Codex        | 彩色                              |
| `claude-code` | Claude Code  | 彩色                              |
| `codebuddy`   | CodeBuddy    | 彩色                              |
| `hermes`      | Hermes       | 单色                              |
| `kimi-code`   | Kimi Code    | 彩色                              |
| `mcode`       | MiniMax Code | 彩色                              |
| `opencode`    | OpenCode     | 单色                              |
| `openclaw`    | OpenClaw     | 彩色                              |
| `qodercli`    | Qoder        | 彩色                              |
| `qoderclicn`  | Qoder CN     | 彩色(Qoder 底图 + 右下角 CN 角标) |
| `zcode-gui`   | ZCode        | 单色(ZCode 官方 Z 字形)           |

`config/adapters.json` 中的每个 adapter type 均有对应图标,`getAdapterIcon`
对全部 12 类都返回结果。

`getAdapterIcon("zcode")` 兼容 Runtime 的简写,返回 `zcode-gui` 的同一个官方图标。

## 维护:新增/更新图标

1. 将官方 SVG 放入 `src/icons/`(文件名与 `ICONS` 表的 `file` 一致)。
2. 在 `scripts/generate-icons.mjs` 的 `ICONS` 表补一行(`type` / `name` /
   `file` / 可选 `monochrome` / 可选 `darkFile`)。
3. 运行 `pnpm --filter @mininglamp-oss/octo-harness-adapter-icons generate`
   重新生成 `src/generated.ts`(该文件为自动生成,勿手改),再 `build`。

## Brand 归属

These marks identify installed providers, not endorsements. Brand names and
marks remain the property of their respective owners. Do not replace them with
third-party redraws.

图标主要来源于 **[LobeHub Icons](https://lobehub.com/icons)**
(`@lobehub/icons-static-svg`),统一 24×24 / `1em` 风格。特别说明:

- **hermes**:LobeHub 无 Hermes 专属 mark,沿用 Nous Research 官网 wing mark
  (与 octo-web 同源)。
- **qoderclicn**:以 LobeHub 的 Qoder 彩色 mark 为底图,叠加右下角蓝色 `CN`
  角标合成,标识 Qoder 中国区发行版。
- **zcode-gui**:使用 [ZCode 官方品牌素材](https://github.com/zerx-lab/zcode/tree/zcode/brand/logo)
  中的 `zcode-mark-mono.svg`,保留原始字形与比例,由消费方通过 mask 适配主题颜色。
- **mcode**:使用 LobeHub 的 MiniMax 彩色 mark。
- **antigravity**:使用 LobeHub 的 `antigravity-color.svg`，保留渐变 A 形、透明背景和 SVG filters。来源为 [lobe-icons](https://github.com/lobehub/lobe-icons)，本次定位 commit `c385b2b8d1f9e19aa86e628d4e23c91ee1111a47`；代码许可证为 MIT，品牌归属不变。实际素材校验值见接入验收记录。

## 模块责任边界

- 负责：提供适配器品牌图标资源。
- 不负责：执行、协议连接与运行时状态。
- 协作边界：见 [根架构与包边界](../../README.md#模块责任边界)。所有执行来源共用 adapter-host IPC；模块按职责提供协议、执行或宿主能力。
