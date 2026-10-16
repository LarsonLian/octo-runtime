import { applyExperience, experienceSnapshot, settleExperience, type RunExperienceView } from "./experience"
import type { ConversationInputPart, ConversationDetail, ExecutionStatus, SendMessageResult, ExecutionEvent } from './contracts'
import { isTerminalStatus } from './contracts'
import { executionTiming, messageChannel, presentationItem, publicAnalysis, type MessageChannel } from './presentation'

/**
 * 会话内容面的投影状态机（自 buddy-demo work-state.ts 移植改造）。
 *
 * 数据源是 Presentation 事件（presentation.snapshot / text.patch / text.commit /
 * tool.upsert / tool.patch / execution.status / usage.snapshot / presentation.reset /
 * presentation.revoked / experience.error）。demo 中的 legacy 事件分支
 * （message.* / tool_call.* / surface.* / legacy status events /
 * session.update / interaction.requested）由 main 的应用投影处理：本地 Host invoke 不走 SSE。
 *
 * 与 demo 的关键差异（对齐 @shared/contracts）：
 * - ExecutionEvent 无 id 字段：去重使用 main 赋予的 execution 内单调 seq
 * - WorkAck → SendMessageResult（executionId / clientMessageId / conversationId 字段名；无 agentId，
 *   agentId 由 acknowledged 动作单独携带）
 * - 终态判断用 contracts 的 isTerminalStatus
 * - 发送流程拆成 sending（乐观追加 user + assistant 占位 queued）→ acknowledged（绑定 executionId 并
 *   补放早期事件）/ send_failed（错误挂到消息上，不吞）
 */

interface ItemBase {
  id: string
  contentVersion: number
  status: string
  firstSeq: number
}

export interface ToolView extends ItemBase {
  kind: 'tool'
  name: string
  input?: string
  inputDelta?: string
  output?: string
  exitCode?: number
}

export interface TextItemView extends ItemBase {
  kind: 'text'
  channel: MessageChannel
  text: string
}

export type PresentationItemView = TextItemView | ToolView

export interface ApprovalView {
  interactionId: string
  kind: 'approval' | 'elicitation' | 'question'
  status: string
  actionable: boolean
  summary: string
  reasonCode?: string
  expiresAt?: string
  request?: Record<string, unknown>
  decisionOutcome?: string
  decisionSource?: string
}

export interface InteractionQuestion {
  id: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }>
}

export function interactionQuestions(request?: Record<string, unknown>): InteractionQuestion[] {
  if (!Array.isArray(request?.questions) || !request.questions.length) return []
  const ids = new Set<string>()
  const questions: InteractionQuestion[] = []
  for (const raw of request.questions) {
    const value = record(raw)
    if (typeof value.id !== 'string' || !value.id || ids.has(value.id) || typeof value.question !== 'string' || !value.question.trim()) return []
    ids.add(value.id)
    if (value.options != null && (!Array.isArray(value.options) || value.options.some(option => typeof record(option).label !== 'string' || !String(record(option).label).trim()))) return []
    questions.push({ id: value.id, question: value.question, isOther: value.isOther === true, isSecret: value.isSecret === true,
      options: (Array.isArray(value.options) ? value.options : []).map(option => ({ label: String(record(option).label), description: typeof record(option).description === 'string' ? String(record(option).description) : '' })) })
  }
  return questions
}

