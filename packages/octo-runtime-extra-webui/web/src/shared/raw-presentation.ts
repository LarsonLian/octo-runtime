type Row = Record<string, unknown>
export interface PublicRunEvent { type: string; payload: Row; sourceSeq: number; streamId: string; streamSeq: number; ownerEpoch: number }

/** Product presentation is built by the consumer; infrastructure emits original events. */
export class RawRunPresentation {
  stream = ''
  after = 0
  updated = Date.now()
  readonly items = new Map<string, Row>()
  readonly steps = new Map<string, Row>()
  readonly interactions = new Map<string, Row>()
  readonly activities = new Map<string, Row>()
  readonly plans = new Map<string, Row>()
  readonly progress = new Map<string, Row>()
  readonly notices = new Map<string, Row>()
  readonly run: Row = { status: 'running' }
  constructor(readonly runId: string) {}

  snapshot(): PublicRunEvent {
    return this.event('presentation.snapshot', { schemaVersion: 3, runId: this.runId, sourceSeq: this.after,
      run: { ...this.run }, items: [...this.items.values()], modelSteps: [...this.steps.values()],
      interactions: [...this.interactions.values()], experience: { activities: [...this.activities.values()],
        plans: [...this.plans.values()], toolProgress: [...this.progress.values()], notices: [...this.notices.values()] } })
  }

  event(type: string, payload: Row): PublicRunEvent { return { type, payload, sourceSeq: this.after, streamId: this.stream, streamSeq: this.after, ownerEpoch: 0 } }

