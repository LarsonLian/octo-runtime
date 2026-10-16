import { TeamProgress } from './TeamProgress'
import { ExecutionExperience } from './ExecutionExperience'
import { ExecutionTimer } from './ExecutionTimer'
import { ActivityLabel } from './ActivityLabel'
import { currentActivity, processSegments, thinkingPreview } from './execution-process'
import { toolPresentation, type ToolAction } from './tool-presentation'
import { useEffect, useId, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot,
  Check,
  Copy,
  ChevronRight,
  FilePenLine,
  FileText,
  FolderOpen,
  Search,
  TerminalSquare,
  Wrench,
  Minus,
  RotateCcw,
  User,
  WifiOff,
  X,
} from 'lucide-react'
import { formatClockTime, formatConversationMessageTime } from '@/lib/format'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { ConversationImagePart, ConversationInputPart, ConversationMessage, OwnerSubject } from '@shared/contracts'
import { octoWork } from '@/lib/bridge'
import './image-input.scss'
import type { MessageID, Translate } from '@shared/i18n'
import {
  executionItems,
  type MessageView,
  type PresentationItemView,
  type TextItemView,
  type ToolView,
} from '@/features/workbench/work-state'

/**
 * 会话转录（transcript）。
 *
 * - 历史消息（main 聚合好的 ConversationMessage）+ 当前会话新执行的 MessageView
 * - 执行过程按源顺序渲染：工具/思考行 mono 小字、运行中呼吸动画（zen 风格）
 * - 执行完成后 Result-Dominance：全部 pre-result items 收进「已完成」折叠，
 *   最终答案无边框大字号，结果永远压制过程证据
 */

/**
 * 执行状态槽位。这里只留码，文案在渲染时查目录——写成模块级
 * `Record<string, string>` 会把语种冻结在 import 那一刻。
 * 未知码原样透出（后端新增状态时不至于显示空白）。
 */
const EXECUTION_STATUS_SLOTS = [
  'queued', 'leased', 'running', 'interacting',
  'cancelling', 'completed', 'failed', 'cancelled',
] as const

const TOOL_ICONS = { command: TerminalSquare, read: FileText, search: Search, change: FilePenLine, list: FolderOpen, tool: Wrench }

function executionStatusLabel(status: string, t: Translate): string {
  return (EXECUTION_STATUS_SLOTS as readonly string[]).includes(status)
    ? t(`chat.execution.status.${status as (typeof EXECUTION_STATUS_SLOTS)[number]}` satisfies MessageID)
    : status
}

/** 运行状态一行字：颜色 + 文字双信号，运行中呼吸。 */
export function ExecutionStatusLine({ status, failureCode, live }: {
  status: string
  failureCode?: string
  live?: boolean
}) {
  const t = useT()
  const failed = status === 'failed'
  const label = executionStatusLabel(status, t)
  return (
    <span
      className={cn('run-status', failed && 'run-status--failed')}
      aria-label={t('chat.execution.statusLabel', { status: label })}
    >
      {live && <span className="run-status__dot status-pulse" aria-hidden />}
      <span className={cn('run-status__label', live && 'status-pulse')}>
        {failureCode ? `${label} · ${failureCode}` : label}
      </span>
    </span>
  )
}

interface TranscriptProps {
  owner?: OwnerSubject | null
  history: ConversationMessage[]
  live: MessageView[]
  executionStatusById?: Record<string, { status: string; failureCode?: string }>
}

