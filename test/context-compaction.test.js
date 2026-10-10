import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactContextMaterials, FileMaterialCompactionStore } from '../packages/octo-harness-daemon/dist/context-compaction.js';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'octo-compaction-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const progress = [];
  // 确定性测试计量器；生产必须由 Provider/tokenizer 提供真实 token 计量。
  const port = { model: 'test-model', contextWindow: 1024, outputReserveTokens: 64,
    summaryInputLimit: 512, toolsDisabled: true,
    measureInputTokens: async text => 32 + Array.from(text).length,
    countTokens: async text => Array.from(text).length,
    summarize: async () => { calls++; return 'summary facts'; }, ...overrides };
  const input = { runKey: 'run-1', material: '材料😀'.repeat(1000), protectedIdentity: 'fixed-instructions-and-input',
    sourceRefs: [{ resource_ref: 'task/1', revision: 3 }], signal: new AbortController().signal,
    port, store: new FileMaterialCompactionStore(root), onProgress: value => progress.push(value) };
  return { input, root, progress, calls: () => calls };
}
test('large material is summarized, persisted and reused without a second model call', async t => {
  const f = await fixture(t); const result = await compactContextMaterials(f.input);
  assert.match(result.material, /Untrusted contextual summary/);
  assert.equal(result.receipt.sourceDigest.startsWith('sha256:'), true);
  assert.ok(result.receipt.calls > 1); assert.ok(result.receipt.outputTokens <= 960);
  assert.deepEqual(f.progress, ['started', 'completed']);
  const before = f.calls(); const recovered = await compactContextMaterials(f.input);
  assert.deepEqual(recovered, result); assert.equal(f.calls(), before);
  assert.equal((await readdir(f.root)).length, 1);
});
test('small input is not summarized', async t => {
  const f = await fixture(t); f.input.material = 'small';
  assert.deepEqual(await compactContextMaterials(f.input), { material: 'small' });
  assert.equal(f.calls(), 0); assert.deepEqual(f.progress, []);
});
test('protected input overflow never invokes summarizer', async t => {
  const f = await fixture(t, { measureInputTokens: async () => 3000 });
  await assert.rejects(compactContextMaterials(f.input), /PROTECTED_INPUT_TOO_LARGE/);
  assert.equal(f.calls(), 0);
});
test('missing capacity or a tool-enabled summarizer is rejected', async t => {
  const f = await fixture(t, { toolsDisabled: false });
  await assert.rejects(compactContextMaterials(f.input), /CAPACITY_UNAVAILABLE/);
});
test('summary that makes no progress fails without a durable snapshot', async t => {
  const f = await fixture(t, { summarize: async text => text });
  await assert.rejects(compactContextMaterials(f.input), /NO_PROGRESS/);
  assert.deepEqual(f.progress, ['started', 'failed']);
  assert.equal(await f.input.store.load('run-1', f.input.signal), undefined);
});
test('same Run cannot silently replace summary after source or trusted input changes', async t => {
  const f = await fixture(t); await compactContextMaterials(f.input);
  await assert.rejects(compactContextMaterials({ ...f.input, protectedIdentity: 'different' }), /SNAPSHOT_MISMATCH/);
  await assert.rejects(compactContextMaterials({ ...f.input, material: 'different' }), /SNAPSHOT_MISMATCH/);
});
test('cancellation rejects a non-cooperative late summarizer before checkpoint', async t => {
  let release; let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { summarize: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController(); f.input.signal = controller.signal;
  const pending = compactContextMaterials(f.input);
  await started; controller.abort(new Error('run cancelled'));
  await assert.rejects(pending, /run cancelled/); release('late summary');
  assert.equal(await f.input.store.load('run-1', new AbortController().signal), undefined);
});
test('competing checkpoint saves keep the first durable value', async t => {
  const f = await fixture(t); const first = await compactContextMaterials(f.input);
  const returned = await f.input.store.save('run-1', { ...first.receipt, summary: 'other' }, f.input.signal);
  assert.deepEqual(returned, first.receipt);
  const content = await readFile(join(f.root, (await readdir(f.root))[0]), 'utf8');
  assert.equal(JSON.parse(content).summary, first.receipt.summary);
});
