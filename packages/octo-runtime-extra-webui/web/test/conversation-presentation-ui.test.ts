// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../src/surfaces/Transcript'
import type { MessageView, PresentationItemView, TextItemView, ToolView } from '../src/shared/work-state'

let host: HTMLDivElement
let root: Root
const clipboard = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  clipboard.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function message(status: MessageView['status'] = 'streaming'): MessageView {
  const items: PresentationItemView[] = [
    { id: 'progress', kind: 'text', channel: 'commentary', text: '我会先检查接口。', status: 'completed', firstSeq: 1, contentVersion: 1 },
    { id: 'thinking', kind: 'text', channel: 'analysis', text: '核对协议字段', status: 'streaming', firstSeq: 2, contentVersion: 1 },
    { id: 'tool', kind: 'tool', name: 'exec_command', input: '{"command":"printf verified"}', output: 'tool-output', status: 'running', firstSeq: 3, contentVersion: 1 },
    { id: 'answer-one', kind: 'text', channel: 'final', text: '第一部分答复。', status: 'completed', firstSeq: 4, contentVersion: 1 },
    { id: 'answer-two', kind: 'text', channel: 'final', text: '第二部分答复。', status: 'completed', firstSeq: 5, contentVersion: 1 },
  ]
  return { id: 'assistant:message', role: 'assistant', author: 'Agent', executionId: 'execution', createdAt: 1,
    content: '', status, items: status === 'streaming' ? items : items.map((item) => ({ ...item, status: 'completed' })), elapsedMs: 143000 }
}

async function render(current: MessageView, additional: MessageView[] = []) {
  await act(async () => root.render(createElement(Transcript, { history: [], live: [current, ...additional] })))
}

