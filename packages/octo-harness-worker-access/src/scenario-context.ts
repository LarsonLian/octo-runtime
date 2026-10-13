import { createHash } from 'node:crypto';
import { assertScenarioRequest, assertScenarioSnapshot, canonicalScenarioPolicy, type ScenarioRequest, type ScenarioPolicySnapshot, type ContextEnvelope } from '@mininglamp-oss/octo-harness-protocol';
import type { TrustedContextInstruction } from '@mininglamp-oss/octo-harness-context-builder/run-context';
export function scenarioInstructions(request: ScenarioRequest | undefined, snapshot: ScenarioPolicySnapshot | undefined, context: ContextEnvelope): TrustedContextInstruction[] {
  if (!request && !snapshot) return [];
  if (!request || !snapshot) throw new TypeError('SCENARIO_POLICY_MISMATCH');
  assertScenarioRequest(request, context); assertScenarioSnapshot(snapshot);
  // 业务场景身份与策略摘要同时匹配，不能把其他场景的空策略用于当前 Run。
  if (snapshot.scenario_id !== request.scenario_id || snapshot.hash !== `sha256:${createHash('sha256').update(canonicalScenarioPolicy(snapshot)).digest('hex')}`) throw new TypeError('SCENARIO_POLICY_MISMATCH');
  return snapshot.instructions.map(text => ({ text, source: 'agent_configuration' }));
}
