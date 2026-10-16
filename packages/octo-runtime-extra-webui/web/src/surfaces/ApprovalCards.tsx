import { useEffect, useId, useRef, useState } from 'react'
import { Check, CornerDownLeft, Hand, MessageCircleQuestion, Send, X } from 'lucide-react'
import { Button } from '@/components/Button'
import type { OwnerSubject } from '@shared/contracts'
import type { ApprovalView } from '@shared/work-state'
import { interactionQuestions } from '@shared/work-state'
import type { InteractionResponse as RespondInteractionInput } from '@mininglamp-oss/octo-runtime-protocol'
import { octoWork, ipcErrorMessage } from '@/lib/bridge'
import { useT } from '@/lib/i18n'
import './run-context.scss'

export function ApprovalCards({ interactions, owner, connected = true, onResponsePending }: { interactions: ApprovalView[]; owner: OwnerSubject; connected?: boolean; onResponsePending?: (interactionId: string, pending: boolean) => void }) {
  const t = useT()
  const [selected, setSelected] = useState<string>()
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const requests = [...new Map(interactions.map((interaction) => [interaction.interactionId, interaction])).values()]
    .filter((interaction) => interaction.status === 'pending' && interaction.actionable)
  const pending = requests.filter((interaction) => !hidden.has(interaction.interactionId))
  const active = pending.find((interaction) => interaction.interactionId === selected) ?? pending[0]
  return <section className="approval-cards" hidden={!pending.length} aria-label={t('chat.composer.approvalLabel')}>{requests.map((interaction) => <ApprovalCard key={`${owner.type}/${owner.id}/${interaction.interactionId}`} interaction={interaction} owner={owner} connected={connected}
    onResponsePending={(value) => {
      setHidden(previous => {
        const next = new Set(previous)
        if (value) next.add(interaction.interactionId)
        else next.delete(interaction.interactionId)
        return next
      })
      onResponsePending?.(interaction.interactionId, value)
    }}
    expanded={interaction.interactionId === active?.interactionId} onSelect={() => setSelected(interaction.interactionId)} />)}</section>
}

