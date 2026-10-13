import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExecutionTarget } from '../dist/index.js';

test('reserved execution targets accept valid bindings and reject incomplete or extra fields', () => {
  assert.doesNotThrow(() => assertExecutionTarget({ target_kind: 'standard_harness_agent' }));
  assert.doesNotThrow(() => assertExecutionTarget({ target_kind: 'ability_provider', executor_id: 'dify', provider_binding_ref: 'binding-1' }));
  for (const value of [null, [], {}, { target_kind: 'unknown' },
    { target_kind: 'standard_harness_agent', executor_id: null },
    { target_kind: 'ability_provider', executor_id: 'dify' },
    { target_kind: 'ability_provider', executor_id: '', provider_binding_ref: 'binding-1' },
    { target_kind: 'ability_provider', executor_id: 'dify', provider_binding_ref: 'binding-1', endpoint: 'https://example.test' }]) {
    assert.throws(() => assertExecutionTarget(value), /EXECUTION_TARGET_INVALID/);
  }
});
