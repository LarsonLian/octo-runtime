import { parse } from 'shell-quote'
import type { ToolView } from '@shared/work-state'

export type ToolAction = 'command' | 'read' | 'search' | 'change' | 'list' | 'tool'
export interface ToolPresentation { action: ToolAction; target: string; detail: string }

const ACTIONS: Record<string, ToolAction> = {
  read: 'read', read_file: 'read', readfile: 'read', view_file: 'read', view_image: 'read',
  edit: 'change', edit_file: 'change', editfile: 'change', multiedit: 'change', multi_edit: 'change',
  write: 'change', write_file: 'change', write_to_file: 'change', replace_in_file: 'change',
  apply_patch: 'change', apply_diff: 'change', notebookedit: 'change',
  search: 'search', grep: 'search', glob: 'search', web_search: 'search', search_files: 'search',
  list: 'list', ls: 'list', list_files: 'list', list_directory: 'list',
}

export function toolAction(name: string): ToolAction {
  // MCP namespaces have their own semantics; only known built-in names are classified.
  return ACTIONS[name.toLowerCase().replace(/^functions\./, '')] ?? 'command'
}

export function toolPresentation(tool: Pick<ToolView, 'name' | 'input'>): ToolPresentation {
  const args = inputRecord(tool.input)
  const name = tool.name.toLowerCase().replace(/^functions\./, '')
  const action = toolAction(tool.name)
  if (['exec_command', 'bash', 'shell', 'run_command', 'execute_command'].includes(name)) {
    const command = stringField(args, ['cmd', 'command', 'value']) || (tool.input?.trim().startsWith('{') ? '' : tool.input ?? '')
    return shellPresentation(command) ?? presentation('command', command)
  }
  if (action === 'command') return presentation(action, name === 'write_stdin' ? stringField(args, ['chars']) : '')
  const paths = [stringField(args, ['file_path', 'filePath', 'path', 'file', 'target_file', 'notebook_path'])]
  if (action === 'change') {
    for (const field of ['changes', 'edits']) {
      if (Array.isArray(args[field])) for (const entry of args[field]) {
        paths.push(stringField(record(entry), ['file_path', 'filePath', 'path', 'file']))
      }
    }
    const patch = stringField(args, ['patch', 'input', 'value']) || (tool.input?.startsWith('*** Begin Patch') ? tool.input : '')
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1])
    for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1])
  }
  const targets = [...new Set(paths.filter(Boolean))]
  if (action === 'search') {
    const query = stringField(args, ['query', 'pattern', 'regex'])
    return presentation(action, [query, ...targets].filter(Boolean).join(' · '))
  }
  return presentation(action, targets.join(', '))
}

function presentation(action: ToolAction, detail: string): ToolPresentation {
  const target = action === 'read' || action === 'change' || action === 'list'
    ? detail.split(', ').map(path => path.replace(/\\/g, '/').replace(/\/$/, '').split('/').at(-1) || path).join(', ')
    : detail
  return { action, target: target.replace(/\s+/g, ' ').trim(), detail }
}

function inputRecord(input: string | undefined): Record<string, unknown> {
  if (!input) return {}
  try { return record(JSON.parse(input)) } catch { return {} }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringField(args: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) if (typeof args[field] === 'string' && args[field].trim()) return args[field].trim()
  return ''
}

function shellPresentation(command: string, depth = 0): ToolPresentation | undefined {
  // Interpret only literal, read-only invocations. Substitutions, redirects and
  // mixed command chains must retain the generic command label.
  if (depth > 2 || !command.trim() || /[$`\n]/.test(command)) return undefined
  let tokens: ReturnType<typeof parse>
  try { tokens = parse(command) } catch { return undefined }
  const commands: string[][] = [[]]
  for (const token of tokens) {
    if (typeof token === 'string') commands.at(-1)!.push(token)
    else if ('op' in token && ['&&', ';'].includes(token.op)) commands.push([])
    else return undefined
  }
  const operations: ToolPresentation[] = []
  for (const tokens of commands) {
    if (!tokens.length) return undefined
    if (tokens[0] === 'cd' && tokens.length === 2 && commands.length > 1) continue
    const operation = literalCommand(tokens, depth)
    if (!operation) return undefined
    operations.push(operation)
  }
  if (!operations.length || !operations.every(entry => entry.action === operations[0].action)) return undefined
  return presentation(operations[0].action, [...new Set(operations.map(entry => entry.detail))].join(', '))
}

function literalCommand([executable, ...args]: string[], depth: number): ToolPresentation | undefined {
  const name = executable.replace(/\\/g, '/').split('/').at(-1)
  if (name && ['sh', 'bash', 'zsh'].includes(name) && args.length === 2 && ['-c', '-lc'].includes(args[0])) {
    return shellPresentation(args[1], depth + 1)
  }
  if (name === 'cat') {
    const files = args.filter(arg => !arg.startsWith('-'))
    if (args.some(arg => arg === '-') || !files.length) return undefined
    return presentation('read', files.join(', '))
  }
  if (name === 'head' || name === 'tail') {
    const files = operands(args, ['-n', '-c', '--lines', '--bytes'])
    if (!files?.length || files.includes('-')) return undefined
    return presentation('read', files.join(', '))
  }
  if (name === 'sed') {
    // The p command prints a range; arbitrary sed programs can write files or execute code.
    if (args.length < 3 || args[0] !== '-n' || !/^\d+(?:,\d+|,\$)?p$/.test(args[1])) return undefined
    const files = args.slice(2)
    return files.every(file => !file.startsWith('-')) ? presentation('read', files.join(', ')) : undefined
  }
  if (name === 'ls') {
    return presentation('list', args.filter(arg => !arg.startsWith('-')).join(', ') || '.')
  }
  if (name === 'rg' || name === 'grep') {
    // Unknown options can consume operands or load patterns from files, so fall back.
    const files = operands(args, ['-g', '--glob', '-t', '--type', '-A', '-B', '-C', '-m', '--max-count'],
      ['-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '-s', '-S', '-F', '-w', '-v', '--files', '--hidden', '--no-ignore'])
    if (!files) return undefined
    if (name === 'rg' && args.includes('--files')) return presentation('list', files.join(', ') || '.')
    if (!files.length) return undefined
    return presentation('search', files.join(' · '))
  }
  return undefined
}

function operands(args: string[], valueOptions: string[], flags?: string[]): string[] | undefined {
  const result: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') return [...result, ...args.slice(index + 1)]
    if (valueOptions.includes(arg)) { if (++index >= args.length) return undefined; continue }
    if (arg.startsWith('-')) {
      if (flags && !flags.includes(arg)) return undefined
      continue
    }
    result.push(arg)
  }
  return result
}
