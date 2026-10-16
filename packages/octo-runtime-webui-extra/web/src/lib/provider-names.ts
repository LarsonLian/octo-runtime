/** 展示名称由宿主维护，不依赖 Runtime 的包体或品牌资源。 */
const PROVIDER_NAMES: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  claude_code: 'Claude Code',
  codebuddy: 'CodeBuddy',
  hermes: 'Hermes',
  'kimi-code': 'Kimi Code',
  kimi_code: 'Kimi Code',
  mcode: 'MCode',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  qodercli: 'Qoder CLI',
  qoderclicn: 'Qoder CLI CN',
  'zcode-gui': 'ZCode',
  zcode: 'ZCode',
  antigravity: 'Antigravity',
  acp: 'ACP',
}

export function providerName(providerType: string): string {
  return PROVIDER_NAMES[providerType] ?? providerType
}
