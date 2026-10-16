// UI Kit — 浮层定位与 LAYER 层级（从 Work components 归位；overlay 栈经注入 hook）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { useUiOverlayDismiss } from './config'

/**
 * z-index 单表（与 index.css --layer-* 对应）。
 * 面板/按钮留在 50 以下；浮层从这张表取值。
 */
export const LAYER = {
  /** 锚定菜单、下拉、picker。 */
  popover: 80,
  /** 已打开 popover 的二级 flyout。 */
  submenu: 81,
  /** 模态对话框。 */
  dialog: 90,
  /** toast，压过一切被它打断的东西。 */
  toast: 100,
} as const

export type PopoverSide = 'top' | 'bottom' | 'left' | 'right'
export type PopoverAlign = 'start' | 'center' | 'end'

export type PopoverAnchor =
  | HTMLElement
  | RefObject<HTMLElement | null>
  | DOMRect
  | { x: number; y: number }
  | null

export interface PopoverProps {
  /** 锚：元素 / ref / 视口坐标 rect / 裸点（右键菜单）。 */
  anchor: PopoverAnchor
  boundary?: PopoverAnchor
  side?: PopoverSide
  align?: PopoverAlign
  /** 锚与浮层间距。 */
  gap?: number
  /** 距视口边缘的呼吸空间。 */
  padding?: number
  /** 固定宽度；`anchor` 表示与锚元素同宽（不给则用自然宽）。 */
  width?: number | 'anchor' | 'boundary'
  /** 最大高度（超出内部滚动）。 */
  maxHeight?: number
  layer?: number
  className?: string
  style?: CSSProperties
  /** 打开时聚焦浮层（键盘可达）。 */
  autoFocus?: boolean
  /** 传入后由 Popover 负责外部点击与 Esc 关闭。 */
  onDismiss?: (reason: 'outside' | 'escape') => void
  dismissOnEscape?: boolean
  /** 命中该选择器的元素不算"外部"。 */
  ignore?: string
  children: ReactNode
}

const DEFAULT_GAP = 6
const DEFAULT_PADDING = 8

type AnchorRect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

function toRect(rect: DOMRect): AnchorRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
}

function anchorRect(anchor: PopoverAnchor): AnchorRect | null {
  if (!anchor) return null
  if (anchor instanceof HTMLElement) return toRect(anchor.getBoundingClientRect())
  if ('current' in anchor) {
    const el = anchor.current
    return el ? toRect(el.getBoundingClientRect()) : null
  }
  if ('width' in anchor) return toRect(anchor)
  return { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y, width: 0, height: 0 }
}

type Position = { side: PopoverSide; left: number; top?: number; bottom?: number; width: number; maxHeight: number }

const OPPOSITE: Record<PopoverSide, PopoverSide> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

/** 夹在 [min, max]；容不下时（min > max）贴 min 那一边，不要反向溢出。 */
function clamp(v: number, min: number, max: number): number {
  if (min > max) return min
  return Math.min(max, Math.max(min, v))
}

/** 纯放置计算（无 DOM 依赖，便于推理）：优先边，空间不足翻转，全程夹在视口内。 */
function place(
  anchor: AnchorRect,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { side: PopoverSide; align: PopoverAlign; gap: number; padding: number; width?: number | 'anchor' | 'boundary'; maxHeight?: number },
): Position {
  const availableWidth = Math.max(0, viewport.width - opts.padding * 2)
  const requestedWidth = opts.width === 'anchor' ? anchor.width : opts.width === 'boundary' ? availableWidth : opts.width
  const width = Math.min(requestedWidth ?? popover.width, availableWidth)
  const wanted = opts.side === 'left' || opts.side === 'right' ? width : Math.min(opts.maxHeight ?? Number.POSITIVE_INFINITY, popover.height)
  const room = (side: PopoverSide): number => {
    if (side === 'top') return anchor.top - opts.gap - opts.padding
    if (side === 'bottom') return viewport.height - anchor.bottom - opts.gap - opts.padding
    if (side === 'left') return anchor.left - opts.gap - opts.padding
    return viewport.width - anchor.right - opts.gap - opts.padding
  }
  const preferredRoom = room(opts.side)
  const oppositeRoom = room(OPPOSITE[opts.side])
  const side = preferredRoom >= wanted || oppositeRoom <= preferredRoom ? opts.side : OPPOSITE[opts.side]

  const crossStart = (start: number, end: number, length: number): number => {
    if (opts.align === 'start') return start
    if (opts.align === 'end') return end - length
    return start + (end - start) / 2 - length / 2
  }

  if (side === 'bottom' || side === 'top') {
    const left = clamp(
      crossStart(anchor.left, anchor.right, width),
      opts.padding,
      viewport.width - width - opts.padding,
    )
    const available = Math.max(room(side), 0)
    const maxHeight = Math.min(opts.maxHeight ?? Number.POSITIVE_INFINITY, available)
    if (side === 'bottom') return { side, left, top: anchor.bottom + opts.gap, width, maxHeight }
    return { side, left, bottom: viewport.height - anchor.top + opts.gap, width, maxHeight }
  }

  const height = Math.min(popover.height, opts.maxHeight ?? Number.POSITIVE_INFINITY, viewport.height - opts.padding * 2)
  const top = clamp(
    crossStart(anchor.top, anchor.bottom, height),
    opts.padding,
    viewport.height - height - opts.padding,
  )
  const rawLeft = side === 'right' ? anchor.right + opts.gap : anchor.left - opts.gap - width
  return {
    side,
    left: clamp(rawLeft, opts.padding, viewport.width - width - opts.padding),
    top,
    width,
    maxHeight: Math.min(opts.maxHeight ?? Number.POSITIVE_INFINITY, viewport.height - top - opts.padding),
  }
}

