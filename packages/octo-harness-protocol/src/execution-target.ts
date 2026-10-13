import type { ExecutionTarget } from './generated/protocol-types.js';
export type { ExecutionTarget } from './generated/protocol-types.js';

export function assertExecutionTarget(value: unknown): asserts value is ExecutionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('EXECUTION_TARGET_INVALID');
  const target = value as Record<string, unknown>;
  if (target.target_kind === 'standard_harness_agent' && !target.executor_id && !target.provider_binding_ref) return;
  if (target.target_kind === 'ability_provider' && typeof target.executor_id === 'string' && target.executor_id.length > 0 && target.executor_id.length <= 96
    && typeof target.provider_binding_ref === 'string' && target.provider_binding_ref.length > 0 && target.provider_binding_ref.length <= 256) return;
  throw new TypeError('EXECUTION_TARGET_INVALID');
}