export function approvalView(value: unknown): ApprovalView | undefined {
  const payload = record(value)
  if (!['approval', 'elicitation', 'question'].includes(String(payload.kind)) || typeof payload.interactionId !== 'string') return undefined
  const request = record(payload.request)
  const schema = record(request.requestedSchema)
  // Empty MCP forms are confirmations. Forms requiring input must not be accepted without answers.
  const confirmation = payload.kind === 'question' && interactionQuestions(request).length > 0 || payload.kind === 'approval' || request.mode === 'form' && schema.type === 'object'
    && Object.keys(record(schema.properties)).length === 0 && (!Array.isArray(schema.required) || schema.required.length === 0)
  const status = String(payload.status ?? 'invalidated')
  return { interactionId: payload.interactionId, kind: payload.kind as ApprovalView['kind'], status,
    actionable: confirmation && payload.actionable === true && status === 'pending', summary: String(payload.summary ?? request.message ?? ''),
    reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : undefined,
    request: payload.request && typeof payload.request === 'object' && !Array.isArray(payload.request) ? record(payload.request) : undefined,
    decisionOutcome: typeof payload.decisionOutcome === 'string' ? payload.decisionOutcome : undefined,
    decisionSource: typeof payload.decisionSource === 'string' ? payload.decisionSource : undefined,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined }
}

export interface MessageView {
  teamRole?: 'summary' | 'member'
  parentExecutionId?: string
  /** Local submission feedback only; never changes the authoritative approval or Run status. */
  approvalResponses?: Record<string, 'pending' | 'continued'>
  parts?: ConversationInputPart[]
  runId?: string
  interactions?: ApprovalView[]
  id: string
  role: 'user' | 'assistant' | 'system'
  /**
   * 署名。**`null` = 本人**，不是「没有署名」：这层是纯 reducer（main / renderer
   * 共用，没有 locale 上下文），把「你」写死在这里等于把一句译文冻进状态机。
   * 渲染层见 `null` 时取 `chat.turn.you`。
   */
  author: string | null
  content: string
  createdAt: number
  executionId?: string
  /** queued 占位（等待 ack）| streaming | completed | failed | stopped | disconnected */
  status?: 'queued' | 'streaming' | 'completed' | 'failed' | 'stopped' | 'disconnected'
  items?: PresentationItemView[]
  experience?: RunExperienceView
  modelSteps?: Record<string, unknown>[]
  usage?: Record<string, unknown>
  transportError?: string
  /** 发送失败时挂在消息上的错误（不吞） */
  sendError?: string
  failureMessage?: string
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
  terminalContentReady?: boolean
  stopRequestedByUser?: boolean
  needsSnapshot?: boolean
}

export interface ExecutionView {
  id: string
  agentId?: string
  status: ExecutionStatus
  failureCode?: string
  /** 已处理事件的单调 seq 高水位；seq <= 该值的事件视为重复丢弃 */
  seq: number
  eventCount: number
  startedAt: number
}

export interface WorkbenchState {
  messages: MessageView[]
  executions: Record<string, ExecutionView>
  /** ack 之前先到达的事件（SSE 可能快于 IPC 回执），ack 后按序补放 */
  pendingEvents: Record<string, ExecutionEvent[]>
  activeExecutionId?: string
}

/** WorkExecution 完成后的 Result-Dominance 视图。 */
export interface CompletedExecutionView {
  processItems: PresentationItemView[]
  answerItems: TextItemView[]
}

export const initialWorkbenchState: WorkbenchState = {
  messages: [],
  executions: {},
  pendingEvents: {},
}

export function completedExecutionView(message: MessageView): CompletedExecutionView | undefined {
  if (message.status !== 'completed') return undefined
  return executionItems(message)
}

export function executionItems(message: MessageView): CompletedExecutionView {
  const processItems: PresentationItemView[] = []
  const answerItems: TextItemView[] = []
  for (const item of message.items ?? []) {
    if (item.kind === 'text' && item.channel === 'final') {
      if (item.text.trim()) answerItems.push(item)
    } else processItems.push(item)
  }
  return { processItems, answerItems }
}

const retainedPendingEventLimit = 500