export function Transcript({ history, live, executionStatusById, owner }: TranscriptProps) {
  // 去重：live 已经渲染的消息不再从 history 渲染。原实现是 history.filter × live.some
  // 的 O(n²) 双重循环且每次 render 重算（性能审计 1.3）。改为一次性建 Set，查找 O(1)，
  // 并用 useMemo 缓存，仅在 history/live 引用变化时重算。
  const dedupedHistory = useMemo(() => {
    const liveRunKeys = new Set<string>()
    const liveIds = new Set<string>()
    for (const current of live) {
      if (current.executionId) liveRunKeys.add(`${current.role}:${current.executionId}`)
      liveIds.add(current.id)
    }
    return history.filter((message) => !(
      (message.executionId && liveRunKeys.has(`${message.role}:${message.executionId}`))
      || (message.clientMessageId && liveIds.has(`${message.role}:${message.clientMessageId}`))
    ))
  }, [history, live])
  const teamMembers: MessageView[] = [...dedupedHistory.filter(m => m.parentExecutionId).map((m): MessageView => ({
    id: m.id, role: m.role, author: m.agentName ?? '', content: m.text, createdAt: m.createdAt,
    executionId: m.executionId, parentExecutionId: m.parentExecutionId, items: m.items, experience: m.experience,
    interactions: m.interactions, transportError: m.transportError,
    status: m.status === 'cancelled' ? 'stopped' : m.status === 'running' ? 'streaming' : m.status,
  })), ...live.filter(m => m.parentExecutionId)]
  return (
    <div className="transcript-list">
      {dedupedHistory.map((message) => (
        <HistoryMessage key={message.id} message={message} owner={owner} teamMembers={teamMembers.filter(m => m.parentExecutionId === message.executionId)} />
      ))}
      {live.map((message) => (
        <LiveMessage
          key={message.id}
          message={message}
          teamMembers={teamMembers.filter(m => m.parentExecutionId === message.executionId)}
          owner={owner}
          executionStatus={message.executionId ? executionStatusById?.[message.executionId] : undefined}
        />
      ))}
    </div>
  )
}

/** 历史消息：main 已聚合好，user 右对齐气泡 / assistant 渲染最终答案。 */
function HistoryMessage({ message, owner, teamMembers }: { message: ConversationMessage; owner?: OwnerSubject | null; teamMembers: MessageView[] }) {
  const t = useT()
  if (message.role === 'system') return <p className="conversation-control" role="status">{message.text}</p>
  if (message.role === 'user') {
    return <UserBubble text={message.text} parts={message.parts} owner={owner} createdAt={message.createdAt} />
  }
  if (message.executionId) return <LiveMessage message={{
    teamRole: message.teamRole, id: message.id, role: message.role, author: message.agentName ?? t('chat.turn.assistant'), content: message.text,
    createdAt: message.createdAt, executionId: message.executionId,
    status: message.status === 'cancelled' ? 'stopped' : message.status === 'running' ? 'streaming' : message.status,
    items: message.items, experience: message.experience, modelSteps: message.modelSteps, transportError: message.transportError,
    interactions: message.interactions,
    startedAt: message.startedAt, completedAt: message.completedAt, elapsedMs: message.elapsedMs,
    terminalContentReady: message.terminalContentReady ?? true,
    stopRequestedByUser: message.stopRequestedByUser,
    failureMessage: message.failureMessage,
  }} owner={owner} teamMembers={teamMembers} executionStatus={{ status: message.executionStatus ?? message.status, failureCode: message.failureCode }} />
  return (
    <div className="turn transcript-turn">
      <TurnMeta
        author={message.agentName ?? t('chat.turn.assistant')}
        createdAt={message.createdAt}
        status={message.status}
      />
      {message.text
        ? <div className="exec-answer"><ResultCopy text={message.text} /><AnswerFooter text={message.text} createdAt={message.createdAt} /></div>
        : <p className="turn-empty">{t('chat.turn.noAnswer')}</p>}
    </div>
  )
}

/** 当前会话新执行的消息。 */
function LiveMessage({ message, executionStatus, owner, teamMembers = [] }: {
  teamMembers?: MessageView[]
  message: MessageView
  owner?: OwnerSubject | null
  executionStatus?: { status: string; failureCode?: string }
}) {
  if (message.role === 'system') return <p className="conversation-control" role="status">{message.content}</p>
  if (message.role === 'user') {
    return <UserBubble text={message.content} parts={message.parts} owner={owner} createdAt={message.createdAt} />
  }
  const reportedStatus = executionStatus?.status ?? message.status ?? 'streaming'
  const hasStarted = message.startedAt !== undefined || message.items?.some(item => ['running', 'streaming', 'in_progress', 'completed', 'failed', 'error'].includes(item.status))
  const status = hasStarted && (reportedStatus === 'queued' || reportedStatus === 'leased') ? 'running' : reportedStatus
  const live = status === 'running' || status === 'queued' || status === 'leased'
    || status === 'interacting' || status === 'cancelling'
  return (
    <div className={cn('turn transcript-turn', live && 'turn-live')}>
      {message.teamRole && <TurnMeta author={message.author} createdAt={message.createdAt} status={status} failureCode={executionStatus?.failureCode} live={live} showCompleted />}
      {message.teamRole === 'summary' && <TeamProgress members={teamMembers} status={status} />}
      <AssistantExecution message={message} status={status} failureCode={executionStatus?.failureCode} />
    </div>
  )
}

