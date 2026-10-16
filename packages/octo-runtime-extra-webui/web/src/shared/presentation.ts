import type { MessageChannel } from '@mininglamp-oss/octo-runtime-protocol'
import type { PresentationItemView } from './work-state'

export type { MessageChannel }

export function messageChannel(value: unknown, previous?: MessageChannel, legacy = false): MessageChannel | undefined {
  if (value === 'analysis' || value === 'commentary' || value === 'final') return value
  if (value === undefined || value === null || value === '') return previous ?? (legacy ? 'final' : undefined)
  return undefined
}

export function presentationItem(value: unknown, fallbackSeq = 0): PresentationItemView | undefined {
  const item = objectRecord(value)
  const id = String(item.itemId ?? item.item_id ?? '')
  if (!id) return undefined
  const kind = String(item.kind ?? item.type ?? '')
  const base = {
    id,
    contentVersion: Number(item.contentVersion ?? item.content_version ?? 0),
    status: String(item.status ?? 'completed'),
    firstSeq: Number(item.firstSeq ?? item.first_seq ?? item.seq ?? fallbackSeq),
  }
  if (kind === 'tool' || kind === 'tool_call') {
    return {
      ...base, kind: 'tool', name: String(item.name ?? item.tool_name ?? 'tool'),
      input: dataText(item.input ?? item.tool_input),
      inputDelta: dataText(item.inputDelta),
      output: dataText(item.output ?? item.tool_output),
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
    }
  }
  if (kind !== 'text' && kind !== 'message' && kind !== 'reasoning') return undefined
  const channel = messageChannel(item.channel, kind === 'reasoning' ? 'analysis' : undefined, true)
  if (!channel || (kind === 'reasoning' && channel !== 'analysis') || !publicAnalysis(channel, item)) return undefined
  return { ...base, kind: 'text', channel, text: String(item.text ?? item.content ?? '') }
}

export function publicAnalysis(channel: MessageChannel, payload: Record<string, unknown>): boolean {
  if (channel !== 'analysis') return true
  const exposure = payload.exposure ?? payload.analysisExposure ?? payload.analysis_exposure
  return exposure === 'public_summary' || exposure === 'public_plan' || exposure === 'public_reasoning'
}

export interface ExecutionTiming {
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
}

export function executionTiming(value: unknown): ExecutionTiming {
  const payload = objectRecord(value)
  const startedAt = timestamp(payload.startedAt ?? payload.started_at)
  const completedAt = timestamp(payload.completedAt ?? payload.completed_at)
  const supplied = payload.elapsedMs ?? payload.elapsed_ms
  const elapsedMs = typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0
    ? supplied
    : startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
      ? completedAt - startedAt : undefined
  return { startedAt, completedAt, elapsedMs }
}

function timestamp(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function dataText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
}
