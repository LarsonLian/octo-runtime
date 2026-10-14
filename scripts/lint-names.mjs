import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv.indexOf('--root');
if (rootArg >= 0 && !process.argv[rootArg + 1]) throw new Error('--root requires a directory');
const root = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : fileURLToPath(new URL('..', import.meta.url)));
const legacy = [
  ['octo', 'harness'].join('-'),
  ['OCTO', 'HARNESS'].join('_'),
  ['Octo', 'Harness'].join(''),
  ['Octo', 'Harness'].join(' '),
];
function containsLegacy(value, name) {
  // Environment prefixes are case-sensitive; historical database names are not package names.
  return name === legacy[1] ? value.includes(name) : value.toLowerCase().includes(name.toLowerCase());
}
const excluded = ['.git', 'node_modules', 'dist', 'out', 'release', '.worktree', '.workbuddy'];
const args = ['--files', '--hidden', '-0', ...excluded.flatMap(name => ['-g', `!**/${name}/**`]), '-g', '!**/secret.md'];
const result = spawnSync('rg', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error ?? new Error(result.stderr);
const files = result.stdout.split('\0').filter(Boolean);
const findings = [], exceptions = [];
for (const file of files) {
  if (legacy.some(name => containsLegacy(file, name))) findings.push({ file, kind: 'path' });
  const bytes = readFileSync(resolve(root, file));
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const names = legacy.filter(name => containsLegacy(line, name));
    if (!names.length) continue;
    const entry = { file, line: index + 1, names };
    const requiredHistory = file.replaceAll('\\', '/') === 'docs/octo-runtime-rename-ipd-se.md'
      && line.startsWith('架构评审指出：`' + legacy[0] + '` 命名有歧义')
      && names.length === 1 && line.split(legacy[0]).length === 2;
    if (requiredHistory) exceptions.push({ ...entry, reason: 'Explicitly required architecture-review history' });
    else findings.push(entry);
  }
}
console.log(JSON.stringify({ root: relative(process.cwd(), root) || '.', scannedFiles: files.length, findings, exceptions, excluded, respectsGitIgnore: true }, null, 2));
process.exitCode = findings.length ? 1 : 0;
