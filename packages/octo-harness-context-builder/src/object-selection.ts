import {
  assertContextEnvelope, assertJsonValue, canonicalContext, type ContextEnvelope, type ContextReferenceEntry,
  type ContextSelectionEntry,
} from '@mininglamp-oss/octo-harness-protocol/browser';

export const OBJECT_SELECTION_MAX_ITEMS = 32;
export const OBJECT_SELECTION_MAX_TEXT_BYTES = 32768;
export const SELECTION_OBJECT_TYPES = [
  'task', 'discussion', 'discussion_comment', 'discussion_reply', 'skill', 'local_file', 'drive_file',
] as const;
export type SelectionObjectType = typeof SELECTION_OBJECT_TYPES[number];
export type SelectionOrigin = 'mention' | 'attachment' | 'object_action' | 'source_entity';
export interface ObjectSelection {
  selection_id: string;
  origin: SelectionOrigin;
  object_type: SelectionObjectType;
  object_id: string;
  /** A scope claim is provenance, not authorization. The business adapter must verify it. */
  object_scope?: { type: 'user' | 'teamspace'; id: string };
  label: string;
  intent: 'context' | 'use_capability';
  /** Business adapters validate the object-specific range before collecting material. */
  selector?: { mode: 'core' | 'content' | 'history' | 'chain' | 'metadata'; start?: number; end?: number };
  revision?: string;
}
export type SelectionMaterial = {
  selection_id: string;
} & ({
  kind: 'inline'; text: string; revision?: string;
} | {
  kind: 'reference'; reference: ContextReferenceEntry;
});
export interface ObjectSelectionSnapshot {
  kind: 'object_selection';
  selections: ObjectSelection[];
  materials: SelectionMaterial[];
}

const encoder = new TextEncoder();
const origins = new Set<SelectionOrigin>(['mention', 'attachment', 'object_action', 'source_entity']);
const modes = new Set(['core', 'content', 'history', 'chain', 'metadata']);
function invalid(): never { throw new TypeError('OBJECT_SELECTION_INVALID'); }
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 191 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}
function revision(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 191 && !/[\u0000-\u001f\u007f]/u.test(value));
}

export function assertObjectSelectionSnapshot(value: unknown): asserts value is ObjectSelectionSnapshot {
  assertJsonValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as ObjectSelectionSnapshot;
  if (input.kind !== 'object_selection' || !Array.isArray(input.selections) || !Array.isArray(input.materials)
    || input.selections.length > OBJECT_SELECTION_MAX_ITEMS || input.materials.length > OBJECT_SELECTION_MAX_ITEMS) invalid();
  const selections = new Map<string, ObjectSelection>();
  for (const selection of input.selections) {
    if (!selection || !identifier(selection.selection_id) || !identifier(selection.object_id)
      || !SELECTION_OBJECT_TYPES.includes(selection.object_type) || !origins.has(selection.origin)
      || typeof selection.label !== 'string' || !selection.label.trim() || encoder.encode(selection.label).length > 512
      || !['context', 'use_capability'].includes(selection.intent) || !revision(selection.revision)
      || selections.has(selection.selection_id)) invalid();
    if (selection.intent === 'use_capability' && (selection.object_type !== 'skill' || selection.revision !== undefined || selection.selector !== undefined)) invalid();
    if (selection.object_scope !== undefined && (!selection.object_scope
      || !['user', 'teamspace'].includes(selection.object_scope.type) || !identifier(selection.object_scope.id))) invalid();
    const selector = selection.selector;
    if (selector !== undefined) {
      if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !modes.has(selector.mode)
        || Object.keys(selector).some(key => !['mode', 'start', 'end'].includes(key))
        || [selector.start, selector.end].some(bound => bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0))
        || (selector.start !== undefined && selector.end !== undefined && selector.end < selector.start)) invalid();
    }
    selections.set(selection.selection_id, selection);
  }
  const seen = new Set<string>();
  const references = new Map<string, string>();
  for (const material of input.materials) {
    const selection = material && selections.get(material.selection_id);
    if (!selection || selection.intent !== 'context' || seen.has(material.selection_id)) invalid();
    seen.add(material.selection_id);
    if (material.kind === 'inline') {
      if (typeof material.text !== 'string' || !material.text.trim() || encoder.encode(material.text).length > OBJECT_SELECTION_MAX_TEXT_BYTES
        || !revision(material.revision) || (selection.revision !== undefined && selection.revision !== material.revision)) invalid();
    } else if (material.kind === 'reference') {
      assertContextEnvelope({ schema: 'octo.context-envelope/v3', items: [{ namespace: 'octo.content', name: 'references', payload: { entries: [material.reference] } }] });
      if (selection.revision !== undefined && selection.revision !== material.reference.revision) invalid();
      const ref = material.reference.resource_ref;
      const previous = references.get(ref);
      const identity = materialIdentity(selection);
      if (previous !== undefined && previous !== identity) throw new TypeError('OBJECT_SELECTION_REFERENCE_CONFLICT');
      references.set(ref, identity);
    } else invalid();
  }
  if (input.selections.some(selection => selection.intent === 'context' && !seen.has(selection.selection_id))) {
    throw new TypeError('OBJECT_SELECTION_MATERIAL_MISSING');
  }
}

