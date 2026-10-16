/**
 * 纯时间格式化。只做展示，不做任何数据变换。
 * 约定输入为 ms 时间戳（number）；无效输入返回空串（不伪造时间）。
 *
 * 跟随语种，但导出签名一律不变，所以调用点零改动：
 * - 相对时间词（刚刚 / N 分钟前 / 昨天 / 今天）走 catalog 的 `time.*` 键。
 *   刻意不用 Intl.RelativeTimeFormat——它对 zh 输出「现在」而非「刚刚」、
 *   「5分钟前」而非「5 分钟前」，会改动既有中文文案。
 * - 月日与年月日走 Intl（zh 的 `month:'short'` 输出恰好就是「1月5日」，逐字不变；
 *   en 自动得到 Jan 5 / Jan 5, 2026）。
 * - YYYY-MM-DD、MM-DD、HH:mm 与字节单位保持手写：它们语言中立，
 *   日志与状态栏刻意要 ISO 形状。
 *
 * 这里是非组件模块，用不了 hook，所以取词用 @shared/i18n 的模块级 `t`
 * （它读进程内活动语种；切语言时整树重挂，见 main.tsx 的 Root）。
 */

import { BCP47, activeLocale, t } from '@shared/i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Intl 实例按「语种 + 形状」缓存：语种进了 key，所以切语言不需要失效逻辑。 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>()

/** 「月日」/「年月日」格式化器。zh → 1月5日 / 2026年1月5日；en → Jan 5 / Jan 5, 2026。 */
function dayFormatter(withYear: boolean): Intl.DateTimeFormat {
  const locale = activeLocale()
  const cacheKey = `${locale}:${withYear ? 'ymd' : 'md'}`
  let formatter = dayFormatters.get(cacheKey)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      BCP47[locale],
      withYear
        ? { year: 'numeric', month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric' },
    )
    dayFormatters.set(cacheKey, formatter)
  }
  return formatter
}

/** 短星期格式化器。zh -> 周一；en -> Mon。 */
function weekdayFormatter(): Intl.DateTimeFormat {
  const locale = activeLocale()
  let formatter = weekdayFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(BCP47[locale], { weekday: 'short' })
    weekdayFormatters.set(locale, formatter)
  }
  return formatter
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** HH:mm（24 小时制）。语言中立，两语种同形，所以手写而不过 Intl。 */
function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 相对时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / MM-DD。
 * 超过 30 天退化为完整日期 YYYY-MM-DD（会话列表足够，不需要更精确）。
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const delta = now - ts
  if (delta < MINUTE) return t('time.justNow')
  if (delta < HOUR) return t('time.minutesAgo', { count: Math.floor(delta / MINUTE) })
  if (delta < DAY) return t('time.hoursAgo', { count: Math.floor(delta / HOUR) })
  const days = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days === 1) return t('time.yesterday')
  if (days <= 30) {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${mm}-${dd}`
  }
  return formatDate(ts)
}

/** 完整日期：YYYY-MM-DD。 */
export function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const y = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

/** 带时间：YYYY-MM-DD HH:mm（日志、状态栏等）。 */
export function formatDateTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  return `${formatDate(ts)} ${clock(new Date(ts))}`
}

/** 时钟时间 HH:mm（ms 输入，会话流内消息时间用）。 */
export function formatClockTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ''
  return clock(new Date(ts))
}

/** 回答尾部时间：今天 HH:mm，近七个自然日周X HH:mm，更早 MM-DD HH:mm（不带年份）。 */
export function formatConversationMessageTime(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(date.getTime()) || !Number.isFinite(today.getTime())) return ''
  const time = clock(date)
  if (date.toDateString() === today.toDateString()) return time
  // 按本地自然日比较，避免夏令时与跨午夜导致星期边界偏移。
  const dayNumber = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / DAY
  const days = dayNumber(today) - dayNumber(date)
  if (days > 0 && days < 7) return `${weekdayFormatter().format(date)} ${time}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
}