describe('Conversation process and answer presentation', () => {
  it('keeps Team completion and member authors visible without inventing a Run duration for Team', async () => {
    const summary: MessageView = { id: 'team', role: 'assistant', author: 'Team', executionId: 'team',
      teamRole: 'summary', createdAt: 1, content: '全部完成', status: 'completed' }
    await render(summary, [{ ...message('completed'), teamRole: 'member', author: '代码评审专家' }])
    expect([...host.querySelectorAll('.turn-meta__author')].map(node => node.textContent)).toEqual(['Team', '代码评审专家'])
    expect(host.querySelector('.turn-meta')?.textContent).toContain('已完成')
    expect(host.querySelector('[data-execution-id="team"] .exec-process')).toBeNull()
    expect(host.textContent).not.toContain('用时暂不可用')
  })

  it.each([999, 1000, 143000, 3601000])('shows an attributed manual stop above the divider at %d ms', async (elapsedMs) => {
    await render({ ...message('stopped'), elapsedMs, stopRequestedByUser: true })
    expect(host.querySelector('.exec-process-header')?.textContent).toMatch(/^你在 .+ 后停止了 · 执行过程$/)
    expect(host.querySelector('.exec-cancelled')).toBeNull()
    expect(host.querySelectorAll('.exec-divider')).toHaveLength(1)
    expect(host.querySelector<HTMLElement>('.exec-process')?.hidden).toBe(true)
  })

  it('does not claim that the user caused an unattributed cancellation', async () => {
    await render(message('stopped'))
    expect(host.querySelector('.exec-cancelled')).not.toBeNull()
    expect(host.querySelector('.exec-process-header')?.textContent).toBe('用时 2分23秒 · 执行过程')
    expect(host.textContent).not.toContain('你在')
  })

  it('renders a Markdown table as one semantic grid and preserves column alignment', async () => {
    await render({ ...message('completed'), items: [{
      id: 'table', kind: 'text', channel: 'final', status: 'completed', firstSeq: 1, contentVersion: 1,
      text: '| 项目 | 检查结果 |\n| :--- | ---: |\n| 设备 | MacBook Pro |\n| 内存 | 24 GB |',
    }] })
    expect(host.querySelectorAll('.md-content table')).toHaveLength(1)
    expect(host.querySelectorAll('thead th')).toHaveLength(2)
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(host.querySelectorAll('tbody td')).toHaveLength(4)
    expect(host.querySelector<HTMLTableCellElement>('tbody td:nth-child(2)')?.style.textAlign).toBe('right')
  })

  it('keeps commentary as prose and hides command input and output while running', async () => {
    await render(message())
    expect(host.querySelector('.answer-progress')?.textContent).toContain('我会先检查接口。')
    expect(host.querySelector('.exec-answer')).toBeNull()
    expect(host.querySelector('.tool-data')).toBeNull()
    expect(host.querySelector('.thinking-body')?.closest<HTMLElement>('.process-group__details')?.hidden).toBe(true)
    expect(host.querySelector('.process-summary')?.textContent).toBe('正在运行命令')
    expect(host.querySelector('.process-summary .tool-icon')?.classList.contains('lucide-square-terminal')).toBe(true)
    expect(host.querySelector('.execution-activity')).toBeNull()
  })

  it('groups tools within body intervals without discarding mixed tools', async () => {
    const tool = message().items![2] as ToolView
    await render({ ...message(), items: [{ ...tool, firstSeq: 1 }, { ...tool, id: 'two', firstSeq: 2 }, { ...message().items![0], firstSeq: 3 }, { ...tool, id: 'three', firstSeq: 4 }, { ...tool, id: 'read', name: 'functions.read_file', firstSeq: 5 }] })
    expect(host.querySelectorAll('[data-process-group]')).toHaveLength(2)
    expect(host.querySelector('.answer-progress')?.textContent).toContain('我会先检查接口。')
    expect(host.querySelectorAll('.process-group__details .fold-toggle')).toHaveLength(4)
  })

  it('removes stale queued and duplicate tool activity while preserving approval requests', async () => {
    const current = { ...message(), experience: { activities: [{ activityId: 'tool', kind: 'executing_tool', status: 'running' }], plans: [], toolProgress: [], notices: [] } }
    await act(async () => root.render(createElement(Transcript, { history: [], live: [current], executionStatusById: { execution: { status: 'queued' } } })))
    expect(host.textContent).not.toContain('等待调度')
    expect(host.querySelector('[data-execution-status]')?.getAttribute('data-execution-status')).toBe('running')
    expect(host.querySelector('.execution-activity')).toBeNull()
    await render({ ...current, experience: { ...current.experience, activities: [{ activityId: 'approval', kind: 'waiting_approval', status: 'running' }] } })
    expect(host.querySelector('[data-activity-kind=waiting_approval]')?.textContent).toBe('等待你的确认')
  })

  it('automatically collapses once, leaves all final blocks visible and copies only the answer', async () => {
    await render(message())
    await render(message('completed'))
    const process = host.querySelector<HTMLElement>('.exec-process')!
    expect(process.hidden).toBe(true)
    expect(host.querySelector('.exec-process-header')?.textContent).toBe('用时 2分23秒 · 执行过程')
    expect(host.querySelector('.exec-answer')?.textContent).toContain('第一部分答复。第二部分答复。')
    const copyButton = host.querySelector<HTMLButtonElement>('.exec-copy')!
    expect(copyButton.textContent).toBe('')
    expect(copyButton.getAttribute('aria-label')).toBe('复制答复')
    expect(copyButton.title).toBe('复制答复')
    await act(async () => copyButton.click())
    expect(clipboard).toHaveBeenCalledWith('第一部分答复。\n\n第二部分答复。')
    expect(copyButton.textContent).toBe('')
    expect(copyButton.getAttribute('aria-label')).toBe('已复制')
    await act(async () => host.querySelector<HTMLButtonElement>('.exec-process-header button')!.click())
    await render({ ...message('completed'), usage: { totalTokens: 10 } })
    expect(process.hidden).toBe(false)
    expect(host.querySelectorAll('.exec-answer')).toHaveLength(1)
  })

  it('retains manually expanded tool details through deltas and completion', async () => {
    await render(message())
    const toggle = host.querySelector<HTMLButtonElement>('.exec-process .fold-toggle')!
    await act(async () => toggle.click())
    await act(async () => host.querySelector<HTMLButtonElement>('.process-group__details .fold-toggle')!.click())
    expect(host.querySelector('.tool-data')?.textContent).toContain('tool-output')
    await render(message('completed'))
    await act(async () => host.querySelector<HTMLButtonElement>('.exec-process-header button')!.click())
    expect(host.querySelector('.exec-process .fold-toggle')).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.tool-data')?.textContent).toContain('tool-output')
  })

  it('keeps the previous turn stable when a new turn starts', async () => {
    await render(message('completed'))
    await act(async () => host.querySelector<HTMLButtonElement>('.exec-process-header button')!.click())
    const next = { ...message(), id: 'assistant:next', executionId: 'next' }
    await render(message('completed'), [next])
    expect(host.querySelector<HTMLElement>('.exec-process')!.hidden).toBe(false)
    expect(host.querySelectorAll('[data-execution-id]')).toHaveLength(2)
  })

  it('does not expose internal synchronization text before an authoritative empty answer', async () => {
    await render({ ...message('completed'), items: [], terminalContentReady: false })
    expect(host.textContent).not.toContain('正在同步答复')
    expect(host.textContent).not.toContain('未返回文字答复')
    await render({ ...message('completed'), items: [], terminalContentReady: true })
    expect(host.textContent).toContain('未返回文字答复')
    expect(host.querySelector('.exec-process-header button')).toBeNull()
  })

  it('keeps failures outside the process fold and marks text as partial output', async () => {
    await render(message('failed'))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('执行失败')
    expect(host.querySelector('.exec-answer')?.textContent).toContain('部分输出')
    expect(host.querySelector<HTMLElement>('.exec-process')!.hidden).toBe(true)
  })

  it('shows initialization failure details without process items', async () => {
    await render({ ...message('failed'), items: [], elapsedMs: 0,
      failureMessage: '401: Invalid API key' })
    expect(host.querySelector('[role="alert"] .error-line__detail')?.textContent).toBe('401: Invalid API key')
    expect(host.querySelector('[role="alert"]')?.closest('.exec-process')).toBeNull()
    expect(host.querySelector('.exec-process-header button')).toBeNull()
    expect(host.querySelector('.exec-answer')).toBeNull()
  })

  it('preserves initialization failure details in history', async () => {
    await act(async () => root.render(createElement(Transcript, { live: [], history: [{
      id: 'failed-history', conversationId: 'conversation', executionId: 'execution',
      role: 'assistant', text: '', status: 'failed', createdAt: 1, items: [],
      failureCode: 'RUNTIME_EXECUTION_FAILED', failureMessage: '401: Invalid API key',
    }] })))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('RUNTIME_EXECUTION_FAILED')
    expect(host.querySelector('.error-line__detail')?.textContent).toBe('401: Invalid API key')
  })

  it('does not manufacture duration from a local creation timestamp', async () => {
    await render({ ...message('completed'), elapsedMs: undefined, createdAt: Date.now() - 143000 })
    expect(host.querySelector('.exec-process-header')?.textContent).toBe('用时暂不可用 · 执行过程')
  })
})