/**
 * 锚定浮层：portal 到 body（不受局部 stacking context 限制），
 * 视口翻转 + 边缘钳制，从锚定边生长的动画（见 index.css .popover-open）。
 */
export function Popover({
  anchor,
  boundary,
  side = 'bottom',
  align = 'start',
  gap = DEFAULT_GAP,
  padding = DEFAULT_PADDING,
  width,
  maxHeight,
  layer = LAYER.popover,
  className,
  style,
  autoFocus = false,
  onDismiss,
  dismissOnEscape = true,
  ignore,
  children,
}: PopoverProps) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<Position | null>(null)

  const reposition = useCallback(() => {
    const frame = frameRef.current
    const rect = anchorRect(anchor)
    if (!frame || !rect) return
    const boundaryRect = anchorRect(boundary ?? null)
    const bounds = {
      left: Math.max(0, boundaryRect?.left ?? 0),
      top: Math.max(0, boundaryRect?.top ?? 0),
      right: Math.min(window.innerWidth, boundaryRect?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, boundaryRect?.bottom ?? window.innerHeight),
    }
    const next = place({
      ...rect,
      left: rect.left - bounds.left,
      right: rect.right - bounds.left,
      top: rect.top - bounds.top,
      bottom: rect.bottom - bounds.top,
    }, { width: frame.offsetWidth, height: Math.max(frame.offsetHeight, frame.scrollHeight) }, {
      width: Math.max(0, bounds.right - bounds.left),
      height: Math.max(0, bounds.bottom - bounds.top),
    }, { side, align, gap, padding, width, maxHeight })
    next.left += bounds.left
    if (next.top !== undefined) next.top += bounds.top
    if (next.bottom !== undefined) next.bottom += window.innerHeight - bounds.bottom
    setPosition((previous) => previous && previous.side === next.side && previous.left === next.left && previous.top === next.top && previous.bottom === next.bottom && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next)
  }, [anchor, boundary, side, align, gap, padding, width, maxHeight])

  useLayoutEffect(() => {
    reposition()
  }, [reposition])

  useEffect(() => {
    if (autoFocus && frameRef.current) frameRef.current.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!onDismiss) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (frameRef.current?.contains(target)) return
      if (ignore && target instanceof Element && target.closest(ignore)) return
      // Nested menus live in body portals; higher overlay layers remain inside the interaction stack.
      const portal = target instanceof Element ? target.closest<HTMLElement>('.popover-portal') : null
      if (portal && Number(portal.style.zIndex) > layer) return
      onDismiss('outside')
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onDismiss, ignore, layer])

  // Esc 不再自挂监听:入 overlay 栈,由 KeyboardProvider 按层高分发给栈顶
  // (docs/keyboard-architecture.md ③;层高者优先取代注册顺序即优先级)。
  useUiOverlayDismiss({ active: Boolean(onDismiss) && dismissOnEscape, layer, onDismiss: (reason) => onDismiss?.(reason) })

  useEffect(() => {
    const onScrollOrResize = () => reposition()
    window.addEventListener('resize', onScrollOrResize)
    window.addEventListener('scroll', onScrollOrResize, true)
    const observer = new ResizeObserver(onScrollOrResize)
    if (frameRef.current) observer.observe(frameRef.current)
    for (const target of [anchor, boundary]) {
      const element = target instanceof HTMLElement ? target : target && 'current' in target ? target.current : null
      if (element) observer.observe(element)
    }
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onScrollOrResize)
      window.removeEventListener('scroll', onScrollOrResize, true)
    }
  }, [reposition])

  if (!anchorRect(anchor)) return null

  return createPortal(
    <div className="popover-portal" style={{ zIndex: layer, left: position?.left, top: position?.top, bottom: position?.bottom }}>
      <div
        ref={frameRef}
        tabIndex={-1}
        data-popover-side={position?.side}
        className={cn(
          // ui-menu 提供表面色/描边/阴影/圆角/内边距；popover-open（_app.scss）提供生长动画；
          // popover-frame 负责裁剪内容与去焦点描边。
          'ui-menu popover-open popover-frame',
          className,
        )}
        style={{
          boxSizing: 'border-box',
          width: position?.width,
          maxHeight: position?.maxHeight,
          ...style,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

/**
 * 视口翻转后需要重新监听外部点击的辅助导出(ContextMenu 使用);
 * Esc 同样由 useOverlayDismiss 入栈接管。
 */
export function useOutsideDismiss(
  active: boolean,
  onDismiss: (reason: 'outside' | 'escape') => void,
  containerRef: RefObject<HTMLElement | null>,
  ignore?: string,
): void {
  useEffect(() => {
    if (!active) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (containerRef.current?.contains(target)) return
      if (ignore && (target as Element).matches?.(ignore)) return
      onDismiss('outside')
    }
    window.addEventListener('pointerdown', onPointer, true)
    return () => window.removeEventListener('pointerdown', onPointer, true)
  }, [active, onDismiss, containerRef, ignore])
  useUiOverlayDismiss({ active, layer: LAYER.popover, onDismiss })
}
