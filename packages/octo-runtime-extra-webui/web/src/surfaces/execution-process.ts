import type { MessageView, PresentationItemView, TextItemView } from '@shared/work-state'

export type ProcessSegment = { kind: 'body'; item: TextItemView } | { kind: 'group'; id: string; items: PresentationItemView[] }

export function processSegments(items: PresentationItemView[]): ProcessSegment[] {
  const unique = new Map<string, PresentationItemView>()
  for (const item of items) {
    const previous = unique.get(item.id)
    if (!previous || item.contentVersion >= previous.contentVersion) unique.set(item.id, item)
  }
  const segments: ProcessSegment[] = [{ kind: 'group', id: 'start', items: [] }]
  for (const item of [...unique.values()].sort((left, right) => left.firstSeq - right.firstSeq || left.id.localeCompare(right.id))) {
    if (item.kind === 'text' && item.channel !== 'analysis') {
      segments.push({ kind: 'body', item }, { kind: 'group', id: `after:${item.id}`, items: [] })
    } else {
      const group = segments.at(-1)
      if (group?.kind === 'group') group.items.push(item)
    }
  }
  return segments
}

export function currentActivity(message: MessageView | undefined, status: string): string | undefined {
  if (message?.transportError || status === 'disconnected') return 'disconnected'
  if (status === 'cancelling') return 'cancelling'
  const responses = message?.approvalResponses ?? {}
  const unanswered = message?.interactions?.filter(item => item.status === 'pending' && item.actionable && !responses[item.interactionId]) ?? []
  if (unanswered.length) return unanswered.every(item => item.kind === 'question') ? 'waiting_input' : 'waiting_approval'
  if (Object.values(responses).includes('pending')) return 'approval_submitted'
  const priorities = ['waiting_approval', 'waiting_input', 'retrying', 'compacting', 'executing_tool', 'thinking', 'responding', 'starting', 'working']
  const running = message?.experience?.activities.filter(activity => activity.status === 'running') ?? []
  const kind = [...running].sort((left, right) => {
    const priority = (kind: unknown) => {
      const index = priorities.indexOf(String(kind))
      return index < 0 ? priorities.length : index
    }
    return priority(left.kind) - priority(right.kind)
  })[0]?.kind as string | undefined
  if (kind === 'waiting_approval' || status === 'interacting') {
    if (message?.interactions?.some(item => item.status === 'responding' && !responses[item.interactionId])) return 'approval_submitted'
    if (Object.keys(responses).length) return kind && kind !== 'waiting_approval' ? kind : 'thinking'
  }
  return status === 'interacting' && kind !== 'waiting_approval' ? 'waiting_input' : kind
}

export function activeItem(status: string): boolean {
  return ['streaming', 'running', 'queued', 'created', 'in_progress'].includes(status)
}

export function thinkingPreview(items: PresentationItemView[]): string | undefined {
  const latestToolSeq = Math.max(-1, ...items.filter(item => item.kind === 'tool').map(item => item.firstSeq))
  const thought = items.filter((item): item is TextItemView => item.kind === 'text' && item.channel === 'analysis'
    && item.firstSeq > latestToolSeq && Boolean(item.text.trim()))
    .sort((left, right) => right.firstSeq - left.firstSeq)[0]
  if (!thought) return undefined
  // Show the current summary paragraph; the disclosure keeps the complete Markdown.
  const paragraph = thought.text.trim().split(/\n\s*\n/).at(-1) ?? ''
  return paragraph.replace(/(^|\n)\s*(?:#{1,6}\s+|>\s*)/g, '$1')
    .replace(/\*\*|__/g, '').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim() || undefined
}

export { toolAction } from './tool-presentation'
