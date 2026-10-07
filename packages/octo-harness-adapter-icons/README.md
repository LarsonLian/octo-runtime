# @mininglamp-oss/octo-harness-adapter-icons

Provider/adapter brand icons for Octo Harness, delivered as **framework-neutral
inline SVG strings** so downstream React / Electron / vanilla apps can bundle
them directly — no copying image files, no local path resolution. This is the
lucide *core* model: icons are data, not a UI framework binding.

## 安装 & 使用

```ts
import { getAdapterIcon, adapterIcons, codexIcon } from "@mininglamp-oss/octo-harness-adapter-icons";

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

## 覆盖的 adapter 类型(11,全部)

| type | 名称 | 类型 |
| --- | --- | --- |
| `codex` | Codex | 彩色 |
| `claude-code` | Claude Code | 彩色 |
| `codebuddy` | CodeBuddy | 彩色 |
| `hermes` | Hermes | 单色 |
| `kimi-code` | Kimi Code | 彩色 |
| `mcode` | MiniMax Code | 彩色 |
| `opencode` | OpenCode | 单色 |
| `openclaw` | OpenClaw | 彩色 |
| `qodercli` | Qoder | 彩色 |
| `qoderclicn` | Qoder CN | 彩色(Qoder 底图 + 右下角 CN 角标) |
| `zcode-gui` | ZCode | 单色(z.ai 品牌 mark) |

`config/adapters.json` 中的每个 adapter type 均有对应图标,`getAdapterIcon`
对全部 11 类都返回结果。

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
- **zcode-gui**:使用 LobeHub 的 z.ai(`zai`)品牌 mark(ZCode 为 z.ai 的
  编码产品)。
- **mcode**:使用 LobeHub 的 MiniMax 彩色 mark。