it('shows thinking immediately after commentary and removes it at terminal', async () => {
  const current = { ...message(), items: [message().items![0]], experience: { activities: [{ activityId: 'think', kind: 'thinking', status: 'running' }], plans: [], toolProgress: [], notices: [] } }
  await render(current)
  expect(host.querySelector('.process-summary')?.textContent).toContain('正在思考')
  expect(host.querySelector('.process-summary__label')?.getAttribute('role')).toBe('status')
  await render({ ...current, status: 'completed' })
  expect(host.querySelector('.execution-activity')).toBeNull()
})


it('preserves final text and tool ordering while running without duplicate answers', async () => {
  const current = message()
  await render({ ...current, items: [
    { ...(current.items![3] as TextItemView), id: 'before', text: '工具前正文', firstSeq: 1 },
    { ...current.items![2], firstSeq: 2 },
    { ...(current.items![4] as TextItemView), id: 'after', text: '工具后正文', firstSeq: 3 },
  ] })
  const sequence = host.querySelector('.exec-process > .exec-body')!
  expect([...sequence.children].map(child => child.textContent)).toEqual([
    expect.stringContaining('工具前正文'), expect.stringContaining('正在运行命令'), expect.stringContaining('工具后正文'),
  ])
  expect(host.querySelector('.exec-answer')).toBeNull()
})

it('shows the current member and pending confirmation in Team progress before completion', async () => {
  const summary: MessageView = { id: 'team', executionId: 'parent', role: 'assistant', author: 'Team', content: '', createdAt: 1, teamRole: 'summary', status: 'streaming' }
  const child: MessageView = { ...message(), parentExecutionId: 'parent', teamRole: 'member', author: '个人助手', interactions: [
    { interactionId: 'confirm', kind: 'elicitation', status: 'pending', actionable: true, summary: 'Allow completion?' },
  ] }
  await render(summary, [{ ...message('completed'), id: 'previous', executionId: 'previous', parentExecutionId: 'parent', teamRole: 'member', author: '需求澄清专家' }, child])
  expect(host.querySelector('.team-progress__current')?.textContent).toContain('个人助手')
  expect(host.querySelector('.team-progress__current')?.textContent).toContain('需要你的确认')
  expect(host.querySelector('.team-progress summary')?.textContent).toBe('协作进度')
  expect(host.querySelector('.team-progress')?.textContent).toContain('需求澄清专家把任务交给了个人助手')
  expect(host.querySelector('.team-progress__current')?.textContent).not.toContain('已完成')
})
