import assert from 'node:assert/strict';
import test from 'node:test';
import { assertContextEnvelope, assertContextExtensionsSnapshot, contextHash, mergeContext, resolveContextConfiguration } from '../packages/octo-harness-protocol/dist/index.js';
import { ContextCompiler } from '../packages/octo-harness-worker-access/dist/context-pipeline.js';
import { compileRunContext } from '../packages/octo-harness-context-builder/dist/run-context.js';

const empty = () => ({ schema: 'octo.context-envelope/v3', items: [] });
const external = () => ({ ...empty(), items: [{ namespace: 'eva.project', name: 'current', payload: { type: { nested: true }, project_id: 'p1' } }] });

test('unknown items survive merge and hash but do not enter model or execution controls', () => {
  const context = external();
  assert.doesNotThrow(() => assertContextEnvelope(context));
  assert.deepEqual(mergeContext(empty(), context), context);
  assert.notEqual(contextHash(context), contextHash(empty()));
  assert.deepEqual(compileRunContext(context), compileRunContext(empty()));
  context.items[0].payload.project_id = 'p2';
  assert.notEqual(contextHash(context), contextHash(external()));
});

test('unknown items cannot be persisted as defaults or made mandatory without support', () => {
  for (const layer of ['defaults', 'mandatory']) {
    const configuration = { defaults: empty(), mandatory: empty(), [layer]: external() };
    assert.throws(() => resolveContextConfiguration(configuration, empty()), /CONTEXT_CONFIGURATION_TYPE_FORBIDDEN/);
  }
});

test('known invalid payloads and unknown public shape errors are not ignored', () => {
  assert.throws(() => assertContextEnvelope({ ...empty(), items: [{ namespace: 'octo.security', name: 'approval_policy', payload: { mode: 'silently_allow' } }] }));
  const context = external();
  context.items[0].payload = [];
  assert.throws(() => assertContextEnvelope(context), /CONTEXT_SCHEMA_INVALID/);
});

test('only the frozen Worker projection enters the external material channel', () => {
  const context = external();
  context.items[0].payload.private = 'PRIVATE_NOT_PROJECTED';
  const snapshot = { configuration_version: 'rules-1', items: [{ namespace: 'eva.project', name: 'current', status: 'material', text: '{"project_id":"p1"}' }] };
  assert.doesNotThrow(() => assertContextExtensionsSnapshot(snapshot, context));
  const compiled = new ContextCompiler().compile(context, undefined, [], {
    plan: { agent_source: 'provisioned', adapter_type: 'codex', workdir: '/tmp', approval_mode: 'ask', context_extensions: snapshot },
    capabilities: { skills: [], skillRoots: [], mcpServers: {}, workdir: '/tmp', providerStateDir: '/tmp/state' }
  });
  assert.match(compiled.modelContent, /p1/);
  assert.equal(compiled.modelContent.includes('PRIVATE_NOT_PROJECTED'), false);
  assert.equal(compiled.controlInstructions, '');
  assert.throws(() => assertContextExtensionsSnapshot({ ...snapshot, items: [] }, context));
  assert.throws(() => assertContextExtensionsSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], namespace: 'octo.custom' }] }));
});
