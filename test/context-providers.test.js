import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextProviderRegistry } from '../packages/octo-harness-context-builder/dist/index.js';

const scope = { identity: 'tenant/user', generation: 1 };
const context = text => ({ schema: 'octo.context-envelope/v3', items: [{ namespace: 'octo.content', name: 'inline', payload: { entries: [{ text }] } }] });

test('providers compose materials and external types without registering a scenario', async () => {
  const registry = new ContextProviderRegistry();
  const dispose = registry.register({ id: 'page', version: '1', capture: () => context('page') });
  registry.register({ id: 'selection', version: '1', capture: () => context('selection') });
  registry.register({ id: 'eva.project', version: '1', capture: () => ({ schema: 'octo.context-envelope/v3', items: [{ namespace: 'eva.project', name: 'current', payload: { schema_version: 1, title: 'Example' } }] }) });
  const result = await registry.capture(scope, new AbortController().signal);
  assert.deepEqual(result.context.items[0].payload.entries, [{ text: 'page' }, { text: 'selection' }]);
  assert.equal(result.context.items[1].namespace, 'eva.project');
  dispose();
  assert.equal((await registry.capture(scope, new AbortController().signal)).providers.length, 2);
});

test('late capture cannot escape an identity switch or cancellation', async () => {
  let current = scope;
  const registry = new ContextProviderRegistry();
  registry.register({ id: 'page', version: '1', capture: async () => { current = { ...scope, generation: 2 }; return context('old'); } });
  await assert.rejects(registry.capture(scope, new AbortController().signal, () => current), /CONTEXT_CAPTURE_SCOPE_CHANGED/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(registry.capture(scope, controller.signal));
});

test('providers cannot silently replace another provider or exceed the envelope budget', async () => {
  const registry = new ContextProviderRegistry();
  const capture = () => ({ schema: 'octo.context-envelope/v3', items: [{ namespace: 'eva.project', name: 'current', payload: {} }] });
  registry.register({ id: 'first', version: '1', capture });
  registry.register({ id: 'second', version: '1', capture });
  await assert.rejects(registry.capture(scope, new AbortController().signal), /CONTEXT_PROVIDER_ITEM_DUPLICATED/);
  const large = new ContextProviderRegistry();
  large.register({ id: 'large', version: '1', capture: () => context('a'.repeat(65536)) });
  await assert.rejects(large.capture(scope, new AbortController().signal), /CONTEXT_BUDGET_EXCEEDED/);
});