export type WorkbenchAction =
  | { type: 'approval_response'; interactionId: string; pending: boolean }
  | { type: 'sending'; clientMessageId: string; prompt: string; parts?: ConversationInputPart[]; agentName: string }
  | {
      type: 'acknowledged'
      ack: SendMessageResult
      clientMessageId: string
      agentId?: string
      agentName?: string
    }
  | { type: 'send_failed'; clientMessageId: string; error: string }
  | { type: 'event'; event: ExecutionEvent }
  | { type: 'reset' }
  | { type: 'hydrate'; detail: ConversationDetail; agentName: string }

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  if (action.type === 'reset') return { messages: [], executions: {}, pendingEvents: {} }

  if (action.type === 'approval_response') return {
    ...state,
    messages: state.messages.map(message => {
      if (message.role !== 'assistant' || !message.interactions?.some(item => item.interactionId === action.interactionId)) return message
      const approvalResponses = { ...message.approvalResponses }
      if (action.pending) approvalResponses[action.interactionId] = 'pending'
      else delete approvalResponses[action.interactionId]
      return { ...message, approvalResponses }
    }),
  }

  if (action.type === 'hydrate') {
    let next = state
    for (const saved of action.detail.messages) {
      if (saved.role !== 'assistant' || !saved.executionId) continue
      next = { ...next, messages: next.messages.map((message) => message.executionId === saved.executionId && message.role === 'assistant'
        ? { ...applySnapshot(message, { run: { status: saved.executionStatus ?? saved.status, failureMessage: saved.failureMessage, ...executionTiming(saved), stopRequestedByUser: saved.stopRequestedByUser }, items: (saved.items ?? []).map(item => ({ ...item, itemId: item.id })), interactions: saved.interactions ?? [], experience: saved.experience, modelSteps: saved.modelSteps }, !isTerminalStatus(saved.executionStatus ?? saved.status as ExecutionStatus)),
          terminalContentReady: saved.terminalContentReady ?? isTerminalStatus(saved.executionStatus ?? saved.status as ExecutionStatus) }
        : message) }
    }
    for (const ack of action.detail.executions ?? []) {
      const existing = next.executions[ack.executionId]
      if (existing) {
        if (!isTerminalStatus(existing.status) || isTerminalStatus(ack.status)) {
          next = { ...next, executions: { ...next.executions, [ack.executionId]: { ...existing, status: ack.status } } }
        }
        continue
      }
      if (isTerminalStatus(ack.status)) continue
      const saved = action.detail.messages.filter((message) => message.executionId === ack.executionId)
      const pending = next.pendingEvents[ack.executionId] ?? []
      next = {
        ...next,
        activeExecutionId: ack.executionId,
        executions: { ...next.executions, [ack.executionId]: { id: ack.executionId, status: ack.status, agentId: action.detail.summary.agentId, seq: saved.find((message) => message.role === 'assistant')?.eventSeq ?? 0, eventCount: 0, startedAt: saved[0]?.createdAt ?? Date.now() } },
        pendingEvents: { ...next.pendingEvents, [ack.executionId]: [] },
        messages: [...next.messages.filter((message) => message.id !== `user:${ack.clientMessageId}` && message.id !== `assistant:${ack.clientMessageId}`), ...saved.map((message): MessageView => ({
          id: `${message.role}:${ack.clientMessageId}`, role: message.role,
          author: message.role === 'user' ? null : message.agentName ?? action.agentName,
          parentExecutionId: message.parentExecutionId, teamRole: message.teamRole, content: message.text, parts: message.parts, createdAt: message.createdAt, executionId: ack.executionId,
          status: message.status === 'cancelled' ? 'stopped' : message.status === 'running' ? 'streaming' : message.status,
          runId: message.runId, items: message.items, interactions: message.interactions, transportError: message.transportError,
          ...executionTiming(message), terminalContentReady: message.terminalContentReady,
          stopRequestedByUser: message.stopRequestedByUser,
          failureMessage: message.failureMessage,
        }))],
      }
      for (const event of pending) next = workbenchReducer(next, { type: 'event', event })
    }
    return next
  }

  if (action.type === 'sending') {
    const now = Date.now()
    return {
      ...state,
      messages: [
        ...state.messages.filter((message) => message.id !== `user:${action.clientMessageId}` && message.id !== `assistant:${action.clientMessageId}`),
        {
          id: `user:${action.clientMessageId}`,
          role: 'user',
          author: null,
          content: action.prompt,
          parts: action.parts,
          createdAt: now,
        },
        {
          id: `assistant:${action.clientMessageId}`,
          role: 'assistant',
          author: action.agentName,
          content: '',
          createdAt: now,
          status: 'queued',
          items: [],
        },
      ],
    }
  }

  if (action.type === 'acknowledged') {
    const { ack } = action
    // A concurrent history read can hydrate this execution before the IPC ACK arrives.
    if (state.executions[ack.executionId]) return state
    let next: WorkbenchState = {
      ...state,
      activeExecutionId: ack.executionId,
      pendingEvents: { ...state.pendingEvents, [ack.executionId]: [] },
      executions: {
        ...state.executions,
        [ack.executionId]: {
          id: ack.executionId,
          agentId: action.agentId,
          status: ack.status,
          failureCode: undefined,
          seq: 0,
          eventCount: 0,
          startedAt: Date.now(),
        },
      },
      messages: state.messages.map((message) => {
        if (message.id === `user:${action.clientMessageId}`) {
          return { ...message, executionId: ack.executionId }
        }
        if (message.id === `assistant:${action.clientMessageId}`) {
          return {
            ...message,
            executionId: ack.executionId,
            author: action.agentName ?? message.author,
            status: 'streaming' as const,
            items: [],
            sendError: undefined,
          }
        }
        return message
      }),
    }
    for (const event of state.pendingEvents[ack.executionId] ?? []) {
      next = workbenchReducer(next, { type: 'event', event })
    }
    return next
  }

  if (action.type === 'send_failed') {
    // 乐观追加的 assistant 占位按 clientMessageId 定位，错误原样挂上，不吞。
    return {
      ...state,
      messages: state.messages.map((message) => {
        if (message.id !== `assistant:${action.clientMessageId}`) return message
        return { ...message, status: 'failed', sendError: action.error }
      }),
    }
  }

  const event = action.event
  const execution = state.executions[event.executionId]
  if (!execution) {
    const queued = state.pendingEvents[event.executionId] ?? []
    if (queued.some((item) => item.seq === event.seq)) return state
    return {
      ...state,
      pendingEvents: {
        ...state.pendingEvents,
        [event.executionId]: [...queued, event].slice(-retainedPendingEventLimit),
      },
    }
  }
  if (event.type === 'team.member') {
    const childKey = String(event.payload.executionId ?? '')
    if (!childKey) return state
    const childStatus = normalizeExecutionStatus(String(event.payload.status), 'queued')
    const runId = typeof event.payload.runId === 'string' ? event.payload.runId : undefined
    if (state.executions[childKey]) {
      // Worker owns content and Run terminal delivery. Metadata can settle a
      // dispatch failure only when no Worker Run was ever created.
      if (!runId && isTerminalStatus(childStatus)) return workbenchReducer(state, { type: 'event', event: { ...event, executionId: childKey, type: 'execution.status', payload: { status: childStatus } } })
      return state
    }
    const parentIndex = state.messages.findIndex(m => m.executionId === event.executionId && m.role === 'assistant')
    const createdAt = typeof event.payload.createdAt === 'number' ? event.payload.createdAt : event.tsMs
    const message: MessageView = {
      teamRole: 'member', id: `team:${childKey}`, executionId: childKey, parentExecutionId: event.executionId,
      role: 'assistant', author: String(event.payload.agentName ?? ''), content: '', createdAt,
      runId, status: 'queued', items: [],
    }
    const messages = state.messages.map(m => m.executionId === event.executionId && m.role === 'assistant' ? { ...m, author: 'Team', teamRole: 'summary' as const } : m)
    const lastChild = messages.reduce((last, m, i) => m.parentExecutionId === event.executionId ? i : last, -1)
    messages.splice(lastChild >= 0 ? lastChild + 1 : parentIndex < 0 ? messages.length : parentIndex + 1, 0, message)
    let next = { ...state, messages, executions: { ...state.executions, [childKey]: { id: childKey, agentId: String(event.payload.agentId ?? ''), status: childStatus, seq: 0, eventCount: 0, startedAt: createdAt } }, pendingEvents: { ...state.pendingEvents, [childKey]: [] } }
    for (const pending of state.pendingEvents[childKey] ?? []) next = workbenchReducer(next, { type: 'event', event: pending })
    if (!runId && isTerminalStatus(childStatus)) next = workbenchReducer(next, { type: 'event', event: { ...event, executionId: childKey, type: 'execution.status', payload: { status: childStatus } } })
    return next
  }
  // seq 由 main 在转发前赋予、execution 内单调；高水位以下视为重复/旧事件丢弃。
  if (event.seq <= execution.seq) return state

  const status = eventStatus(event, execution.status)
  const failureCode = nextFailureCode(event, execution.failureCode)
  const messages = state.messages.map((message) => {
    if (message.executionId !== event.executionId || message.role !== 'assistant') return message
    const continued = ['text.patch', 'text.commit', 'tool.upsert', 'tool.patch', 'tool.progress', 'model_step.upsert'].includes(event.type)
      || event.type === 'activity.upsert' && event.payload.kind !== 'waiting_approval'
      || event.type === 'execution.status' && event.payload.status !== 'interacting'
    if (continued && (message.approvalResponses || message.interactions?.some(item => item.status === 'responding'))) message = continueApprovalResponses(message)
    if (event.type === 'presentation.snapshot') return applySnapshot(message, event.payload)
    if (event.type === 'interaction.upsert') {
      const interaction = approvalView(event.payload)
      if (!interaction) return message
      const previous = message.interactions?.find((item) => item.interactionId === interaction.interactionId)
      const terminalStatuses = ['resolved', 'accepted', 'declined', 'answered', 'cancelled', 'expired', 'invalidated', 'failed']
      if (previous && terminalStatuses.includes(previous.status) && !terminalStatuses.includes(interaction.status)) return { ...message, needsSnapshot: true }
      return { ...message, interactions: [...(message.interactions ?? []).filter((item) => item.interactionId !== interaction.interactionId), interaction] }
    }
    if (event.type === 'presentation.reset') {
      return { ...message, items: [], interactions: [], content: '', usage: undefined, experience: undefined, modelSteps: undefined, status: isTerminalStatus(execution.status) ? message.status : 'streaming' as const,
        terminalContentReady: false, transportError: undefined, needsSnapshot: true }
    }
    if (event.type === 'presentation.revoked') {
      return {
        ...message,
        items: [],
        interactions: [],
        content: '',
        usage: undefined,
        experience: undefined,
        modelSteps: undefined,
        status: 'disconnected' as const,
        // 服务端细节串（经 `chat.exec.transportBroken` 的 {error} 注入）。这句兜底
        // 与 main 那一百来处 `throw new Error` 同属「错误码化」那一轮，i18n 本轮不动。
        transportError: String(event.payload.message ?? event.payload.reason ?? '展示权限已撤销'),
      }
    }
    if (event.type === 'text.patch') return applyTextProjection(message, event.payload, event.seq, false)
    if (event.type === 'text.commit') return applyTextProjection(message, event.payload, event.seq, true)
    if (event.type === 'tool.upsert' || event.type === 'tool.patch') return applyToolProjection(message, event.payload, event.seq)
    if (['activity.upsert', 'plan.upsert', 'tool.progress', 'notice.upsert'].includes(event.type)) {
      const experience = applyExperience(message.experience, event.type, event.payload)
      const settled = message.status === 'completed' || message.status === 'failed' || message.status === 'stopped'
      return { ...message, experience: settled ? settleExperience(experience, message.status === 'stopped' ? 'cancelled' : message.status!) : experience }
    }
    if (event.type === 'model_step.upsert') return { ...message, modelSteps: [...(message.modelSteps ?? []).filter(step => step.stepId !== event.payload.stepId), event.payload] }
    if (event.type === 'usage.snapshot') return { ...message, usage: event.payload }
    if (event.type === 'execution.status') {
      const updated = applyExecutionStatus(typeof event.payload.teamSummary === 'string' ? { ...message, author: 'Team', content: event.payload.teamSummary } : message, event.payload)
      return isTerminalStatus(String(event.payload.status)) ? { ...updated, interactions: message.interactions?.map((item) => ({ ...item, actionable: false })), experience: settleExperience(message.experience, String(event.payload.status)) } : updated
    }
    if (event.type === 'experience.error') {
      const detail = String(event.payload.message ?? event.payload.code ?? '')
      return { ...message, status: 'disconnected' as const, transportError: detail, needsSnapshot: true }
    }
    return message
  })

  return {
    ...state,
    messages,
    executions: {
      ...state.executions,
      [event.executionId]: {
        ...execution,
        status,
        failureCode,
        seq: event.seq,
        eventCount: execution.eventCount + 1,
      },
    },
  }
}

