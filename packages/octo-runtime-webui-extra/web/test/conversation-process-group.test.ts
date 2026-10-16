// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Transcript } from '../src/surfaces/Transcript'
import { processSegments } from '../src/surfaces/execution-process'
import type { MessageView, PresentationItemView, ToolView } from '../src/shared/work-state'

let host: HTMLDivElement
let root: Root
const tool: ToolView = { id: 'tool', kind: 'tool', name: 'exec_command', status: 'running', firstSeq: 2, contentVersion: 1, input: '{"cmd":"printf ok"}', output: 'ok' }
const body: PresentationItemView = { id: 'body', kind: 'text', channel: 'commentary', text: '准备检查', status: 'completed', firstSeq: 1, contentVersion: 1 }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(items: PresentationItemView[], activity = 'thinking', status = 'running', transportError?: string) {
  const message: MessageView = { id: 'assistant', role: 'assistant', author: 'Agent', content: '', createdAt: 1, executionId: 'run', status: 'streaming',
    startedAt: Date.now() - 7000, items, transportError,
    experience: { activities: [{ activityId: activity, kind: activity, status: 'running' }], plans: [], toolProgress: [], notices: [] } }
  await act(async () => root.render(createElement(Transcript, { history: [], live: [message], executionStatusById: { run: { status } } })))
}

it('reuses one entry across thinking, command, and resumed thinking', async () => {
  await render([body])
  expect(host.querySelectorAll('[data-process-group]')).toHaveLength(1)
  expect(host.querySelector('.process-summary')?.textContent).toBe('正在思考中')
  expect(host.querySelector('.process-summary .tool-icon')).toBeNull()
  expect(host.querySelector('.process-summary button')).toBeNull()
  await render([body, tool], 'executing_tool')
  const entry = host.querySelector<HTMLButtonElement>('.process-summary')!
  expect(entry.textContent).toBe('正在运行命令')
  expect(entry.querySelector('.tool-icon')).not.toBeNull()
  await act(async () => entry.click())
  expect(entry.getAttribute('aria-expanded')).toBe('true')
  await render([body, { ...tool, status: 'completed' }])
  expect(host.querySelector('.process-summary')).toBe(entry)
  expect(entry.textContent).toBe('正在思考中')
  expect(entry.querySelector('.tool-icon')).toBeNull()
  expect(entry.getAttribute('aria-expanded')).toBe('true')
  expect(host.querySelectorAll('[data-process-group]')).toHaveLength(1)
  expect(host.textContent).toContain('运行了命令')
})

it('groups thinking and mixed parallel tools, retaining details and failures', async () => {
  const thought: PresentationItemView = { id: 'thought', kind: 'text', channel: 'analysis', text: '公开摘要', firstSeq: 2, contentVersion: 1, status: 'completed' }
  await render([body, thought, tool, { ...tool, id: 'read', name: 'read_file', status: 'failed', firstSeq: 3 }, { ...tool, id: 'next', firstSeq: 4 }], 'executing_tool')
  expect(host.querySelectorAll('[data-process-group]')).toHaveLength(1)
  expect(host.querySelector('.process-summary')?.textContent).toBe('正在运行 2 条命令1 项未成功')
  const entry = host.querySelector<HTMLButtonElement>('.process-summary')!
  const details = document.getElementById(entry.getAttribute('aria-controls')!)!
  expect(details.hidden).toBe(true)
  await act(async () => entry.click())
  expect(details.textContent).toContain('公开摘要')
  expect(details.querySelectorAll('.fold-toggle')).toHaveLength(3)
  expect(host.querySelectorAll('[data-busy="true"]')).toHaveLength(1)
})

it('uses independent body items, not deltas or analysis, to split groups', () => {
  const thought: PresentationItemView = { id: 'thought', kind: 'text', channel: 'analysis', text: '', firstSeq: 3, contentVersion: 1, status: 'streaming' }
  const segments = processSegments([body, tool, { ...body, contentVersion: 2, text: '准备检查接口' }, thought, { ...tool, id: 'later', firstSeq: 5 }, { ...body, id: 'next-body', firstSeq: 6 }])
  expect(segments.filter(segment => segment.kind === 'body')).toHaveLength(2)
  const first = segments.find(segment => segment.kind === 'group' && segment.id === 'after:body')!
  expect(first.kind === 'group' && first.items.map(item => item.id)).toEqual(['tool', 'thought', 'later'])
})

it('retains failure evidence when the current label becomes thinking', async () => {
  await render([body, { ...tool, status: 'failed' }])
  expect(host.querySelector('.process-summary')?.textContent).toBe('正在思考中1 项未成功')
})

it('refreshes the same status row from streamed public thinking and keeps full details', async () => {
  const thought: PresentationItemView = { id: 'thought', kind: 'text', channel: 'analysis',
    text: '**Inspecting the returned frames**', firstSeq: 3, contentVersion: 1, status: 'streaming' }
  await render([body, { ...tool, status: 'completed' }, thought])
  const entry = host.querySelector<HTMLButtonElement>('.process-summary')!
  expect(entry.querySelector('.activity-label')?.textContent).toBe('Inspecting the returned frames')
  await render([body, { ...tool, status: 'completed' }, { ...thought, contentVersion: 2,
    text: `${thought.text}\n\nChecking whether the latest reasoning summary reaches the renderer` }])
  expect(host.querySelector('.process-summary')).toBe(entry)
  expect(entry.querySelector('.activity-label')?.textContent).toBe('Checking whether the latest reasoning summary reaches the renderer')
  expect(entry.querySelector('.activity-label__shine')?.getAttribute('data-text')).toBe('Checking whether the latest reasoning summary reaches the renderer')
  await act(async () => entry.click())
  expect(host.querySelector('.thinking-body')?.textContent).toContain('Inspecting the returned frames')
  expect(host.querySelector('.thinking-body')?.textContent).toContain('Checking whether')
})