function materialIdentity(selection: ObjectSelection): string {
  const selector = selection.selector;
  return JSON.stringify([selection.object_type, selection.object_id,
    selection.object_scope ? [selection.object_scope.type, selection.object_scope.id] : null, selection.revision ?? null,
    selector ? [selector.mode, selector.start ?? null, selector.end ?? null] : null]);
}

/** Pure contribution builder. Capture, resolver authorization and preparation belong to the host. */
export function buildObjectSelectionContext(snapshot: ObjectSelectionSnapshot): ContextEnvelope {
  assertObjectSelectionSnapshot(snapshot);
  const inline: ContextSelectionEntry[] = [];
  const references: ContextReferenceEntry[] = [];
  const skills = new Set<string>();
  const materials = new Map(snapshot.materials.map(material => [material.selection_id, material]));
  const prepared = new Map<string, string>();
  const refIds = new Set<string>();
  for (const selection of snapshot.selections) {
    if (selection.intent === 'use_capability') {
      skills.add(selection.object_id);
      continue;
    }
    const material = materials.get(selection.selection_id)!;
    const identity = materialIdentity(selection);
    // Repeated nodes may share one contribution, but cannot select different captured bytes or resolver plans.
    const signature = material.kind === 'inline' ? JSON.stringify(['inline', material.text, material.revision ?? null])
      : canonicalContext({ schema: 'octo.context-envelope/v3', items: [{ namespace: 'octo.content', name: 'references', payload: { entries: [material.reference] } }] });
    if (prepared.has(identity)) {
      if (prepared.get(identity) !== signature) throw new TypeError('OBJECT_SELECTION_SNAPSHOT_CONFLICT');
      continue;
    }
    prepared.set(identity, signature);
    const resourceRef = material.kind === 'inline' ? `selection-${selection.selection_id}` : material.reference.resource_ref;
    if (refIds.has(resourceRef)) throw new TypeError('OBJECT_SELECTION_REFERENCE_CONFLICT');
    refIds.add(resourceRef);
    if (material.kind === 'reference') references.push(structuredClone(material.reference));
    else inline.push({ resource_ref: resourceRef, text: material.text, source: {
      kind: 'object_selection', object_type: selection.object_type, origin: selection.origin,
      // Local handles are host authority and must not be published into model facts.
      ...(selection.object_type === 'local_file' ? {} : { object_id: selection.object_id }),
      ...(selection.object_scope ? { object_scope: { type: selection.object_scope.type, id: selection.object_scope.id } } : {}),
      ...(material.revision ? { revision: material.revision } : {}),
      ...(selection.selector ? { selector: structuredClone(selection.selector) } : {}),
    } });
  }
  const context: ContextEnvelope = { schema: 'octo.context-envelope/v3', items: [] };
  if (inline.length) context.items.push({ namespace: 'octo.content', name: 'inline', payload: { entries: inline } });
  if (references.length) context.items.push({ namespace: 'octo.content', name: 'references', payload: { entries: references } });
  if (skills.size) context.items.push({ namespace: 'octo.resources', name: 'skills', payload: {
    include: [...skills].map(resource_id => ({ resource_id, invoke: true })), exclude: [],
  } });
  assertContextEnvelope(context);
  return context;
}
