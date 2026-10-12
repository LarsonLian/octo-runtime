import { assertScenarioRequest, type ContextEnvelope, type ScenarioRequest } from '@mininglamp-oss/octo-harness-protocol/browser';
import { assertObjectSelectionSnapshot, type ObjectSelectionSnapshot } from './object-selection.js';
export * from './object-selection.js';
export * from './providers.js';
export const CONTEXT_BUILDER_SCHEMA = 'octo.context-builder/v1';
export interface DocumentSelectionSnapshot { kind: 'document_selection'; document_id: string; document_version?: string; text: string }
export type AwarenessSnapshot = DocumentSelectionSnapshot | ObjectSelectionSnapshot;
export type ContextBuilder<Snapshot extends AwarenessSnapshot = DocumentSelectionSnapshot> = {
  id: string; version: string; scenarioId: string; build(awareness: Snapshot): ContextEnvelope
} & (Snapshot extends DocumentSelectionSnapshot ? { snapshotKind?: 'document_selection' } : { snapshotKind: 'object_selection' });
export interface BuiltScenarioContext { scenario: ScenarioRequest; context: ContextEnvelope }
/** Pure local registry: the host owns capture and submission. */
export class ContextBuilderRegistry {
  private readonly builders = new Map<string, { id: string; version: string; kind: AwarenessSnapshot['kind']; build(snapshot: AwarenessSnapshot): ContextEnvelope }>();
  register<Snapshot extends AwarenessSnapshot>(builder: ContextBuilder<Snapshot>): void {
    assertScenarioRequest({ scenario_id: builder.scenarioId, builder_id: builder.id, builder_version: builder.version });
    if (this.builders.has(builder.scenarioId)) throw new TypeError('CONTEXT_BUILDER_DUPLICATED');
    this.builders.set(builder.scenarioId, { id: builder.id, version: builder.version,
      kind: builder.snapshotKind ?? 'document_selection', build: snapshot => builder.build(snapshot as Snapshot) });
  }
  build(scenarioId: string, snapshot: AwarenessSnapshot): BuiltScenarioContext {
    const builder = this.builders.get(scenarioId);
    if (!builder) throw new TypeError('CONTEXT_BUILDER_NOT_FOUND');
    if (!snapshot || snapshot.kind !== builder.kind) throw new TypeError('SCENARIO_INVALID');
    if (snapshot.kind === 'object_selection') assertObjectSelectionSnapshot(snapshot);
    else if (!snapshot.document_id || typeof snapshot.text !== 'string' || !snapshot.text.trim() || new TextEncoder().encode(snapshot.text).length > 32768) throw new TypeError('SCENARIO_INVALID');
    const scenario = { scenario_id: scenarioId, builder_id: builder.id, builder_version: builder.version };
    const context = builder.build(structuredClone(snapshot));
    assertScenarioRequest(scenario, context);
    return { scenario, context: structuredClone(context) };
  }
}