/**
 * 大小写折叠（搜索过滤用），跟随语种。
 * 这里必须显式传 locale：`toLowerCase()` 对土耳其语 I 这类特例会给错结果，
 * 而写死 'zh-CN' 则是在英文界面下用中文规则折叠。
 */
export function foldCase(value: string): string {
  return value.toLocaleLowerCase(BCP47[activeLocale()])
}

/** 字节格式化（usage 展示）：1024 进制，保留 1 位小数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024 || next === units[units.length - 1]) break
    value /= 1024
    unit = next
  }
  if (unit === 'B') return `${Math.round(value)} B`
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

/* ---------------------------------------------------------------------------
 * IM 时间格式化（wire 通常为秒级时间戳，同时兼容本地毫秒时间戳）
 * ------------------------------------------------------------------------- */

function imDate(timestamp: number): Date {
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp)
}

/** IM 会话列表右上角时间：今天 / 昨天 / 前天 / 星期 / 日期，与 IM 保持一致。 */
export function formatImListTime(tsSeconds: number, now: number = Date.now()): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0 || !Number.isFinite(now)) return ''
  const date = imDate(tsSeconds)
  const nowDate = new Date(now)
  const sameDay = date.toDateString() === nowDate.toDateString()
  if (sameDay) return clock(date)
  const yesterday = new Date(now)
  yesterday.setDate(nowDate.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `${t('time.yesterday')} ${clock(date)}`
  const dayBeforeYesterday = new Date(now)
  dayBeforeYesterday.setDate(nowDate.getDate() - 2)
  if (date.toDateString() === dayBeforeYesterday.toDateString()) return `${t('time.dayBeforeYesterday')} ${clock(date)}`
  const delta = now - date.getTime()
  if (delta >= 0 && delta < 7 * DAY) return `${weekdayFormatter().format(date)} ${clock(date)}`
  if (date.getFullYear() === nowDate.getFullYear()) {
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return `${mm}-${dd}`
  }
  return formatDate(date.getTime())
}

/**
 * IM 消息头时间，对齐 octo-web 的 formatMessageTimestamp：
 * - 今天：HH:mm
 * - 昨天：昨天 HH:mm
 * - 七天内：周X HH:mm
 * - 本年更早：MM-DD HH:mm
 * - 跨年：YYYY-MM-DD HH:mm
 *
 * wire 数据通常为秒级时间戳，同时兼容毫秒输入，避免本地 optimistic 消息错到 1970 年。
 */
export function formatImMessageTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(now)) return ''
  const date = imDate(timestamp)
  const nowDate = new Date(now)
  const time = clock(date)

  if (date.toDateString() === nowDate.toDateString()) return time

  const yesterday = new Date(now)
  yesterday.setDate(nowDate.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `${t('time.yesterday')} ${time}`

  const delta = now - date.getTime()
  if (delta >= 0 && delta < 7 * DAY) return `${weekdayFormatter().format(date)} ${time}`

  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  if (date.getFullYear() === nowDate.getFullYear()) return `${mm}-${dd} ${time}`
  return `${date.getFullYear()}-${mm}-${dd} ${time}`
}

/** IM 连续消息 hover 时间：仅 HH:mm（秒输入，对齐 octo-web formatTimeOnly）。 */
export function formatImClockTime(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return ''
  return clock(imDate(tsSeconds))
}

/** IM 日期分隔线：今天 / 昨天 / M月D日 / YYYY年M月D日（英文为 Today / Yesterday / Jan 5 / Jan 5, 2026）。 */
export function formatImDayLabel(tsSeconds: number, now: number = Date.now()): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return ''
  const date = imDate(tsSeconds)
  const nowDate = new Date(now)
  if (date.toDateString() === nowDate.toDateString()) return t('time.today')
  const yesterday = new Date(now)
  yesterday.setDate(nowDate.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return t('time.yesterday')
  return dayFormatter(date.getFullYear() !== nowDate.getFullYear()).format(date)
}