function TurnMeta({ author, createdAt, status, failureCode, live, showCompleted }: {
  /** `null` = 本人（见 MessageView.author）：署名在这一层取译文。 */
  author: string | null
  createdAt?: number
  status?: string
  failureCode?: string
  live?: boolean
  showCompleted?: boolean
}) {
  const t = useT()
  return (
    <div className="turn-meta">
      <Bot size={12} aria-hidden />
      <span className="turn-meta__author">{author ?? t('chat.turn.you')}</span>
      {typeof createdAt === 'number' && <span>{formatClockTime(createdAt)}</span>}
      {status && (showCompleted || status !== 'completed') && (
        <ExecutionStatusLine status={status} failureCode={failureCode} live={live} />
      )}
    </div>
  )
}

/** 用户消息：右对齐浅色气泡。 */
function UserBubble({ text, parts, owner, createdAt }: { text: string; parts?: ConversationInputPart[]; owner?: OwnerSubject | null; createdAt?: number }) {
  return (
    <div className="turn transcript-turn transcript-turn--user">
      <div className="user-bubble">
        <div className="user-bubble__body">
          {parts?.some((part) => part.type === 'image') && <div className="user-bubble__images">{parts.filter((part): part is ConversationImagePart => part.type === 'image').map((part) => <ConversationImage key={part.id} part={part} owner={owner} />)}</div>}
          {text && <pre className="user-bubble__text">{text}</pre>}
        </div>
        <span className="user-bubble__meta">
          <User size={10} aria-hidden />
          {typeof createdAt === 'number' && formatClockTime(createdAt)}
        </span>
      </div>
    </div>
  )
}

function ConversationImage({ part, owner }: { part: ConversationImagePart; owner?: OwnerSubject | null }) {
  const t = useT()
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setSrc('')
    setFailed(false)
    if (owner && typeof octoWork?.readConversationImage === 'function') void octoWork.readConversationImage({ owner, resourceId: part.artifact.artifact_id }).then((url) => { if (active) setSrc(url) }).catch(() => { if (active) setFailed(true) })
    else setFailed(true)
    return () => { active = false }
  }, [owner?.type, owner?.id, part.artifact.artifact_id, retry])
  return <div className="user-bubble__image">
    {src ? <img src={src} alt={part.name || t('chat.composer.images')} onError={() => { setSrc(''); setFailed(true) }} /> : failed ? <button type="button" title={t('chat.composer.imageUnavailable')} onClick={() => setRetry((previous) => previous + 1)}><RotateCcw size={14} aria-hidden />{t('chat.blocked.retry')}</button> : <span role="status">{t('chat.composer.imageReading')}</span>}
  </div>
}

/** 助手执行区：执行中按源顺序渲染；完成后 Result-Dominance 折叠。 */
function AssistantExecution({ message, status, failureCode }: {
  message: MessageView
  status: string
  failureCode?: string
}) {
  const t = useT()
  const items = message.items ?? []
  const settled = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stopped'
  const manuallyStopped = (status === 'cancelled' || status === 'stopped') && message.stopRequestedByUser === true
  const { processItems, answerItems } = executionItems(message)

  if (message.sendError) {
    return <ErrorLine text={t('chat.turn.sendFailed', { message: message.sendError })} />
  }

  return (
    <div className="exec-body" data-execution-id={message.executionId} data-execution-status={status}>
      {status === 'failed' && <ErrorLine text={runFailedText(failureCode, t)} detail={message.failureMessage} />}
      {(status === 'cancelled' || status === 'stopped') && !manuallyStopped && <p className="exec-cancelled">{t('chat.execution.cancelledNotice')}</p>}
      {message.teamRole !== 'summary' && <CompletedProcessFold items={settled ? processItems : items} settled={settled} elapsedMs={message.elapsedMs} manuallyStopped={manuallyStopped} message={message} status={status} />}
      {settled && answerItems.length > 0 ? (
        <div className="exec-answer" aria-label={t(status === 'failed' || status === 'cancelled' || status === 'stopped' ? 'chat.presentation.partial' : 'chat.turn.finalAnswer')}>
          {(status === 'failed' || status === 'cancelled' || status === 'stopped') && <p className="exec-partial">{t('chat.presentation.partial')}</p>}
          {answerItems.map((item) => <ResultCopy key={item.id} text={item.text} streaming={!settled && itemRunning(item.status)} />)}
          {settled && <AnswerFooter text={answerItems.map((item) => item.text).join('\n\n')} createdAt={message.createdAt} />}
        </div>
      ) : settled && message.content ? <div className="exec-answer"><ResultCopy text={message.content} /><AnswerFooter text={message.content} createdAt={message.createdAt} /></div> : status === 'completed' && message.terminalContentReady ? (
        <p className="exec-status" role="status">{t('chat.presentation.noAnswer')}</p>
      ) : null}
      <ExecutionExperience message={message} status={status} settled={settled} />
      {message.transportError && items.length > 0 && (
        <div className="exec-notice" role="status">
          <WifiOff size={12} />
          <span className="exec-notice__text">{t('chat.exec.transportBroken', { error: message.transportError })}</span>
        </div>
      )}
    </div>
  )
}

