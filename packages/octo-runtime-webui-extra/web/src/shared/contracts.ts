export type ExecutionStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'interacting'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | (string & {})

const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status)
}

export type ExperienceEventType =
  | 'presentation.snapshot'
  | 'presentation.reset'
  | 'presentation.revoked'
  | 'text.patch'
  | 'text.commit'
  | 'tool.upsert'
  | 'tool.patch'
  | 'activity.upsert'
  | 'plan.upsert'
  | 'model_step.upsert'
  | 'tool.progress'
  | 'notice.upsert'
  | 'execution.status'
  | 'usage.snapshot'
  | 'experience.error'
  | (string & {})

export interface ExecutionEvent {
  executionId: string
  /** main 转发前分配的进程内单调序号，只用于当前 renderer 的事件排序。 */
  seq: number
  type: ExperienceEventType
  payload: Record<string, unknown>
  tsMs: number
  cursor?: string
  streamId?: string
  streamSeq?: number
  ownerEpoch?: number
  /** presentation.reset 重建增量时所基于的源事件游标。 */
  sourceSeq?: number
}

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus =
  | 'queued'
  | 'streaming'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disconnected'

export interface ConversationMessage {
  parentExecutionId?: string
  teamRole?: 'summary' | 'member'
  agentName?: string
  parts?: ConversationInputPart[]
  runId?: string
  interactions?: import('./work-state').ApprovalView[]
  id: string
  conversationId: string
  executionId?: string
  role: MessageRole
  text: string
  status: MessageStatus
  createdAt: number
  /** 消息发送幂等键；不确定结果重试时必须复用。 */
  clientMessageId?: string
  items?: import('./work-state').PresentationItemView[]
  experience?: import('./experience').RunExperienceView
  modelSteps?: Record<string, unknown>[]
  /** 读取时附带的进程内投影水位，重启后不持久化。 */
  eventSeq?: number
  startedAt?: number
  completedAt?: number
  elapsedMs?: number
  terminalContentReady?: boolean
  stopRequestedByUser?: boolean
  executionStatus?: ExecutionStatus
  failureCode?: string
  failureMessage?: string
  transportError?: string
}

export interface ConversationImagePart {
  dataUrl?: string
  id: string
  type: 'image'
  artifact: { artifact_id: string; mediaType: string; byteSize: number; sha256: string }
  name?: string
}

export type ConversationInputPart = { type: 'text'; text: string } | ConversationImagePart

export interface SendMessageResult {
  accepted: true
  executionId: string
  status: ExecutionStatus
  clientMessageId: string
  conversationId: string
}
export interface OwnerSubject {type:string;id:string}
export interface RuntimeAdapter {providerType:string;available:boolean;providerVersion?:string;unavailableReason?:string}
export interface ConversationDetail {summary:{agentId:string};messages:ConversationMessage[];executions?:SendMessageResult[]}
