// UI Kit — Kimi 细环 spinner（从 src/renderer/src/components 归位，正文逐字保留）。
import { useUiTranslate } from './config'
import { cn } from './cn'

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE: Record<SpinnerSize, string> = {
  xs: 'ui-spinner--xs',
  sm: 'ui-spinner--sm',
  md: 'ui-spinner--md',
  lg: 'ui-spinner--lg',
}

/**
 * Kimi 细环 spinner：ui-spinner 结构（__svg + __track + __arc）。
 * 用于按钮 loading、提交态、列表加载。旋转由 .ui-spin 驱动，弧段形状来自 CSS 的 dasharray。
 */
export function Spinner({ size = 'sm', className }: { size?: SpinnerSize; className?: string }) {
  const t = useUiTranslate()
  return (
    <span role="status" aria-label={t('common.loading')} className={cn('ui-spinner', SIZE[size], className)}>
      <svg className="ui-spinner__svg ui-spin" viewBox="0 0 24 24" aria-hidden>
        <circle className="ui-spinner__track" cx="12" cy="12" r="8.9" />
        <circle className="ui-spinner__arc" cx="12" cy="12" r="8.9" />
      </svg>
    </span>
  )
}
