/**
 * 语言偏好 —— 骨架与 lib/theme.ts 的外观偏好逐项对应（load / save / resolve / apply / set / init
 * + localStorage + 自定义 window 事件 + useSyncExternalStore），刻意不用 React Context：
 * 两个偏好形状一致，读代码的人零学习成本。
 *
 * 取词逻辑本身在 @shared/i18n（主进程建菜单也用同一份），这里只负责
 * 「偏好持久化 + 解析 + 落到 DOM + 通知订阅者」。
 *
 * 不需要 public/appearance.js 那样的预水合脚本：主题要预水合是因为颜色闪烁刺眼，
 * 而文案在模块初始化时同步读 localStorage，首帧就是对的语种，不存在闪烁。
 */

import { useMemo, useSyncExternalStore } from 'react'
import {
  BASE_LOCALE,
  BCP47,
  createTranslator,
  isLocale,
  localeFromTag,
  setActiveLocale,
  type Locale,
  type Translate,
} from '@shared/i18n'

/** 三档偏好，与外观的 'system' | 'light' | 'dark' 同形。 */
export type LanguagePreference = Locale | 'system'

const LANGUAGE_KEY = 'octo-work.language'
/**
 * 默认简体中文而非 'system'：与外观偏好默认 'light'（同样不是 system）的既有取舍一致，
 * 首次启动的语种确定、可预期。英文用户显式切一次即持久生效。
 */
const LANGUAGE_DEFAULT: LanguagePreference = 'zh_CN'

/** applyLocale 时派发（detail: LanguagePreference）。 */
export const LANGUAGE_CHANGE_EVENT = 'Octo Work:languagechange'

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLocale(value)
}

export function loadLanguage(): LanguagePreference {
  try {
    const raw = localStorage.getItem(LANGUAGE_KEY)
    return isLanguagePreference(raw) ? raw : LANGUAGE_DEFAULT
  } catch {
    return LANGUAGE_DEFAULT
  }
}

export function saveLanguage(value: LanguagePreference): void {
  try {
    localStorage.setItem(LANGUAGE_KEY, value)
  } catch {
    // 私有模式 / 配额：静默，内存态仍生效
  }
}

/** 将偏好解析为确定语种：system 跟随浏览器（即 Chromium 解析的系统语言）。 */
export function resolveLocale(value: LanguagePreference): Locale {
  if (value !== 'system') return value
  if (typeof navigator === 'undefined') return BASE_LOCALE
  return localeFromTag(navigator.languages?.[0] ?? navigator.language)
}

/**
 * 应用语言偏好：写进程内活动语种、落 html[lang]、通知主进程重建菜单、派发事件。
 * 返回解析后的语种。
 * html[lang] 影响 CJK 字体回退、断行与读屏语音，不只是标记。
 */
export function applyLocale(value: LanguagePreference): Locale {
  const locale = resolveLocale(value)
  setActiveLocale(locale)
  document.documentElement.lang = BCP47[locale]
  // 渲染层是语言偏好的权威，主进程是跟随者：mac 顶部菜单在它那边，
  // 收到这条才会按新语种重建（与 setNativeAppearance 同构，fire-and-forget——
  // 菜单语种落后一拍不该拖住界面切换，非 Electron 环境下 ?. 直接跳过）。
  window.dispatchEvent(new CustomEvent<LanguagePreference>(LANGUAGE_CHANGE_EVENT, { detail: value }))
  return locale
}

/** 持久化 + 应用一步完成（设置页 segmented control 用）。 */
export function setLanguage(value: LanguagePreference): Locale {
  saveLanguage(value)
  return applyLocale(value)
}

/** 启动时初始化，紧邻 initAppearance() 调用。 */
export function initI18n(): void {
  applyLocale(loadLanguage())
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange)
  return () => window.removeEventListener(LANGUAGE_CHANGE_EVENT, onStoreChange)
}

/** 当前偏好（含 system），设置页 segmented 的受控值。 */
export function useLanguage(): LanguagePreference {
  return useSyncExternalStore(subscribe, loadLanguage, () => LANGUAGE_DEFAULT)
}

/** 当前生效语种，跨组件一致。 */
export function useLocale(): Locale {
  return useSyncExternalStore(
    subscribe,
    () => resolveLocale(loadLanguage()),
    () => BASE_LOCALE,
  )
}

/**
 * 组件内取词。返回的函数标识随语种变化，所以 useMemo / React.memo 的依赖数组
 * 能感知切换——这是它存在的理由（直接用 @shared/i18n 的模块级 `t` 的话，
 * memo 化的子树在切语言时不会重渲）。
 *
 * 事件回调、toast、以及 lib/format.ts 这类非组件模块用模块级 `t`。
 */
export function useT(): Translate {
  const locale = useLocale()
  return useMemo(() => createTranslator(locale), [locale])
}