/** 执行失败一行字：有 failureCode 就带上码，没有就只说失败。 */
function runFailedText(failureCode: string | undefined, t: Translate): string {
  return failureCode ? t('chat.execution.failedWithCode', { code: failureCode }) : t('chat.execution.failed')
}

/**
 * 执行中（Active Execution Sequence）：items 按源顺序渲染。
 * 思考行 = 小字 muted 一行 + 呼吸；工具行 = mono「工具名 · 状态」+ chevron 展开。
 */
export function ExecutionSequence({ items, message, status = 'completed', settled = true }: {
  items: PresentationItemView[]; message?: MessageView; status?: string; settled?: boolean
}) {
  const segments = processSegments(items)
  const activity = settled ? undefined : currentActivity(message, status)
  const attention = ['disconnected', 'cancelling', 'waiting_approval', 'approval_submitted', 'waiting_input', 'retrying', 'compacting'].includes(activity ?? '')
  const activeGroup = !attention && activity !== 'thinking' && activity !== 'responding'
    ? segments.reduce((latest, segment, index) => segment.kind === 'group' && segment.items.some(item => item.kind === 'tool' && itemRunning(item.status)) ? index : latest, -1) : -1
  const currentIndex = activeGroup >= 0 ? activeGroup : segments.length - 1
  return <div className="exec-body">
    {segments.map((segment, index) => segment.kind === 'body'
      ? <AnswerItem key={segment.item.id} item={segment.item} variant={segment.item.channel === 'commentary' ? 'progress' : 'result'} />
      : <ProcessGroup key={`${message?.executionId ?? 'run'}:${segment.id}`} items={segment.items}
        message={message} activity={index === currentIndex ? activity : undefined} status={status}
        current={!settled && index === currentIndex} settled={settled} />)}
  </div>
}

