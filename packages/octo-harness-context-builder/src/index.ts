import { assertScenarioRequest, type ContextEnvelope, type ScenarioRequest } from '@mininglamp-oss/octo-harness-protocol/browser';
export const CONTEXT_BUILDER_SCHEMA = 'octo.context-builder/v1';
export interface AwarenessSnapshot { kind: 'document_selection'; document_id: string; document_version?: string; text: string }
export interface ContextBuilder { id: string; version: string; scenarioId: string; build(awareness: AwarenessSnapshot): ContextEnvelope }
export interface BuiltScenarioContext { scenario: ScenarioRequest; context: ContextEnvelope }
/** Pure local registry: the host owns capture and submission. */
export class ContextBuilderRegistry {
  private readonly builders = new Map<string, ContextBuilder>();
  register(builder: ContextBuilder): void {
    assertScenarioRequest({ key: builder.scenarioId, builder_id: builder.id, builder_version: builder.version });
    if (this.builders.has(builder.scenarioId)) throw new TypeError('CONTEXT_BUILDER_DUPLICATED');
    this.builders.set(builder.scenarioId, builder);
  }
  build(key: string, snapshot: AwarenessSnapshot): BuiltScenarioContext {
    const builder = this.builders.get(key);
    if (!builder) throw new TypeError('CONTEXT_BUILDER_NOT_FOUND');
    if (snapshot.kind !== 'document_selection' || !snapshot.document_id || typeof snapshot.text !== 'string' || !snapshot.text.trim() || new TextEncoder().encode(snapshot.text).length > 32768) throw new TypeError('SCENARIO_INVALID');
    const scenario = { key, builder_id: builder.id, builder_version: builder.version };
    const context = builder.build(structuredClone(snapshot));
    assertScenarioRequest(scenario, context);
    return { scenario, context: structuredClone(context) };
  }
}
