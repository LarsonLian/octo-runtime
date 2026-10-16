/**
 * UI Kit — 宿主能力注入（blueprint kit 边界：kit 不 import Work alias）。
 *
 * ui-kit 只需要宿主的两样东西，且都是 **hook**（必须保持 hook 语义，否则切语言不即时
 * 生效、Esc 不入 overlay 栈）：
 * - useTranslate：取文案（Spinner 的 common.loading、Modal 的 common.close）；
 * - useOverlayDismiss：把浮层压入宿主键盘系统的 overlay 栈（Esc 由栈顶消费）。
 *
 * 用模块级 configure 而非 Provider：这些是 renderer 全局的 UI 基础设施，且现存大量单测
 * 会直接渲染 Modal/Popover/Spinner —— 走 Provider 会强制全量测试改写。契约：宿主必须在
 * 首次渲染前 configure（Work 在 components/ui-bootstrap.ts 于模块加载时完成），
 * 以保证注入的 hook 引用恒定、hook 调用顺序稳定。
 */

/** ui-kit 用到的文案键（对应宿主 i18n 的同名键）。 */
export type UiMessageKey = 'common.loading' | 'common.close'
  | 'ui.select.placeholder' | 'ui.select.empty'
  | 'ui.dateTime.placeholder' | 'ui.dateTime.previousMonth' | 'ui.dateTime.nextMonth'
  | 'ui.dateTime.hour' | 'ui.dateTime.minute' | 'ui.dateTime.time'
  | 'ui.dateTime.increaseHour' | 'ui.dateTime.decreaseHour'
  | 'ui.dateTime.increaseMinute' | 'ui.dateTime.decreaseMinute'
  | 'ui.dateTime.today' | 'ui.dateTime.clear' | 'ui.dateTime.apply' | 'ui.dateTime.cancel'

export type UseTranslate = () => (key: UiMessageKey) => string
export type UseOverlayDismiss = (options: {
  active: boolean
  layer: number
  onDismiss: (reason: 'escape') => void
}) => void

/** 未 configure 时的兜底：英文文案 + 不入 overlay 栈（与宿主无 Provider 时的 no-op 一致）。 */
const FALLBACK: Record<UiMessageKey, string> = {
  'common.loading': 'Loading',
  'common.close': 'Close',
  'ui.select.placeholder': 'Select',
  'ui.select.empty': 'No options',
  'ui.dateTime.placeholder': 'Select date and time',
  'ui.dateTime.previousMonth': 'Previous month',
  'ui.dateTime.nextMonth': 'Next month',
  'ui.dateTime.hour': 'Hour',
  'ui.dateTime.minute': 'Minute',
  'ui.dateTime.time': 'Time',
  'ui.dateTime.increaseHour': 'Increase hour',
  'ui.dateTime.decreaseHour': 'Decrease hour',
  'ui.dateTime.increaseMinute': 'Increase minute',
  'ui.dateTime.decreaseMinute': 'Decrease minute',
  'ui.dateTime.today': 'Today',
  'ui.dateTime.clear': 'Clear',
  'ui.dateTime.apply': 'Apply',
  'ui.dateTime.cancel': 'Cancel',
}

let useTranslateImpl: UseTranslate = () => (key) => FALLBACK[key]
let useOverlayDismissImpl: UseOverlayDismiss = () => undefined

export function configureUiKit(config: {
  useTranslate?: UseTranslate
  useOverlayDismiss?: UseOverlayDismiss
}): void {
  if (config.useTranslate) useTranslateImpl = config.useTranslate
  if (config.useOverlayDismiss) useOverlayDismissImpl = config.useOverlayDismiss
}

/** kit 内部用：取宿主注入的取词 hook。 */
export function useUiTranslate(): (key: UiMessageKey) => string {
  return useTranslateImpl()
}

/** kit 内部用：把浮层注册进宿主 overlay 栈。 */
export function useUiOverlayDismiss(options: Parameters<UseOverlayDismiss>[0]): void {
  useOverlayDismissImpl(options)
}