it('uses the newest thought and replaces it with tool or attention status when the phase changes', async () => {
  const thought: PresentationItemView = { id: 'thought', kind: 'text', channel: 'analysis',
    text: 'Checking the protocol', firstSeq: 2, contentVersion: 1, status: 'completed' }
  await render([body, thought, { ...thought, id: 'latest', text: 'Checking the renderer', firstSeq: 3 }])
  expect(host.querySelector('.activity-label')?.textContent).toBe('Checking the renderer')
  await render([body, thought, { ...tool, firstSeq: 4 }], 'executing_tool')
  expect(host.querySelector('.activity-label')?.textContent).toBe('正在运行命令')
  await render([body, thought, { ...tool, firstSeq: 4, status: 'completed' }])
  expect(host.querySelector('.activity-label')?.textContent).toBe('正在思考中')
  await render([body, thought], 'waiting_approval')
  expect(host.querySelector('.activity-label')?.textContent).toBe('等待你的确认')
  expect(host.querySelector('[data-busy]')).toBeNull()
  await render([body, thought], 'thinking', 'completed')
  expect(host.querySelector('.activity-label')?.textContent).toBe('思考摘要')
  expect(host.querySelector('[data-busy]')).toBeNull()
})

it('stops busy animation for approval, disconnection, and terminal', async () => {
  await render([body, tool], 'waiting_approval')
  expect(host.querySelector('.process-summary')?.textContent).toContain('等待你的确认')
  expect(host.querySelector('[data-busy]')).toBeNull()
  await render([body, tool], 'thinking', 'disconnected', 'offline')
  expect(host.querySelector('.process-summary')?.textContent).toContain('offline')
  expect(host.querySelector('[data-busy]')).toBeNull()
  await render([body, tool], 'thinking', 'completed')
  expect(host.querySelector('[data-busy]')).toBeNull()
  expect(host.querySelector('.process-summary')?.textContent).toBe('运行了命令')
})

it('shows file semantics and target names in the summary and individual tool rows', async () => {
  const read = { ...tool, name: 'exec_command', input: JSON.stringify({ command: 'cat src/Transcript.tsx' }) }
  await render([body, read], 'executing_tool')
  const entry = host.querySelector<HTMLButtonElement>('.process-summary')!
  expect(entry.textContent).toBe('正在读取 Transcript.tsx')
  expect(entry.querySelector('.lucide-file-text')).not.toBeNull()
  await act(async () => entry.click())
  expect(host.querySelector('.tool-summary')?.textContent).toBe('正在读取Transcript.tsx')
  expect(host.querySelector('.tool-summary__target')?.getAttribute('title')).toBe('src/Transcript.tsx')
  expect(host.querySelector('.process-group__details .fold-toggle')?.getAttribute('aria-label')).toContain('正在读取 Transcript.tsx')
  const edit = { ...tool, id: 'edit', name: 'Edit', firstSeq: 3, input: JSON.stringify({ file_path: 'src/ActivityLabel.tsx' }) }
  await render([body, { ...read, status: 'completed' }, edit], 'executing_tool')
  expect(entry.textContent).toBe('正在编辑 ActivityLabel.tsx')
  expect(host.querySelector('.tool-summary')?.textContent).toBe('已读取Transcript.tsx')
  expect(host.querySelectorAll('.tool-summary')[1]?.textContent).toBe('正在编辑ActivityLabel.tsx')
  await render([body, { ...read, status: 'completed' }, { ...edit, status: 'failed' }], 'working')
  expect(host.querySelectorAll('.tool-summary')[1]?.textContent).toBe('编辑失败ActivityLabel.tsx')
})

it('names multiple files for homogeneous tools and falls back for unknown tools', async () => {
  await render([body, { ...tool, name: 'apply_patch', input: JSON.stringify({ changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }) }], 'executing_tool')
  expect(host.querySelector('.process-summary')?.textContent).toBe('正在编辑 a.ts, b.ts')
  await render([body, { ...tool, name: 'provider_tool', input: '{}' }], 'executing_tool')
  expect(host.querySelector('.process-summary')?.textContent).toBe('正在运行命令')
})

it.each([
  ['Read', { file_path: 'src/a.ts' }, 'file-text'],
  ['Edit', { file_path: 'src/a.ts' }, 'file-pen-line'],
  ['Grep', { pattern: 'ToolView' }, 'search'],
  ['list_files', { path: 'src' }, 'folder-open'],
  ['provider_tool', {}, 'square-terminal'],
])('uses the matching icon in both summary and detail for %s', async (name, input, icon) => {
  await render([body, { ...tool, name, input: JSON.stringify(input) }], 'executing_tool')
  expect(host.querySelector(`.process-summary .lucide-${icon}`)).not.toBeNull()
  expect(host.querySelector(`.process-group__details .lucide-${icon}`)).not.toBeNull()
})
