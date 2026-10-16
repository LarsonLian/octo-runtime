/**
 * 多语言核心 —— 纯逻辑，不依赖 React 与 Electron，主进程（菜单）与渲染层共用。
 *
 * 文案权威源是 `resources/locales/*.json`，由 Vite 打进 bundle，不做运行时读盘：
 * electron-builder 的 files 只收 `out/**` 且 asar 打包，进 bundle 才能保证打包后可用。
 * 代价是语言文件不可热改——对两语种的内置 UI 是正确取舍。
 *
 * 键名从 zh_CN 的 JSON 结构反推成联合类型（MessageID），拼错键是 tsc 报错而不是
 * 运行时兜底。这也是这里手写而不引 i18next 的主要理由（见 docs/i18n-architecture.md）。
 */
import enUS from '../../resources/locales/en_US.json'
import zhCN from '../../resources/locales/zh_CN.json'

export type Locale = 'zh_CN' | 'en_US'

/** 基准语种：键集以它为准，其余语种缺键时回落到它。 */
export const BASE_LOCALE: Locale = 'zh_CN'

export const LOCALES: readonly Locale[] = ['zh_CN', 'en_US']

export function isLocale(value: unknown): value is Locale {
  return value === 'zh_CN' || value === 'en_US'
}

/** Intl、`document.documentElement.lang` 用的 BCP-47 形式。 */
export const BCP47: Readonly<Record<Locale, string>> = { zh_CN: 'zh-CN', en_US: 'en-US' }

/**
 * BCP-47 语言标签 → Locale。zh 前缀归 zh_CN，其余一律 en_US
 * （对第三语种用户，英文比中文更可读）。
 * 主进程喂 `app.getLocale()`、渲染层喂 `navigator.language`，判定逻辑只此一份。
 */
export function localeFromTag(tag: string | undefined): Locale {
  return /^zh([-_]|$)/i.test(tag ?? '') ? 'zh_CN' : 'en_US'
}

/**
 * 复数条目。中文两支同文，英文才有区别；按 `vars.count` 选支。
 * 不引 ICU / Intl.PluralRules——两语种用不上 zero/few/many。
 */
export interface Plural {
  one: string
  other: string
}

/**
 * 从 catalog 结构反推点路径键。命中字符串或 Plural 即停，
 * 所以 `one` / `other` 不会被暴露成键（`time.minutesAgo` 而不是 `time.minutesAgo.one`）。
 */
type Keys<T> = T extends string
  ? ''
  : T extends Plural
    ? ''
    : {
        [K in keyof T & string]: Keys<T[K]> extends '' ? K : `${K}.${Keys<T[K]>}`
      }[keyof T & string]

/** 全部合法键名。以 zh_CN 为准——en_US 的键集由 tests/i18n.test.ts 强制对齐。 */
export type MessageID = Keys<typeof zhCN>

/** 插值变量。`{name}` 形式的占位符，值只允许字符串与数字。 */
export type Vars = Record<string, string | number>

export type Translate = (key: MessageID, vars?: Vars) => string

const CATALOGS: Record<Locale, unknown> = { zh_CN: zhCN, en_US: enUS }

function isPlural(value: unknown): value is Plural {
  if (typeof value !== 'object' || value === null) return false
  const node = value as Record<string, unknown>
  return typeof node.one === 'string' && typeof node.other === 'string'
}

/** 沿点路径取值；路径不存在或指向中间节点时返回 undefined。 */
function lookup(catalog: unknown, key: string): string | Plural | undefined {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node === 'string') return node
  return isPlural(node) ? node : undefined
}

const PLACEHOLDER = /\{(\w+)\}/g

function interpolate(template: string, key: string, vars: Vars | undefined): string {
  if (!template.includes('{')) return template
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars?.[name]
    if (value === undefined) {
      // 静默出 "undefined" 比报错更难查，所以这里明确喊一声。
      console.warn(`[i18n] ${key} 缺少插值变量 {${name}}`)
      return match
    }
    return String(value)
  })
}

/**
 * 把 catalog 摊平成「点路径 → 文案」的表。
 * 给 tests/i18n.test.ts 做两语种键集与占位符比对用，运行时翻译不走这条路径。
 */
export function flattenCatalog(locale: Locale): Map<string, string | Plural> {
  const out = new Map<string, string | Plural>()
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'string' || isPlural(node)) {
      out.set(prefix, node)
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, child] of Object.entries(node)) {
      walk(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  walk(CATALOGS[locale], '')
  return out
}

/**
 * 取词内核。
 * 缺键时回落到 BASE_LOCALE 并 warn；两边都缺才返回键名本身
 * （有 MessageID 约束，只可能发生在 JS 调用方）。
 */
function translate(locale: Locale, key: MessageID, vars?: Vars): string {
  let entry = lookup(CATALOGS[locale], key)
  if (entry === undefined && locale !== BASE_LOCALE) {
    entry = lookup(CATALOGS[BASE_LOCALE], key)
    if (entry !== undefined) console.warn(`[i18n] ${locale} 缺少键 ${key}，已回落 ${BASE_LOCALE}`)
  }
  if (entry === undefined) {
    console.warn(`[i18n] 未知键 ${key}`)
    return key
  }
  const template = typeof entry === 'string' ? entry : Number(vars?.count) === 1 ? entry.one : entry.other
  return interpolate(template, key, vars)
}

/** 造一个绑定语种的翻译函数。组件层的 `useT()` 用它，主进程建菜单也用它。 */
export function createTranslator(locale: Locale): Translate {
  return (key, vars) => translate(locale, key, vars)
}

/* ---------------------------------------------------------------------------
 * 活动语种
 *
 * 进程内的一份可变状态，刻意不依赖 DOM 与 React：
 *   - 主进程收到渲染层报来的 locale 后 setActiveLocale() 再重建菜单；
 *   - 渲染层的 lib/format.ts 这类纯函数模块没法用 hook，只能同步读它；
 *   - node 环境单测可以直接 setActiveLocale('en_US') 验英文分支。
 * 渲染层的偏好持久化在 lib/i18n.ts（localStorage），这里只存解析后的结果。
 * ------------------------------------------------------------------------- */

let active: Locale = BASE_LOCALE

export function activeLocale(): Locale {
  return active
}

export function setActiveLocale(locale: Locale): void {
  active = locale
}

/**
 * 跟随活动语种的翻译函数。
 * 组件里请用 `useT()`——它的函数标识随语种变化，memo 依赖能感知；
 * 而这个 `t` 适用于事件回调、toast、以及 lib/format.ts 这类非组件模块。
 */
export const t: Translate = (key, vars) => translate(active, key, vars)
