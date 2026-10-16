// UI Kit — Kimi Button（ui-button 设计系统；从 Work components 归位，正文逐字保留）。
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from './cn'
import { Spinner } from './Spinner'

// 兼容旧调用点的 variant/size，同时暴露 Kimi ui-button 的完整档位。
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'danger-soft'
  | 'text'
  | 'inverted'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** loading 时禁用并显示 spinner（内容降透明度以防跳动）。 */
  loading?: boolean
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'ui-button--primary',
  secondary: 'ui-button--secondary',
  ghost: 'ui-button--ghost',
  danger: 'ui-button--danger',
  'danger-soft': 'ui-button--danger-soft',
  text: 'ui-button--text',
  inverted: 'ui-button--inverted',
}

// icon 档保持方形：套用 sm 高度并叠加 square 变体（清零内边距、等宽对齐）。
const SIZE: Record<ButtonSize, string> = {
  xs: 'ui-button--xs',
  sm: 'ui-button--sm',
  md: 'ui-button--md',
  lg: 'ui-button--lg',
  icon: 'ui-button--sm ui-button--square',
}

/**
 * Kimi Button：ui-button 设计系统。children 包在 ui-button__content 内，
 * loading 时叠加 ui-button__spinner（ui-spinner 结构）。
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('ui-button', VARIANT[variant], SIZE[size], loading && 'is-loading', className)}
      {...rest}
    >
      {loading ? <Spinner size="sm" className="ui-button__spinner" /> : null}
      <span className="ui-button__content">{children}</span>
    </button>
  )
})