function ApprovalCard({ interaction, owner, connected, expanded, onSelect, onResponsePending }: { interaction: ApprovalView; owner: OwnerSubject; connected: boolean; expanded: boolean; onSelect: () => void; onResponsePending: (pending: boolean) => void }) {
  const t = useT()
  const [decision, setDecision] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [queriedStatus, setQueriedStatus] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const panel = useRef<HTMLElement | null>(null)
  const submitting = useRef(false)
  const titleId = useId()
  useEffect(() => {
    if (!expanded) return
    const previous = document.activeElement as HTMLElement | null
    const element = panel.current
    element?.focus()
    return () => {
      if (element?.contains(document.activeElement) || element && !element.isConnected && document.activeElement === document.body) previous?.focus()
    }
  }, [expanded])
  useEffect(() => {
    if (!interaction.expiresAt || !interaction.actionable) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [interaction.expiresAt, interaction.actionable])
  const deadline = interaction.expiresAt ? Date.parse(interaction.expiresAt) : undefined
  const expired = deadline !== undefined && (!Number.isFinite(deadline) || deadline <= now)
  const status = interaction.status === 'pending' ? queriedStatus ?? interaction.status : interaction.status
  const actionable = interaction.actionable && status === 'pending' && !expired && connected
  const respond = async (outcome: RespondInteractionInput['outcome'], optionId?: string, value?: Record<string, unknown>) => {
    const choice = optionId ?? outcome
    if (submitting.current || busy || !actionable || (decision && (decision !== choice || !error))) return
    submitting.current = true
    setDecision(choice)
    setBusy(true)
    setError('')
    onResponsePending(true)
    try {
      const response = await octoWork.agentAccess.respondInteraction({ owner, interactionId: interaction.interactionId, outcome, ...(value ? { value } : optionId ? { value: { optionId } } : {}) })
      setQueriedStatus(response.status)
    } catch (cause) {
      setError(ipcErrorMessage(cause, t('chat.composer.approvalUnknown')))
      let restoreCard = true
      try {
        const current = await octoWork.agentAccess.getInteraction({ owner, interactionId: interaction.interactionId })
        setQueriedStatus(current.status)
        restoreCard = current.status === 'pending'
      } catch {
        setError(t('chat.composer.approvalQueryFailed'))
      }
      if (restoreCard) onResponsePending(false)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const provider = interaction.request?.providerDetails as Record<string, unknown> | undefined
  const native = provider?.provider === 'openclaw'
  const options = native && Array.isArray(provider.options) ? provider.options as { kind: string; optionId: string }[] : []
  const allow = native ? options.find(option => option.kind === 'allow_once' && option.optionId === 'allow-once') : undefined
  const always = native ? options.find(option => option.kind === 'allow_always' && option.optionId === 'allow-always') : undefined
  const deny = native ? options.find(option => option.kind === 'reject_once' && option.optionId === 'deny') : undefined
  const allowedOutcomes = interaction.request?.allowedOutcomes
  const canAllow = native ? Boolean(allow) : !Array.isArray(allowedOutcomes) || allowedOutcomes.includes('accepted')
  const canDeny = native ? Boolean(deny) : !Array.isArray(allowedOutcomes) || allowedOutcomes.includes('declined')
  const reason = typeof provider?.reason === 'string' ? provider.reason : ''
  const cwd = typeof provider?.cwd === 'string' ? provider.cwd : ''
  const summary = typeof provider?.command === 'string' && provider.command ? provider.command : interaction.summary || t('chat.composer.approvalSummary')
  const description = typeof provider?.description === 'string' ? provider.description : ''
  const label = status === 'resolved' && ['accepted', 'declined'].includes(interaction.decisionOutcome ?? '')
    ? t(interaction.decisionOutcome === 'declined' ? 'chat.composer.approvalDenied' : 'chat.composer.approvalAllowed')
    : connected && !expired && ['pending', 'responding'].includes(status) && decision && !error ? t('chat.composer.approvalResponding')
      : actionable ? t('shell.session.waitingApproval')
        : t('chat.composer.approvalUnavailable', { reason: !connected ? 'connection_lost' : expired ? 'expired' : interaction.reasonCode ?? status })
  const locked = (choice: string) => !actionable || busy || Boolean(decision && (decision !== choice || !error))
  const questions = interactionQuestions(interaction.request)
  const answers = Object.fromEntries(questions.map(question => [question.id, { answers: [selections[question.id], drafts[question.id]?.trim()].filter((answer): answer is string => Boolean(answer)) }]))
  const complete = questions.length > 0 && questions.every(question => answers[question.id].answers.length > 0)
  // Keep the component mounted for the response/recovery, but remove its card immediately.
  if (busy || decision && !error || status !== 'pending') return null
  if (interaction.kind === 'question') return <article className="approval-request question-request" data-interaction-id={interaction.interactionId}>
    {expanded ? <form ref={element => { panel.current = element }} tabIndex={-1} aria-labelledby={titleId} className="approval-request__panel"
      onSubmit={event => { event.preventDefault(); if (complete) void respond('answered', undefined, { answers }) }}>
      <div className="approval-request__heading"><MessageCircleQuestion size={18} aria-hidden /><span id={titleId}>{t('chat.question.title')}</span>
        {!connected || expired ? <span role="status">{label}</span> : null}</div>
      <div className="approval-request__body">
        {questions.map(question => <fieldset className="question-request__field" key={question.id} disabled={locked('answered')}>
          <legend>{question.question}</legend>
          {question.options.map((option, index) => <label className="question-request__option" key={index}>
            <input type="radio" name={`${interaction.interactionId}/${question.id}`} value={option.label} checked={selections[question.id] === option.label}
              onChange={() => setSelections(previous => ({ ...previous, [question.id]: option.label }))} />
            <span>{option.label}{option.description && <small>{option.description}</small>}</span>
          </label>)}
          {(question.isOther || !question.options.length) && <label className="question-request__input">
            <span>{t(question.options.length ? 'chat.question.additional' : 'chat.question.answer')}</span>
            {question.isSecret ? <input type="password" autoComplete="off" value={drafts[question.id] ?? ''} onChange={event => setDrafts(previous => ({ ...previous, [question.id]: event.target.value }))} />
              : <textarea rows={2} value={drafts[question.id] ?? ''} onChange={event => setDrafts(previous => ({ ...previous, [question.id]: event.target.value }))} />}
          </label>}
        </fieldset>)}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="approval-request__actions">
        <Button size="sm" disabled={locked('cancelled')} onClick={() => void respond('cancelled')}><X size={14} aria-hidden />{t('chat.question.cancel')}</Button>
        <Button size="sm" variant="primary" type="submit" disabled={locked('answered') || !complete}><Send size={14} aria-hidden />{t('chat.question.submit')}</Button>
      </div>
    </form> : <div className="approval-audit__row"><MessageCircleQuestion size={14} aria-hidden /><span className="approval-audit__summary">{questions[0]?.question}</span><Button size="xs" onClick={onSelect}>{t('chat.composer.approvalReview')}</Button></div>}
  </article>
  return <article className={expanded ? 'approval-request' : 'approval-audit'} data-interaction-id={interaction.interactionId}>
    {expanded ? <div ref={element => { panel.current = element }} tabIndex={-1} role="alertdialog" aria-modal="false" aria-labelledby={titleId} className="approval-request__panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && canDeny && !locked(deny?.optionId ?? 'declined')) { event.preventDefault(); event.stopPropagation(); void respond('declined', deny?.optionId) }
        if (event.key === 'Enter' && event.target === event.currentTarget && canAllow && !locked(allow?.optionId ?? 'accepted')) { event.preventDefault(); event.stopPropagation(); void respond('accepted', allow?.optionId) }
      }}>
      <div className="approval-request__heading"><Hand size={18} aria-hidden /><span>{t('chat.composer.approvalPermission')}</span><span className="approval-request__badge" role="status">{label}</span></div>
      <div className="approval-request__body"><h3 id={titleId}>{reason || t('chat.composer.approvalQuestion')}</h3>
      <pre className="approval-request__command">{summary}</pre>
      {cwd && <p className="approval-request__directory">{t('chat.composer.approvalDirectory')} <span>{cwd}</span></p>}
      {description && <p className="approval-request__directory">{t('chat.composer.approvalHost')} <span>{description}</span></p>}
      {deadline !== undefined && !expired && <p className="approval-request__directory">{t('chat.composer.approvalExpiresIn', { seconds: Math.max(0, Math.ceil((deadline - now) / 1000)) })}</p>}
      {always && <p className="approval-request__directory">{t('chat.composer.approvalAlwaysHint')}</p>}
      {interaction.request && <details className="approval-request__details"><summary>{t('chat.composer.approvalDetails')}</summary><pre>{JSON.stringify(interaction.request, null, 2)}</pre></details>}
      {error && <p role="alert">{error}</p>}</div>
      <div className="approval-request__actions">
        {canDeny && <Button size="sm" disabled={locked(deny?.optionId ?? 'declined')} onClick={() => void respond('declined', deny?.optionId)}><X size={14} aria-hidden />{t('chat.composer.approvalDecline')}<kbd>Esc</kbd></Button>}
        {always && <Button size="sm" disabled={locked(always.optionId)} onClick={() => void respond('accepted', always.optionId)}>{t('chat.composer.approvalAcceptAlways')}</Button>}
        {canAllow && <Button size="sm" variant="primary" disabled={locked(allow?.optionId ?? 'accepted')} onClick={() => void respond('accepted', allow?.optionId)}><Check size={14} aria-hidden />{t('chat.composer.approvalAcceptOnce')}<kbd><CornerDownLeft size={14} aria-hidden /></kbd></Button>}
      </div>
    </div> : <div className="approval-audit__row"><Hand size={14} aria-hidden /><span className="approval-audit__status">{label}</span><span className="approval-audit__summary" title={summary}>{summary}</span>
      {actionable && <Button size="xs" onClick={onSelect}>{t('chat.composer.approvalReview')}</Button>}
    </div>}
  </article>
}