function nextFailureCode(event: ExecutionEvent, current: string | undefined): string | undefined {
  if (event.type === 'execution.status') {
    const code = event.payload.failureCode
    return typeof code === 'string' && code ? code : current
  }
  if (event.type === 'presentation.snapshot') return payloadFailureCode(event.payload) ?? current
  return current
}

function payloadFailureCode(payload: Record<string, unknown>): string | undefined {
  const run = record(payload.run)
  const code = run.failureCode ?? run.failure_code ?? payload.failureCode
  return typeof code === 'string' && code ? code : undefined
}

export function executionFailureMessage(payload: Record<string, unknown>): string | undefined {
  const run = record(payload.run)
  const failure = record(run.failure ?? payload.failure)
  const detail = run.failureMessage ?? payload.failureMessage ?? failure.message
  return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined
}

function eventStatus(event: ExecutionEvent, current: ExecutionStatus): ExecutionStatus {
  if (isTerminalStatus(current)) return current
  if (event.type === 'presentation.snapshot') {
    return normalizeExecutionStatus(String(record(event.payload.run).status ?? event.payload.executionStatus ?? current), current)
  }
  if (event.type === 'execution.status') return normalizeExecutionStatus(String(event.payload.status ?? current), current)
  return current
}

function applySnapshot(message: MessageView, payload: Record<string, unknown>, preserveLiveItems = false): MessageView {
  const projected = (Array.isArray(payload.items) ? payload.items : [])
    .map(record)
    .map(snapshotItem)
    .filter((item): item is PresentationItemView => Boolean(item))
    .sort(compareItems)
  const items = projected.map((item) => {
    const current = message.items?.find((existing) => existing.id === item.id)
    return current && current.contentVersion >= item.contentVersion ? current : item
  })
  const executionStatus = String(record(payload.run).status ?? payload.executionStatus ?? '')
  const pendingResponses = [...Object.keys(message.approvalResponses ?? {}), ...(message.interactions ?? []).filter(item => item.status === 'responding').map(item => item.interactionId)]
  const responseStillWaiting = (Array.isArray(payload.interactions) ? payload.interactions : [])
    .some(value => pendingResponses.includes(record(value).interactionId as string) && ['pending', 'responding'].includes(String(record(value).status)))
  const newContent = projected.some(item => !message.items?.some(current => current.id === item.id && current.contentVersion >= item.contentVersion))
  if (pendingResponses.length && (newContent || executionStatus && executionStatus !== 'interacting' && !responseStillWaiting)) message = continueApprovalResponses(message)
  // Polling history can lag behind the live stream and omit not-yet-checkpointed items.
  // Only authoritative SSE snapshots/reset may replace that live baseline.
  if (preserveLiveItems || (message.status === 'completed' || message.status === 'failed' || message.status === 'stopped')
    && !isTerminalStatus(normalizeExecutionStatus(executionStatus, 'running'))) {
    for (const current of message.items ?? []) if (!items.some((item) => item.id === current.id)) items.push(current)
    items.sort(compareItems)
  }
  const status = message.status === 'completed' || message.status === 'failed' || message.status === 'stopped'
    ? message.status : executionStatus ? messageStatus(executionStatus) : message.status
  return {
    ...message,
    runId: typeof payload.runId === 'string' ? payload.runId : message.runId,
    interactions: (Array.isArray(payload.interactions) ? payload.interactions : []).map(approvalView).filter((item): item is ApprovalView => Boolean(item)),
    items,
    experience: status === 'completed' || status === 'failed' || status === 'stopped'
      ? settleExperience(experienceSnapshot(payload.experience), status === 'stopped' ? 'cancelled' : status)
      : experienceSnapshot(payload.experience),
    modelSteps: Array.isArray(payload.modelSteps) ? payload.modelSteps.map(record) : [],
    content: finalText(items),
    status,
    failureMessage: executionFailureMessage(payload) ?? message.failureMessage,
    transportError: undefined,
    ...mergeTiming(message, record(payload.run)),
    terminalContentReady: message.terminalContentReady || isTerminalStatus(normalizeExecutionStatus(executionStatus, 'running')),
    stopRequestedByUser: record(payload.run).stopRequestedByUser === true || message.stopRequestedByUser,
    needsSnapshot: false,
  }
}