function ProcessGroup({ items, message, activity, status, current, settled }: {
  items: PresentationItemView[]; message?: MessageView; activity?: string; status: string; current: boolean; settled: boolean
}) {
  const translate = useT()
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const tools = items.filter((item): item is ToolView => item.kind === 'tool')
  const thoughts = items.filter((item): item is TextItemView => item.kind === 'text' && item.channel === 'analysis')
  const runningTools = !settled ? tools.filter(tool => itemRunning(tool.status)) : []
  const failureCount = tools.filter(tool => ['failed', 'error', 'cancelled'].includes(tool.status)).length
  const attention = ['disconnected', 'cancelling', 'waiting_approval', 'approval_submitted', 'waiting_input', 'retrying', 'compacting'].includes(activity ?? '')
  const thinking = current && !runningTools.length && (activity === 'thinking' || thoughts.some(item => itemRunning(item.status)))
  const streamingBody = message?.items?.some(item => item.kind === 'text' && item.channel !== 'analysis' && itemRunning(item.status))
  const awaitingCompletion = !attention && !thinking && !runningTools.length && !streamingBody
    && (!activity || activity === 'working')
    && message?.items?.some(item => item.kind === 'text' && item.channel === 'final' && item.status === 'completed')
  const progress = message?.experience?.toolProgress.filter(entry => tools.some(tool => tool.id === entry.id)) ?? []
  const hasDetails = tools.length > 1 || tools.some(tool => Boolean(tool.input || tool.output || tool.exitCode !== undefined))
    || thoughts.some(item => item.text.trim()) || progress.length > 0
  const showCurrent = current && (attention || thinking || runningTools.length > 0 || !streamingBody)
  if (!items.length && !showCurrent) return null
  if (!tools.length && !thoughts.some(item => item.text.trim()) && !showCurrent) return null
  const displayedTools = runningTools.length ? runningTools : tools
  const presentations = displayedTools.map(toolPresentation)
  const action = presentations.length > 0 && presentations.every(tool => tool.action === presentations[0].action) ? presentations[0].action : 'tool'
  const target = action !== 'command' && action !== 'tool'
    ? [...new Set(presentations.map(tool => tool.target).filter(Boolean))].join(', ') : ''
  let label: string
  let kind: string = action
  if (showCurrent && (attention || thinking || !runningTools.length)) {
    const keys: Record<string, MessageID> = {
      disconnected: 'chat.exec.transportBroken', cancelling: 'chat.execution.status.cancelling',
      approval_submitted: 'chat.composer.approvalResponding',
      waiting_approval: 'chat.activity.waitingApproval', waiting_input: 'chat.activity.waitingInput',
      retrying: 'chat.presentation.thinkingActive', compacting: 'chat.presentation.thinkingActive',
      thinking: 'chat.presentation.thinkingActive', responding: 'chat.activity.responding', starting: 'chat.presentation.thinkingActive',
      finishing: 'chat.activity.finishing',
      executing_tool: 'chat.activity.executingTool', working: 'chat.presentation.thinkingActive',
    }
    const selected = attention ? activity! : thinking ? 'thinking' : awaitingCompletion ? 'finishing' : activity ?? 'working'
    kind = ['working', 'starting', 'retrying', 'compacting'].includes(selected) ? 'thinking' : selected
    label = (status === 'queued' || status === 'leased') && !message?.startedAt && !items.length
      ? translate('chat.execution.submitted') : translate(keys[selected] ?? 'chat.presentation.thinkingActive', { error: message?.transportError ?? '' })
    if (!attention && selected !== 'responding' && selected !== 'finishing') label = thinkingPreview(items) ?? label
  } else if (displayedTools.length > 1 && !target) {
    label = action === 'command'
      ? translate(`chat.presentation.commands.${runningTools.length ? 'running' : failureCount ? 'failed' : 'completed'}`, { count: displayedTools.length })
      : translate(runningTools.length ? 'chat.presentation.operationsRunning' : 'chat.presentation.operationsCompleted', { count: displayedTools.length })
  } else if (displayedTools.length > 0) {
    label = translate(`chat.presentation.${action}.${runningTools.length ? 'running' : failureCount ? 'failed' : 'completed'}`)
    if (target) label += ` ${target}`
  } else label = translate('chat.presentation.thinkingSummary')
  const busy = current && showCurrent && !attention && status !== 'queued' && status !== 'leased' && status !== 'disconnected' && !message?.transportError
  const Icon = kind === 'thinking' || kind === 'approval_submitted' ? undefined : TOOL_ICONS[action]
  const summary = <>
    {Icon && <Icon className="tool-icon" size={14} strokeWidth={1.75} aria-hidden />}
    <ActivityLabel text={label} busy={busy} announce={current} />
    {failureCount > 0 && <span className="process-summary__failure">{translate('chat.presentation.failedOperations', { count: failureCount })}</span>}
    {hasDetails && <ChevronRight className="tool-chevron" size={12} aria-hidden />}
  </>
  return <div className="process-group" data-process-group>
    {hasDetails ? <button type="button" className="process-summary fold-toggle" aria-expanded={open} aria-controls={bodyId}
      data-activity-kind={current ? kind : undefined} onClick={() => setOpen(value => !value)}>{summary}</button>
      : <div className="process-summary"
        data-activity-kind={current ? kind : undefined}>{summary}</div>}
    {hasDetails && <div id={bodyId} className="process-group__details" hidden={!open}>
      {items.map(item => item.kind === 'tool' ? <ToolCallItem key={item.id} tool={item} showCommand />
        : item.text.trim() ? <div key={item.id} className="thinking-body"><MarkdownBlock text={item.text} /></div> : null)}
      {progress.map(entry => {
        const data = entry.progress as Record<string, unknown> | undefined
        return <div key={String(entry.id)} className="execution-progress">
          {typeof data?.message === 'string' && <span>{data.message}</span>}
          {typeof data?.completed === 'number' && typeof data?.total === 'number' && <span>{data.completed} / {data.total}</span>}
        </div>
      })}
    </div>}
  </div>
}