  receive(value: unknown): PublicRunEvent | undefined {
    const frame = object(value), params = object(frame.params)
    if (frame.jsonrpc !== '2.0' || params.run_id !== this.runId || typeof params.stream_id !== 'string' || !params.stream_id) throw new Error('Invalid raw Run stream identity')
    if (this.stream && params.stream_id !== this.stream) throw new Error('STREAM_EXPIRED')
    this.stream = params.stream_id
    if (frame.method === 'agent_run.stream_gap') throw new Error('STREAM_GAP')
    if (frame.method === 'agent_run.state') {
      if (!['completed', 'failed', 'cancelled'].includes(String(params.status))) throw new Error('Invalid raw Run state')
      Object.assign(this.run, { status: params.status, failureCode: params.failure_code })
      return this.event('run.status', { ...this.run })
    }
    if (frame.method !== 'agent_run.event') return undefined
    const seq = Number(params.seq)
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid raw Run stream sequence')
    if (seq <= this.after) return undefined
    if (seq !== this.after + 1) throw new Error('STREAM_GAP')
    const source = object(params.event), payload = object(source.payload)
    if (source.run_id !== this.runId || source.seq !== seq || typeof source.type !== 'string') throw new Error('Invalid raw Run event identity')
    this.after = seq;this.updated = Date.now()
    let result: PublicRunEvent | undefined
    if (source.type.startsWith('message.')) {
      const channel = payload.channel
      if (!['final', 'assistant', 'commentary', 'analysis'].includes(String(channel))) return undefined
      if (channel === 'analysis' && !['public_reasoning', 'public_summary', 'public_plan'].includes(String(payload.exposure))) return undefined
      const id = String(payload.messageId ?? `message:${channel}`), prior = this.items.get(id)
      const text = source.type === 'message.delta' ? String(prior?.text ?? '') + String(payload.text ?? '') : String(payload.text ?? prior?.text ?? '')
      const item: Row = { itemId: id, kind: 'text', channel, text, status: payload.status ?? 'running',
        exposure: payload.exposure, contentVersion: Number(prior?.contentVersion ?? 0) + 1, firstSeq: prior?.firstSeq ?? seq }
      this.put(this.items,id,item);result=this.event('text.commit',item)
    } else if (source.type.startsWith('tool_call.') && source.type !== 'tool_call.progress') {
      const id=String(payload.toolCallId ?? payload.id ?? '')
      if (!id) return undefined
      const prior = this.items.get(id)
      const item: Row = { ...prior, ...pick(payload,['name','input','output','exitCode','status','elapsedMs']),
        ...(payload.args ? { input: payload.args } : {}),
        ...(payload.argsDelta ? { input: String(prior?.input ?? '') + String(payload.argsDelta) } : {}),
        ...(payload.outputDelta ? { output: String(prior?.output ?? '') + String(payload.outputDelta) } : {}),
        ...(payload.outputSnapshot !== undefined ? { output: payload.outputSnapshot } : {}),
        itemId:id,kind:'tool',firstSeq:prior?.firstSeq ?? seq,contentVersion:Number(prior?.contentVersion ?? 0)+1 }
      this.put(this.items,id,item);result=this.event('tool.upsert',item)
    } else if (source.type.startsWith('model_step.')) {
      const id=String(payload.stepId ?? ''),item={...pick(payload,['stepId','status']),status:source.type==='model_step.finished'?'completed':'running',lastSourceSeq:seq}
      if(id){this.put(this.steps,id,item);result=this.event('model_step.upsert',item)}
    } else if (source.type.startsWith('activity.')) {
      const id=String(payload.activityId ?? ''), item={...this.activities.get(id),...pick(payload,['activityId','kind','subject','source','info','status','startedAtMs','endedAtMs']),lastSourceSeq:seq}
      if(id){this.put(this.activities,id,item);result=this.event('activity.upsert',item)}
    } else if (source.type==='plan.updated') {
      const id=String(payload.planId ?? 'plan'),item=pick(payload,['planId','revision','explanation','steps'])
      this.put(this.plans,id,item);result=this.event('plan.upsert',item)
    } else if (source.type==='tool_call.progress') {
      const id=String(payload.id ?? ''),item=pick(payload,['id','progress'])
      if(id){this.put(this.progress,id,item);result=this.event('tool.progress',item)}
    } else if (source.type==='run.notice') {
      const id=String(payload.noticeId ?? ''),item=pick(payload,['noticeId','code','severity','params','relatedActivityId','relatedItemId'])
      if(id){this.put(this.notices,id,item);result=this.event('notice.upsert',item)}
    } else if (source.type.startsWith('interaction.')) {
      const id=String(payload.interactionId ?? ''),requested=source.type==='interaction.requested'
      const item={...this.interactions.get(id),...pick(payload,['interactionId','executionInstanceId','kind','request','expiresAt','status','outcome','source']),
        status:requested?'pending':payload.status,actionable:requested}
      if(id){this.put(this.interactions,id,item);result=this.event('interaction.upsert',item)}
    } else if (source.type==='usage.update') result=this.event('usage.snapshot',{usage:pick(payload,['inputTokens','outputTokens','totalTokens','cachedInputTokens','reasoningOutputTokens'])})
    else if (source.type==='run.started' || ['run.completed','run.failed','run.cancelled'].includes(source.type)) {
      const status=source.type==='run.started'?'running':source.type.slice(4)
      Object.assign(this.run,{status,...(status==='running'?{startedAt:source.occurred_at}:{completedAt:source.occurred_at}),failureCode:payload.code,failureMessage:payload.message})
      if(status!=='running')for(const [id,item] of this.interactions)this.put(this.interactions,id,{...item,actionable:false})
      result=this.event('run.status',{...this.run})
    }
    const collections=[this.items,this.steps,this.interactions,this.activities,this.plans,this.progress,this.notices]
    if (JSON.stringify(collections.map(items=>[...items.values()])).length > 2*1024*1024) throw new Error('PRODUCT_PRESENTATION_CAPACITY_EXHAUSTED')
    return result
  }

  private put(collection: Map<string, Row>, key: string, value: Row): void {
    if (!collection.has(key) && collection.size >= 128) throw new Error('PRODUCT_PRESENTATION_CAPACITY_EXHAUSTED')
    collection.set(key,value)
  }
}

function object(value: unknown): Row { return value && typeof value==='object' && !Array.isArray(value)?value as Row:{} }
function pick(value: Row, keys: string[]): Row {return Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))}