function continueApprovalResponses(message: MessageView): MessageView {
  const keys = [...Object.keys(message.approvalResponses ?? {}), ...(message.interactions ?? []).filter(item => item.status === 'responding').map(item => item.interactionId)]
  return { ...message, approvalResponses: Object.fromEntries(keys.map(key => [key, 'continued' as const])) }
}

function snapshotItem(item: Record<string, unknown>): PresentationItemView | undefined {
  return presentationItem(item)
}

function applyTextProjection(
  message: MessageView,
  payload: Record<string, unknown>,
  seq: number,
  committed: boolean,
): MessageView {
  const itemId = String(payload.itemId ?? '')
  if (!itemId) return message
  const items = message.items ?? []
  const existing = items.find((item): item is TextItemView => item.id === itemId && item.kind === 'text')
  const contentVersion = Number(payload.contentVersion ?? 0)
  if (existing && contentVersion > 0 && contentVersion <= existing.contentVersion) return message
  const channel = messageChannel(payload.channel, existing?.channel, true)
  if (!channel) return { ...message, needsSnapshot: true }
  if (!publicAnalysis(channel, payload)) {
    const publicItems = items.filter((item) => item.id !== itemId)
    return { ...message, items: publicItems, content: finalText(publicItems) }
  }
  const op = String(payload.op ?? (committed ? 'replace' : 'append'))
  if (!committed && op === 'append' && typeof payload.baseContentVersion === 'number'
    && payload.baseContentVersion !== (existing?.contentVersion ?? 0)) return { ...message, needsSnapshot: true }
  const authoritativeText = payload.text ?? payload.content
  const nextText = committed || op === 'replace'
    ? String(authoritativeText ?? payload.textDelta ?? existing?.text ?? '')
    : `${existing?.text ?? ''}${String(payload.textDelta ?? '')}`
  const nextItem: TextItemView = {
    id: itemId,
    kind: 'text',
    channel,
    text: nextText,
    contentVersion,
    status: committed ? committedItemStatus(payload.status) : String(payload.status ?? 'streaming'),
    firstSeq: Number(payload.firstSeq ?? existing?.firstSeq ?? seq),
  }
  const nextItems = replaceItem(items, nextItem)
  return {
    ...message,
    items: nextItems,
    content: finalText(nextItems),
    status: committed || message.status === 'completed' || message.status === 'failed' || message.status === 'stopped' ? message.status : 'streaming',
  }
}

