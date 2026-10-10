import { assertContextEnvelope, assertJsonValue, contextItem } from './context.js';
import type { ContextEnvelope, ScenarioRequest, ScenarioPolicy, ScenarioPolicySnapshot } from './generated/protocol-types.js';
export const SCENARIO_KEY = 'doc.selection.review';
const encoder = new TextEncoder();
function object(v: unknown, _fields: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('SCENARIO_INVALID');
}
export function assertScenarioRequest(v: unknown, context?: ContextEnvelope): asserts v is ScenarioRequest {
  object(v, ['key', 'builder_id', 'builder_version']);
  if (v.key !== SCENARIO_KEY || v.builder_id !== 'doc-selection' || v.builder_version !== '1') throw new TypeError('SCENARIO_UNSUPPORTED');
  if (context) {
    assertContextEnvelope(context);
    const entries = contextItem(context, 'octo.content', 'inline')?.payload.entries as Record<string, unknown>[] | undefined;
    const e = entries?.[0]; const source = e?.source as Record<string, unknown> | undefined;
    if (entries?.length !== 1 || typeof e?.text !== 'string' || !e.text || encoder.encode(e.text).length > 32768 || source?.kind !== 'document_selection' || typeof source.document_id !== 'string' || !source.document_id) throw new TypeError('SCENARIO_INVALID');
  }
}
export function assertScenarioPolicy(v: unknown): asserts v is ScenarioPolicy {
  object(v, ['enabled', 'instructions', 'default_skills']); assertJsonValue(v);
  if (typeof v.enabled !== 'boolean' || !Array.isArray(v.instructions) || v.instructions.length > 32 || v.instructions.some(x => typeof x !== 'string' || !x)
    || encoder.encode(v.instructions.join('')).length > 16384 || !Array.isArray(v.default_skills) || v.default_skills.length > 32 || encoder.encode(JSON.stringify(v)).length > 65536) throw new TypeError('SCENARIO_INVALID');
  const ids = new Set<string>();
  for (const skill of v.default_skills) {
    object(skill, ['resource_id', 'invoke']);
    if (typeof skill.resource_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(skill.resource_id) || typeof skill.invoke !== 'boolean' || ids.has(skill.resource_id)) throw new TypeError('SCENARIO_INVALID');
    ids.add(skill.resource_id);
  }
}
export function canonicalScenarioPolicy(v: Pick<ScenarioPolicySnapshot, 'key' | 'version' | 'instructions' | 'default_skills'>): string {
  if (v.key !== SCENARIO_KEY || !Number.isSafeInteger(v.version) || v.version < 1) throw new TypeError('SCENARIO_INVALID');
  assertScenarioPolicy({ enabled: true, instructions: v.instructions, default_skills: v.default_skills });
  // Same recursively sorted JSON object keys as Go CanonicalScalarJSON.
  return JSON.stringify({ default_skills: [...v.default_skills].sort((a,b) => a.resource_id < b.resource_id ? -1 : a.resource_id > b.resource_id ? 1 : 0).map(s => ({ invoke: s.invoke, resource_id: s.resource_id })), instructions: v.instructions, key: v.key, version: v.version });
}
export function assertScenarioSnapshot(v: unknown): asserts v is ScenarioPolicySnapshot {
  object(v, ['key', 'version', 'instructions', 'default_skills', 'hash']);
  canonicalScenarioPolicy(v as unknown as ScenarioPolicySnapshot);
  if (typeof v.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.hash)) throw new TypeError('SCENARIO_POLICY_MISMATCH');
}
