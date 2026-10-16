import { Check, CircleDashed } from 'lucide-react'
import { useT } from '@/lib/i18n'
import type { MessageID } from '@shared/i18n'
import type { MessageView } from '@shared/work-state'

export function ExecutionExperience({ message }: { message: MessageView; status: string; settled: boolean }) {
  const translate = useT()
  const experience = message.experience
  const noticeKeys: Record<string, MessageID> = {
    context_compacted: 'chat.notice.contextCompacted', retry_scheduled: 'chat.notice.retryScheduled',
    model_rerouted: 'chat.notice.modelRerouted', config_warning: 'chat.notice.configWarning',
  }
  const reasoningNoticeKeys: Record<string, MessageID> = {
    REASONING_EFFORT_NOT_APPLIED: 'chat.notice.reasoningNotApplied',
    REASONING_EFFORT_DOWNGRADED: 'chat.notice.reasoningDowngraded',
  }
  return (
    <div className="execution-experience">
      {experience?.plans.map(plan => (
        <div key={String(plan.planId)} className="execution-plan" aria-label={translate('chat.activity.plan')}>
          <span className="execution-plan__title">{translate('chat.activity.plan')}</span>
          {typeof plan.explanation === 'string' && plan.explanation && <p>{plan.explanation}</p>}
          <ol>
            {(Array.isArray(plan.steps) ? plan.steps : []).map((step: Record<string, unknown>, index: number) => (
              <li key={index} className={step.status === 'completed' ? 'execution-plan__done' : undefined}>
                {step.status === 'completed' ? <Check size={13} aria-hidden /> : <CircleDashed size={13} aria-hidden />}
                <span>{String(step.text ?? '')}</span>
                {step.status === 'in_progress' && <span className="execution-plan__state">{translate('chat.activity.inProgress')}</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
      {experience?.notices.map(notice => noticeKeys[String(notice.code)] && <p key={String(notice.noticeId)} className="execution-notice">{translate((notice.code === 'config_warning' && reasoningNoticeKeys[String((notice.params as Record<string, unknown> | undefined)?.warningCode)]) || noticeKeys[String(notice.code)])}</p>)}

    </div>
  )
}
