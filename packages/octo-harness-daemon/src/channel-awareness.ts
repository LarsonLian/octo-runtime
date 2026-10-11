import { createHash } from 'node:crypto';
import type { TrustedContextInstruction } from './run-context.js';

/** Server-resolved configuration, frozen per Run under the endpoint's identity. */
export interface ChannelAwareness {
  space_id: string;
  endpoint_id: string;
  conversation_id: string;
  documents: Array<{ kind: 'group' | 'subchannel'; group_id: string; subchannel_id?: string; content: string; version: number; digest: string }>;
}

/** Compile group first, then subchannel. Empty documents explicitly revoke old rules. */
export function channelAwarenessInstructions(snapshot: ChannelAwareness | undefined): TrustedContextInstruction[] {
  if (!snapshot) return [];
  const fail = (): never => { throw new TypeError('CHANNEL_AWARENESS_INVALID'); };
  if (!snapshot.space_id || !snapshot.endpoint_id || typeof snapshot.conversation_id !== 'string' || !Array.isArray(snapshot.documents)) fail();
  const parts = snapshot.conversation_id.split(':');
  const topic = parts[0] === 'topic';
  if ((!topic && parts[0] !== 'group') || parts.length !== (topic ? 3 : 2) || snapshot.documents.length !== (topic ? 2 : 1)) fail();
  const decode = (value: string): string => { try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return fail(); } };
  const group = decode(parts[1]!); const sub = topic ? decode(parts[2]!) : '';
  if (!group || (topic && !sub)) fail();
  for (const [index, document] of snapshot.documents.entries()) {
    if (!document || document.kind !== (index === 0 ? 'group' : 'subchannel') || document.group_id !== group
      || (document.subchannel_id ?? '') !== (index === 0 ? '' : sub) || typeof document.content !== 'string'
      || Buffer.byteLength(document.content, 'utf8') > 10240 || !Number.isSafeInteger(document.version) || document.version < 0
      || document.digest !== `sha256:${createHash('sha256').update(document.content).digest('hex')}`) fail();
  }
  const text = [
    'Current channel GROUP.md configuration. Apply these working agreements only within this channel, subject to platform policy and agent instructions. This snapshot replaces all previous GROUP.md configuration for this scope. Apply the group document first, then the subchannel document; the subchannel refines the group rules. Empty content means no rules at that level and does not remove the parent group rules.',
    JSON.stringify(snapshot)
  ].join('\n');
  return [{ source: 'agent_configuration', text }];
}