function committedItemStatus(value: unknown): string {
  const status = String(value ?? 'completed')
  return ['completed', 'failed', 'cancelled', 'stopped'].includes(status) ? status : 'completed'
}

function applyToolProjection(message: MessageView, payload: Record<string, unknown>, seq: number): MessageView {
  const id = String(payload.itemId ?? '')
  if (!id) return message
  const items = message.items ?? []
  const existing = items.find((item): item is ToolView => item.id === id && item.kind === 'tool')
  const contentVersion = Number(payload.contentVersion ?? 0)
  if (existing && contentVersion > 0 && contentVersion <= existing.contentVersion) return message
  const inputDelta = optionalString(payload.inputDelta)
  const next: ToolView = {
    id,
    kind: 'tool',
    name: String(payload.name ?? existing?.name ?? 'tool'),
    status: String(payload.status ?? existing?.status ?? 'running'),
    contentVersion,
    firstSeq: existing?.firstSeq ?? Number(payload.firstSeq ?? seq),
    input: payload.input === undefined ? existing?.input : presentationText(payload.input),
    inputDelta,
    output: payload.output === undefined ? existing?.output : String(payload.output),
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : existing?.exitCode,
  }
  if (inputDelta && payload.input === undefined) next.input = `${existing?.input ?? ''}${inputDelta}`
  const nextItems = replaceItem(items, next)
  return { ...message, items: nextItems, content: finalText(nextItems) }
}

