import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenClawAdapter } from '../packages/octo-harness-adapter-openclaw/dist/index.js';
import { assertApprovalRequest } from '../packages/octo-harness-protocol/dist/index.js';

function fixture({ decisions = ['allow-once', 'allow-always', 'deny'], ttl = 60000, snapshot = false } = {}) {
  let listener, finish, session, runId;
  const calls = [];
  const approval = () => ({ id: 'native-1', expiresAtMs: Date.now() + ttl, request: {
    sessionKey: session, runId, toolCallId: 'tool-1', command: 'mkdir /tmp/approval-test', cwd: '/tmp',
    host: 'gateway', warningText: 'Review this command', allowedDecisions: decisions
  } });
  const client = {
    async connect() { return { type: 'hello-ok', protocol: 4, features: {
      methods: ['agents.list', 'sessions.create', 'sessions.messages.subscribe', 'agent', 'agent.wait', 'sessions.abort', 'exec.approval.list', 'exec.approval.resolve'],
      events: ['agent', 'exec.approval.requested', 'exec.approval.resolved']
    } }; },
    onEvent(fn) { listener = fn; return () => {}; },
    async request(method, params, options = {}) {
      calls.push({ method, params });
      if (method === 'agents.list') return { agents: [{ id: 'main' }] };
      if (method === 'sessions.create') { session = params.key; assert.equal(params.permissionMode, 'guarded'); return { key: session }; }
      if (method === 'exec.approval.list') return snapshot ? [approval()] : [];
      if (method === 'agent.wait') return { status: 'ok' };
      if (method === 'exec.approval.resolve') {
        listener({ event: 'exec.approval.resolved', payload: { id: 'native-1', decision: params.decision } });
        return { ok: true };
      }
      if (method === 'agent') {
        runId = params.idempotencyKey;
        options.onAccepted?.({ runId });
        const event = { event: 'exec.approval.requested', payload: approval() };
        listener({ ...event, payload: { ...event.payload, id: 'foreign', request: { ...event.payload.request, sessionKey: 'other' } } });
        listener({ ...event, payload: { ...event.payload, id: 'old-run', request: { ...event.payload.request, runId: 'other' } } });
        listener(event); listener(event);
        return await new Promise(resolve => { finish = () => resolve({ status: 'ok' }); });
      }
      return {};
    }, async close() { finish?.(); }
  };
  const adapter = createOpenClawAdapter({ clientFactory: () => client });
  const request = { protocolVersion: 2, invocationId: 'i', agentSessionId: 's', runId: 'r', modelInput: 'test', prompt: 'test', controlInstructions: '',
    context: { schema: 'octo.context-envelope/v3', items: [] }, approvalMode: 'ask', agentSource: 'preset', workdir: '',
    agentConfig: { providerAgentId: 'main', providerOptions: { OPENCLAW_GATEWAY_URL: 'ws://localhost:1', OPENCLAW_GATEWAY_TOKEN: 'x', OPENCLAW_GATEWAY_DEVICE_ID: 'd', OPENCLAW_GATEWAY_PUBLIC_KEY: 'p', OPENCLAW_GATEWAY_PRIVATE_KEY: 'k' } } };
  const events = [];
  const waiters = [];
  const running = (async () => { for await (const event of adapter.invoke(request)) { events.push(event); waiters.splice(0).forEach(fn => fn()); } })();
  async function until(type) { while (!events.some(event => event.type === type)) await new Promise(resolve => waiters.push(resolve)); return events.find(event => event.type === type); }
  return { adapter, calls, events, running, until, finish: () => finish(), resolveExternally: decision => listener({ event: 'exec.approval.resolved', payload: { id: 'native-1', decision } }) };
}

for (const optionId of ['allow-once', 'allow-always', 'deny']) test(`OpenClaw ${optionId} reaches the original approval, once`, { timeout: 3000 }, async () => {
  const f = fixture({ snapshot: optionId === 'deny' });
  const event = await f.until('interaction.requested');
  assertApprovalRequest(event.payload.request);
  assert.equal(event.payload.request.grantScope, 'provider');
  assert.equal(event.payload.request.providerDetails.reason, 'Review this command');
  await f.adapter.respondInteraction('i', { interactionId: event.payload.interactionId, outcome: optionId === 'deny' ? 'declined' : 'accepted', value: { optionId } });
  await f.until('interaction.resolved');
  f.finish(); await f.running;
  assert.equal(f.events.filter(e => e.type === 'interaction.requested').length, 1);
  assert.deepEqual(f.calls.filter(c => c.method === 'exec.approval.resolve'), [{ method: 'exec.approval.resolve', params: { id: 'native-1', decision: optionId } }]);
  assert.equal(f.events.at(-1).type, 'run.completed');
});

test('OpenClaw rejects unoffered persistent choices without answering the gateway', { timeout: 3000 }, async () => {
  const f = fixture({ decisions: ['allow-once', 'deny'] });
  const event = await f.until('interaction.requested');
  assert.equal(event.payload.request.grantScope, 'request');
  await assert.rejects(f.adapter.respondInteraction('i', { interactionId: event.payload.interactionId, outcome: 'accepted', value: { optionId: 'allow-always' } }), /APPROVAL_OUTCOME_UNSUPPORTED/);
  f.resolveExternally('deny'); await f.until('interaction.resolved'); f.finish(); await f.running;
  assert.equal(f.calls.filter(c => c.method === 'exec.approval.resolve').length, 0);
});

test('a Dashboard decision retires the Work approval without replaying a decision', { timeout: 3000 }, async () => {
  const f = fixture();
  const event = await f.until('interaction.requested');
  f.resolveExternally('allow-once');
  const resolved = await f.until('interaction.resolved');
  assert.equal(resolved.payload.outcome, 'accepted');
  await assert.rejects(f.adapter.respondInteraction('i', { interactionId: event.payload.interactionId, outcome: 'accepted' }), /INTERACTION_NOT_ACTIVE/);
  f.finish(); await f.running;
  assert.equal(f.calls.filter(c => c.method === 'exec.approval.resolve').length, 0);
});

test('provider expiry retires approval and leaves the model free to handle denial', { timeout: 3000 }, async () => {
  const f = fixture({ ttl: 60 });
  await f.until('interaction.requested');
  const resolved = await f.until('interaction.resolved');
  assert.equal(resolved.payload.status, 'expired');
  f.finish(); await f.running;
  assert.equal(f.events.at(-1).type, 'run.completed');
  assert.equal(f.calls.filter(c => c.method === 'exec.approval.resolve').length, 0);
});
