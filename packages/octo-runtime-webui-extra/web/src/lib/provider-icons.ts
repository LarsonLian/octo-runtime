import { getAdapterIcon } from '@mininglamp-oss/octo-runtime-adapter-icons'

/**
 * Runtime / 设置里的 provider·adapter 品牌图标。
 *
 * 单一来源是独立项目 `@mininglamp-oss/octo-runtime-adapter-icons` 包（内联 SVG），
 * 不再往 assets/ 手拷图标文件——新增/更新品牌图标只改那个包、跑它的 generate 即可，
 * 本仓自动跟随。包里没有的 providerType（如 kiro / acp）由调用方回落到通用终端
 * 图标（SettingsView 的 `!icon → <TerminalSquare>`）。
 *
 * 对外仍暴露 `{ name, url, darkURL?, monochrome? }`：`url`/`darkURL` 由包的内联 SVG 转成
 * `data:` URL，`<img src>` 与 CSS `mask-image: url(...)` 都能直接用，消费方无需改动。
 * - monochrome：单色字形，用 mask 走 currentColor，深浅色下都看得见。
 * - darkURL：包提供了深色版时才有（darkSvg）。
 */
export interface ProviderIcon {
  name: string
  url: string
  darkURL?: string
  monochrome?: boolean
}

/** harness 上报的少数别名收敛到包里的规范 type。 */
const PROVIDER_ALIAS: Record<string, string> = {
  claude_code: 'claude-code',
  kimi_code: 'kimi-code',
  zcode: 'zcode-gui',
}

/** 包里没有官方图标的 provider 仍要有名字（回落图标由调用方给）。 */
const PROVIDER_NAME_FALLBACK: Record<string, string> = {
  acp: 'ACP',
}

/** 内联 SVG 源串 → data URL（img src 与 CSS mask-image 通用）。 */
function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// 每个 type 解析一次并缓存：内联 SVG 逐条 encode 有成本，列表/消息行会频繁重渲染。
const cache = new Map<string, ProviderIcon | null>()

function resolve(providerType: string): ProviderIcon | null {
  const key = PROVIDER_ALIAS[providerType] ?? providerType
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const icon = getAdapterIcon(key)
  const resolved: ProviderIcon | null = icon
    ? {
        name: icon.name,
        url: svgToDataUrl(icon.svg),
        darkURL: icon.darkSvg ? svgToDataUrl(icon.darkSvg) : undefined,
        monochrome: icon.monochrome,
      }
    : null
  cache.set(key, resolved)
  return resolved
}

export function providerIcon(providerType: string): ProviderIcon | undefined {
  return resolve(providerType) ?? undefined
}

export function providerName(providerType: string): string {
  const key = PROVIDER_ALIAS[providerType] ?? providerType
  return getAdapterIcon(key)?.name ?? PROVIDER_NAME_FALLBACK[key] ?? providerType
}
