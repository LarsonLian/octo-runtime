// UI Kit — Kimi 居中模态（portal + 焦点陷阱；从 Work components 归位，正文逐字保留）。
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useUiTranslate } from './config'
import { cn } from './cn'
import { useUiOverlayDismiss } from './config'
import { LAYER } from './Popover'

export interface ModalProps {
  onClose: () => void
  title: ReactNode
  hideCloseButton?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
  /** 标题下的辅助说明。 */
  description?: string
  /** sm 360px / md 440px。 */
  size?: 'sm' | 'md'
  className?: string
  children: ReactNode
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'ui-dialog--sm',
  md: 'ui-dialog--md',
}

/**
 * Kimi 居中模态：ui-dialog 结构（__overlay / __head / __titles / __title / __desc / __close / __body）。
 * portal + scrim（overlay 自带动画），Esc 关闭，焦点落在关闭按钮并做焦点陷阱。
 */
export function Modal({ onClose, title, description, size = 'sm', className, hideCloseButton = false, initialFocusRef, children }: ModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const t = useUiTranslate()
  const panelRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  const titleId = `${uid}-title`
  const descriptionId = description ? `${uid}-desc` : undefined

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const initialFocus = initialFocusRef?.current ?? closeRef.current ?? panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')
    initialFocus?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const dialogs = document.querySelectorAll('.ui-dialog__overlay')
      if (dialogs[dialogs.length - 1] !== panelRef.current?.parentElement) return
      const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], [contenteditable="true"]') ?? [])
      const visibleControls = controls.filter(control => !control.closest('[hidden], [inert]') && control.getAttribute('aria-hidden') !== 'true')
      const first = visibleControls[0]
      const last = visibleControls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', trap)
    return () => { window.removeEventListener('keydown', trap); previous?.focus() }
  }, [])

  // Esc 不再自挂监听:入 overlay 栈(dialog 层),由 KeyboardProvider 分发给栈顶。
  // Tab 焦点陷阱是控件级键盘语义,留在组件内(docs/keyboard-architecture.md §3)。
  useUiOverlayDismiss({ active: true, layer: LAYER.dialog, onDismiss: () => onClose() })

  return createPortal(
    <div className="ui-dialog__overlay" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        className={cn('ui-dialog', SIZE[size], className)}
      >
        <header className="ui-dialog__head">
          <div className="ui-dialog__titles">
            <h2 id={titleId} className="ui-dialog__title">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="ui-dialog__desc">
                {description}
              </p>
            ) : null}
          </div>
          {!hideCloseButton && <button
            ref={closeRef}
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="ui-icon-button ui-icon-button--sm ui-dialog__close"
          >
            <X size={16} />
          </button>}
        </header>
        <div className="ui-dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