/**
 * 已完成折叠（Result-Dominance）：全部 pre-result items 收进一个无边框
 * 「已完成 ▸」disclosure，默认折叠；展开后保留各 item 独立折叠（rail 视觉）。
 */
function CompletedProcessFold({ items, settled, elapsedMs, manuallyStopped, message, status }: {
  items: PresentationItemView[]; settled: boolean; elapsedMs?: number; manuallyStopped: boolean; message: MessageView; status: string
}) {
  const [open, setOpen] = useState(!settled)
  const bodyId = useId()
  const t = useT()
  useEffect(() => { if (settled) setOpen(false) }, [settled])
  const label = elapsedLabel(elapsedMs, t, manuallyStopped) ?? t(manuallyStopped ? 'chat.presentation.stoppedUnknown' : 'chat.presentation.elapsedUnknown')
  return (
    <div className="exec-process-section">
      <div className="exec-process-header">
      {!settled ? <ExecutionTimer message={message} status={status} /> : items.length > 0 ? <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={open ? t('chat.done.collapse') : t('chat.done.expand')}
        onClick={() => setOpen((value) => !value)}
        className="fold-toggle"
      >
        <span className="fold-toggle__label">{label} · {t('chat.done.process')}</span>
        <ChevronRight className="tool-chevron" size={12} />
      </button> : <span className="exec-elapsed">{label}</span>}
      <div className="exec-divider" aria-hidden />
      </div>
      <div id={bodyId} className="exec-process" hidden={!open} data-process-open={open}>
        <ExecutionSequence items={items} message={message} status={status} settled={settled} />
      </div>
    </div>
  )
}

/** tool：mono「工具名 · 状态」一行；pending 虚线圈呼吸旋转；chevron 展开 input/output。 */
function ToolCallItem({ tool, showCommand = false }: { tool: ToolView; showCommand?: boolean }) {
  const t = useT()
  const running = itemRunning(tool.status)
  const failed = ['failed', 'error', 'cancelled'].includes(tool.status)
  const hasBody = Boolean(tool.input || tool.output || tool.exitCode !== undefined)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const presentation = toolPresentation(tool)
  const action = presentation.action
  const label = t(`chat.presentation.${action}.${running ? 'running' : failed ? 'failed' : 'completed'}`)
  const target = action === 'command' ? showCommand ? commandPreview(tool.input) : '' : presentation.target
  const accessibleLabel = target ? `${label} ${target}` : label

  const summary = (
    <span className={cn('tool-summary', failed && 'tool-summary--failed')}>
      <span className="tool-summary__name">{label}</span>
      {target && (
        <span className="tool-summary__target" title={presentation.detail || target}>
          {target}
        </span>
      )}
    </span>
  )

  if (!hasBody) {
    return (
      <div aria-label={t('chat.tool.call', { label: accessibleLabel })} className="tool-row">
        <ToolStateIcon action={action} running={running} failed={failed} />
        {summary}
        {failed && <X className="tool-fail-x" size={14} strokeWidth={2} />}
      </div>
    )
  }

  return (
    <div className="exec-body">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={t('chat.tool.callWithState', { state: toolStateLabel(running, failed, t), label: accessibleLabel })}
        onClick={() => setOpen((value) => !value)}
        className="fold-toggle"
      >
        <ToolStateIcon action={action} running={running} failed={failed} />
        {summary}
        <ChevronRight
          className="tool-chevron"
          size={14}
          strokeWidth={1.75}
        />
      </button>
      {open && <div className="tool-data" id={bodyId}>
          <div className="tool-data__label">{tool.name}</div>
          {tool.input && <ToolData label={t('chat.tool.input')} value={tool.input} />}
          {tool.output && <ToolData label={t('chat.tool.output')} value={tool.output} />}
          {tool.exitCode !== undefined && <ToolData label={t('chat.presentation.exitCode')} value={String(tool.exitCode)} />}
      </div>}
    </div>
  )
}

