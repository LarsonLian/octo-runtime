import type { MessageView } from '@shared/work-state'
import type { MessageID } from '@shared/i18n'
import { useT } from '@/lib/i18n'
import { currentActivity } from './execution-process'
import './team-progress.scss'

const labels: Record<string, MessageID> = {
  waiting_approval: 'chat.team.confirmation', waiting_input: 'chat.team.input',
  approval_submitted: 'chat.team.confirming', thinking: 'chat.team.thinking',
  responding: 'chat.team.responding', executing_tool: 'chat.team.working',
  finishing: 'chat.team.finishing', completed: 'chat.team.finished',
  failed: 'chat.team.failed', cancelled: 'chat.team.stopped', stopped: 'chat.team.stopped',
}
const terminal = (status: string) => ['completed', 'failed', 'cancelled', 'stopped'].includes(status)

/** Local aggregation of Worker presentation; never changes the authoritative Team status. */
export function TeamProgress({ members, status }: { members: MessageView[]; status: string }) {
  const t = useT()
  const settled = terminal(status)
  const active = [...members].reverse().find(m => !terminal(m.status ?? ''))
  const memberActivity = (member: MessageView) =>
    currentActivity(member, member.status === 'streaming' ? 'running' : member.status ?? 'queued')

  const label = (member: MessageView) => {
    if (member.transportError) return t('chat.team.disconnected', { name: member.author ?? t('partner.category.agent') })
    const activity = memberActivity(member)
    return t(labels[member.status ?? ''] ?? labels[activity ?? ''] ?? 'chat.team.working', { name: member.author ?? t('partner.category.agent') })
  }
  const headline = settled ? t(status === 'completed' ? 'chat.team.completed' : status === 'failed' ? 'chat.team.taskFailed' : 'chat.team.taskStopped') : active ? label(active) : t('chat.team.waitingNext')

  const memberStatusKind = (member: MessageView): 'failed' | 'waiting' | 'normal' => {
    if (member.transportError || member.status === 'stopped') return 'failed'
    const activity = memberActivity(member)
    if (activity === 'waiting_approval' || activity === 'waiting_input') return 'waiting'
    if (activity === 'disconnected') return 'failed'
    return 'normal'
  }

  return <div className="team-progress">
    <p className="team-progress__current" role="status" aria-live="polite" aria-atomic="true">{headline}</p>
    {members.length > 0 && <details><summary>{t('chat.team.progress')}</summary>
      <ol>{members.map((member, index) => {
        const latest = [...(member.items ?? [])].reverse().find(item => item.kind === 'text' && item.channel !== 'analysis' && item.text.trim())
        const kind = memberStatusKind(member)
        return <li key={member.executionId ?? member.id} className={`team-progress__item is-${kind}`}>
          {index > 0 && <p className="team-progress__handoff">{t('chat.team.handoff', { from: members[index - 1].author ?? t('partner.category.agent'), to: member.author ?? t('partner.category.agent') })}</p>}
          <div className="team-progress__member-line">
            <span className="team-progress__member-label">{label(member)}</span>
          </div>
          {latest?.kind === 'text' && <p className="team-progress__summary">{latest.text.slice(-240)}</p>}
        </li>
      })}</ol>
    </details>}
  </div>
}