function applyExecutionStatus(message: MessageView, payload: Record<string, unknown>): MessageView {
  const status = normalizeExecutionStatus(String(payload.status ?? ''), 'running')
  if (!isTerminalStatus(status) && (message.status === 'completed' || message.status === 'failed' || message.status === 'stopped')) {
    return { ...message, stopRequestedByUser: payload.stopRequestedByUser === true || message.stopRequestedByUser }
  }
  const terminal = isTerminalStatus(status)
  const items = terminal
    ? (message.items ?? []).map((item) => item.status === 'streaming' || item.status === 'running'
      ? { ...item, status: status === 'completed' ? 'completed' : status }
      : item)
    : message.items
  return {
    ...message,
    items,
    content: items ? finalText(items) : message.content,
    status: messageStatus(status),
    failureMessage: executionFailureMessage(payload) ?? message.failureMessage,
    ...mergeTiming(message, payload),
    stopRequestedByUser: payload.stopRequestedByUser === true || message.stopRequestedByUser,
  }
}

function mergeTiming(message: MessageView, payload: Record<string, unknown>) {
  const incoming = executionTiming(payload)
  return executionTiming({
    startedAt: incoming.startedAt ?? message.startedAt,
    completedAt: incoming.completedAt ?? message.completedAt,
    elapsedMs: incoming.elapsedMs ?? message.elapsedMs,
  })
}

function replaceItem(items: PresentationItemView[], next: PresentationItemView): PresentationItemView[] {
  const existing = items.some((item) => item.id === next.id)
  return (existing ? items.map((item) => item.id === next.id ? next : item) : [...items, next]).sort(compareItems)
}

function finalText(items: PresentationItemView[]): string {
  return items
    .filter((item): item is TextItemView => item.kind === 'text' && item.channel === 'final')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
}

function compareItems(left: PresentationItemView, right: PresentationItemView): number {
  return left.firstSeq - right.firstSeq || left.id.localeCompare(right.id)
}

function messageStatus(status: string): MessageView['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'stopped'
  return 'streaming'
}

function normalizeExecutionStatus(value: string, fallback: ExecutionStatus): ExecutionStatus {
  const values: ExecutionStatus[] = ['queued', 'leased', 'running', 'interacting', 'cancelling', 'completed', 'failed', 'cancelled']
  return values.includes(value as ExecutionStatus) ? value as ExecutionStatus : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : presentationText(value)
}

function presentationText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
