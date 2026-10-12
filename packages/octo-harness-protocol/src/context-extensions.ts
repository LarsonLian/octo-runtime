import type { ContextEnvelope, ContextExtensionsSnapshot } from './generated/protocol-types.js';
import { findContextTypeDefinition } from './context-catalog.js';

/** Only Worker-resolved projections may supply extension material. */
export function assertContextExtensionsSnapshot(value: unknown, context?: ContextEnvelope): asserts value is ContextExtensionsSnapshot {
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
  const key = (input: unknown): input is string => typeof input === 'string' && input.length <= 96 && /^[a-z0-9][a-z0-9._-]*$/.test(input);
  const invalid = (): never => { throw new TypeError('CONTEXT_EXTENSIONS_SNAPSHOT_INVALID'); };
  if (!object(value) || Object.keys(value).some(name => !['configuration_version', 'items'].includes(name))
    || typeof value.configuration_version !== 'string' || !value.configuration_version || value.configuration_version.length > 96
    || !Array.isArray(value.items) || value.items.length > 32) invalid();
  const snapshot = value as ContextExtensionsSnapshot;
  const seen = new Set<string>();
  for (const item of snapshot.items) {
    if (!object(item) || Object.keys(item).some(name => !['namespace', 'name', 'status', 'reason', 'text'].includes(name))
      || !key(item.namespace) || !key(item.name) || findContextTypeDefinition(item.namespace, item.name)) invalid();
    const id = `${item.namespace}/${item.name}`;
    if (seen.has(id)) invalid();
    seen.add(id);
    if (item.status === 'material') {
      if (item.namespace === 'octo' || item.namespace.startsWith('octo.') || typeof item.text !== 'string' || !item.text
        || new TextEncoder().encode(item.text).length > 32768 || item.reason !== undefined) invalid();
    } else if (item.status === 'ignored') {
      if (item.text !== undefined || !['not_configured', 'disabled', 'unsupported_version'].includes(item.reason ?? '')) invalid();
    } else invalid();
  }
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 65536) invalid();
  if (context) {
    const expected = context.items.filter(item => !findContextTypeDefinition(item.namespace, item.name)).map(item => `${item.namespace}/${item.name}`);
    if (expected.length !== seen.size || expected.some(id => !seen.has(id))) invalid();
  }
}
