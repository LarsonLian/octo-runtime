import type { ExecutionEvent } from '@shared/contracts'

/**
 * Presentation 事件合帧器（自 buddy-demo 原样移植）。
 *
 * rAF 合帧 + append-only patch merge；snapshot / reset / revoked 立即透传并
 * 丢弃旧队列（旧 baseline 已失效）；commit 等其余事件先 flush 队列再透传。
 */

type FrameHandle = number
type ScheduleFrame = (callback: FrameRequestCallback) => FrameHandle
type CancelFrame = (handle: FrameHandle) => void

export interface PresentationEventBatcher {
  push(event: ExecutionEvent): void
  flush(): void
  dispose(): void
}

export function createPresentationEventBatcher(
  deliver: (event: ExecutionEvent) => void,
  scheduleFrame: ScheduleFrame = requestAnimationFrame,
  cancelFrame: CancelFrame = cancelAnimationFrame,
): PresentationEventBatcher {
  let frame: FrameHandle | undefined
  let queued: ExecutionEvent[] = []

  const flush = (): void => {
    if (frame !== undefined) cancelFrame(frame)
    frame = undefined
    const pending = queued
    queued = []
    pending.forEach(deliver)
  }

  const discard = (): void => {
    if (frame !== undefined) cancelFrame(frame)
    frame = undefined
    queued = []
  }

  const push = (event: ExecutionEvent): void => {
    if (event.type === 'presentation.snapshot'
      || event.type === 'presentation.reset'
      || event.type === 'presentation.revoked') {
      discard()
      deliver(event)
      return
    }

    if (event.type !== 'text.patch' && event.type !== 'tool.patch') {
      flush()
      deliver(event)
      return
    }

    const mergeIndex = findMergeCandidate(queued, event)
    if (mergeIndex >= 0) queued[mergeIndex] = mergePatch(queued[mergeIndex], event)
    else queued.push(event)

    frame ??= scheduleFrame(() => {
      frame = undefined
      const pending = queued
      queued = []
      pending.forEach(deliver)
    })
  }

  return {
    push,
    flush,
    dispose: discard,
  }
}

function findMergeCandidate(queued: ExecutionEvent[], incoming: ExecutionEvent): number {
  const itemId = String(incoming.payload.itemId ?? '')
  const baseContentVersion = Number(incoming.payload.baseContentVersion)
  if (!itemId || !Number.isInteger(baseContentVersion)) return -1

  // Only merge the adjacent tail. Moving a newer seq into an earlier slot
  // makes the reducer discard intervening events below its high-water mark.
  const index = queued.length - 1
  if (index >= 0) {
    const candidate = queued[index]
    if (candidate.executionId !== incoming.executionId
      || candidate.type !== incoming.type
      || String(candidate.payload.itemId ?? '') !== itemId) return -1
    if (Number(candidate.payload.contentVersion) !== baseContentVersion) return -1
    if (incoming.type === 'text.patch') {
      const sameChannel = String(candidate.payload.channel ?? 'final') === String(incoming.payload.channel ?? 'final')
      const appendOnly = String(candidate.payload.op ?? 'append') === 'append'
        && String(incoming.payload.op ?? 'append') === 'append'
      if (!sameChannel || !appendOnly) return -1
    }
    if (incoming.type === 'tool.patch') {
      const bothAuthoritative = hasOwn(candidate.payload, 'input')
        && hasOwn(candidate.payload, 'output')
        && hasOwn(incoming.payload, 'input')
        && hasOwn(incoming.payload, 'output')
      const bothIncremental = candidate.payload.input === undefined && incoming.payload.input === undefined
      if (!bothAuthoritative && !bothIncremental) return -1
    }
    return index
  }
  return -1
}

function mergePatch(first: ExecutionEvent, last: ExecutionEvent): ExecutionEvent {
  const payload = { ...first.payload, ...last.payload }
  payload.baseContentVersion = first.payload.baseContentVersion
  if (last.type === 'text.patch') {
    payload.textDelta = `${String(first.payload.textDelta ?? '')}${String(last.payload.textDelta ?? '')}`
  }
  if (last.type === 'tool.patch') {
    if (last.payload.input === undefined) {
      payload.inputDelta = `${String(first.payload.inputDelta ?? '')}${String(last.payload.inputDelta ?? '')}`
    }
  }
  return {
    ...last,
    payload,
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