function ToolStateIcon({ action, running, failed }: { action: ToolAction; running: boolean; failed: boolean }) {
  const Icon = TOOL_ICONS[action]
  return <Icon className={cn('tool-icon', failed && 'tool-icon--fail')} size={14} strokeWidth={1.75} aria-hidden />
}

function ToolData({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-data__group">
      <div className="tool-data__label">{label}</div>
      <pre className="tool-data__pre">{prettyData(value)}</pre>
    </div>
  )
}

/** final text：流式过程文本小字号；结果无边框大字号。 */
function AnswerItem({ item, variant }: { item: TextItemView; variant: 'progress' | 'result' }) {
  if (variant === 'progress') {
    return (
      <div className="answer-progress">
        <MarkdownBlock text={item.text} />
        {itemRunning(item.status) && <StreamCaret />}
      </div>
    )
  }
  return <ResultCopy text={item.text} streaming={itemRunning(item.status)} />
}

/** 最终答案：无边框大字号 markdown（Result-Dominance）。 */
function ResultCopy({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="markdown-body result-copy">
      <MarkdownBlock text={text} />
      {streaming && <StreamCaret />}
    </div>
  )
}

function StreamCaret() {
  return <span className="stream-caret" aria-hidden />
}

function AnswerFooter({ text, createdAt }: { text: string; createdAt?: number }) {
  const time = typeof createdAt === 'number' ? formatConversationMessageTime(createdAt) : ''
  return <div className="exec-answer__footer">
    <AnswerCopy text={text} />
    {time && <time dateTime={new Date(createdAt!).toISOString()}>{time}</time>}
  </div>
}

function AnswerCopy({ text }: { text: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => { setState('idle') }, [text])
  const label = t(state === 'copied' ? 'chat.presentation.copied' : state === 'failed' ? 'chat.presentation.copyFailed' : 'chat.presentation.copyAnswer')
  return <button type="button" className="exec-copy" aria-label={label} title={label} onClick={() => {
    if (!navigator.clipboard) { setState('failed'); return }
    void navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))
  }}>
    {state === 'copied' ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
  </button>
}

function elapsedLabel(elapsedMs: number | undefined, t: Translate, stopped: boolean): string | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds === 0) return t(stopped ? 'chat.presentation.stoppedLessSecond' : 'chat.presentation.elapsedLessSecond')
  if (seconds < 60) return t(stopped ? 'chat.presentation.stoppedSeconds' : 'chat.presentation.elapsedSeconds', { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t(stopped ? 'chat.presentation.stoppedMinutes' : 'chat.presentation.elapsedMinutes', { minutes, seconds: seconds % 60 })
  return t(stopped ? 'chat.presentation.stoppedHours' : 'chat.presentation.elapsedHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: seconds % 60 })
}

function commandPreview(input: string | undefined): string {
  if (!input) return ''
  try {
    const data: unknown = JSON.parse(input)
    if (!data || typeof data !== 'object') return ''
    const args = data as Record<string, unknown>
    const command = args.cmd ?? args.command ?? args.chars
    return typeof command === 'string' ? command.trim().split('\n')[0].slice(0, 120) : ''
  } catch {
    return input.trim().startsWith('{') ? '' : input.trim().split('\n')[0].slice(0, 120)
  }
}

function ErrorLine({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="error-line" role="alert">
      <X size={13} className="error-line__icon" strokeWidth={2} aria-hidden />
      <span className="error-line__text">
        {text}
        {detail && <span className="error-line__detail">{detail}</span>}
      </span>
    </div>
  )
}

/** Markdown：GFM；代码块等宽字体、surface 底色、圆角、可横向滚动，无语法高亮（MVP）。 */
function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="md-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre>
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function itemRunning(status: string): boolean {
  return ['streaming', 'running', 'queued', 'created', 'in_progress'].includes(status)
}

function toolStateLabel(running: boolean, failed: boolean, t: Translate): string {
  if (running) return t('chat.tool.stateRunning')
  if (failed) return t('chat.tool.stateFailed')
  return t('chat.tool.stateDone')
}

function textPreview(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/[*_`#>]/gu, '').trim().slice(0, 88)
}

function prettyData(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
