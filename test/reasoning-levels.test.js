import test from 'node:test';
import assert from 'node:assert/strict';
import { defineAdapter, mapReasoningEffort, DEFAULT_REASONING_LEVEL_MAPS, OMNI_REASONING_LEVELS } from '../packages/octo-runtime-adapter-sdk/dist/index.js';
import { buildClaudeCommand } from '@mininglamp-oss/octo-runtime-adapter-claude-code';
import { buildOpenCodeCommand } from '@mininglamp-oss/octo-runtime-adapter-opencode';
import { buildOpenClawGatewayInvocation } from '@mininglamp-oss/octo-runtime-adapter-openclaw';
import { buildAntigravityCommand } from '@mininglamp-oss/octo-runtime-adapter-antigravity';
import { assertCanonicalEvent } from '@mininglamp-oss/octo-runtime-protocol';

const request = { protocolVersion: 2, invocationId: 'reasoning-test', runId: 'reasoning-run', agentSessionId: 'reasoning-session', agentSource: 'provisioned', context: { schema: 'octo.context-envelope/v3', items: [] }, workdir: process.cwd(), controlInstructions: '', modelInput: 'hello', prompt: 'hello', approvalMode: 'full_access', agentConfig: { effort: 'xhigh' } };

test('four public levels map through immutable adapter defaults; invalid levels never become defaults', () => {
  assert.deepEqual(OMNI_REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh']);
  for (const type of Object.keys(DEFAULT_REASONING_LEVEL_MAPS)) {
    assert.equal(mapReasoningEffort(type, undefined), undefined);
    for (const invalid of ['', 'max', 'xhight', 'HIGH', null, '__proto__']) assert.throws(() => mapReasoningEffort(type, invalid), /REASONING_LEVEL_INVALID/);
  }
  assert.equal(mapReasoningEffort('openclaw', 'xhigh'), 'high');
  assert.equal(mapReasoningEffort('opencode', 'xhigh'), 'high');
  assert.equal(mapReasoningEffort('codex', 'xhigh'), 'xhigh');
  assert.equal(mapReasoningEffort('mcode', 'high'), undefined);
  assert.equal(mapReasoningEffort('__proto__', 'high'), undefined);
  assert.throws(() => { DEFAULT_REASONING_LEVEL_MAPS.openclaw.xhigh = 'xhigh'; }, TypeError);
  assert.equal(mapReasoningEffort('custom', 'xhigh', { low: 'small', medium: 'normal', high: 'large', xhigh: 'large' }), 'large');
});

test('native carriers receive mapped effort while the input request keeps xhigh', async () => {
  const claude = await buildClaudeCommand(request);
  try { assert.equal(claude.args[claude.args.indexOf('--effort') + 1], 'xhigh'); } finally { await claude.cleanup(); }
  const opencode = await buildOpenCodeCommand(request);
  try { assert.equal(opencode.args[opencode.args.indexOf('--variant') + 1], 'high'); } finally { await opencode.cleanup(); }
  const antigravity = buildAntigravityCommand(request);
  assert.equal(antigravity.args[antigravity.args.indexOf('--effort') + 1], 'xhigh');
  const openclaw = buildOpenClawGatewayInvocation({ ...request, agentConfig: { ...request.agentConfig, providerAgentId: 'main', providerOptions: { OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789', OPENCLAW_GATEWAY_TOKEN: 'fixture', OPENCLAW_GATEWAY_DEVICE_ID: 'fixture', OPENCLAW_GATEWAY_PUBLIC_KEY: 'fixture', OPENCLAW_GATEWAY_PRIVATE_KEY: 'fixture' } } });
  assert.equal(openclaw.createParams.thinkingLevel, 'high');
  assert.equal(openclaw.agentParams.thinking, 'high');
  assert.equal(request.agentConfig.effort, 'xhigh');
});

test('mapping and non-application use existing evidence and valid run notices, never claim application', async () => {
  for (const [type, expected] of [['openclaw', 'REASONING_EFFORT_DOWNGRADED'], ['mcode', 'REASONING_EFFORT_NOT_APPLIED']]) {
    let received;
    const adapter = defineAdapter({ metadata: { type, capabilities: [], executionFeatures: [], agentSources: ['provisioned'] }, async *invoke(input) { received = input; yield { protocolVersion: 2, type: 'run.completed', payload: {} }; } });
    const events = [];
    for await (const event of adapter.invoke(request)) { assertCanonicalEvent(event); events.push(event); }
    assert.equal(received, request);
    assert.equal(events[0].payload.params.warningCode, expected);
    assert.equal(events.at(-1).type, 'run.completed');
  }
});

test('ACP override records no native setter even when another transport of the adapter supports effort', async () => {
  const adapter = defineAdapter({ metadata: { type: 'opencode', capabilities: [], executionFeatures: [], agentSources: ['provisioned'] }, async *invoke() { yield { protocolVersion: 2, type: 'run.completed', payload: {} }; } }, null);
  const events = [];
  for await (const event of adapter.invoke(request)) events.push(event);
  assert.equal(events[0].payload.params.warningCode, 'REASONING_EFFORT_NOT_APPLIED');
});

test("adapter wrapper preserves the original invoke receiver and context", async () => {
  const context = { reportActivity() {} };
  const original = {
    metadata: {
      type: "receiver-fixture",
      capabilities: [],
      executionFeatures: [],
      agentSources: ["provisioned"]
    },
    marker: "original receiver",
    async *invoke(input, invocationContext) {
      assert.equal(this, original);
      assert.equal(this.marker, "original receiver");
      assert.equal(input, request);
      assert.equal(invocationContext, context);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  };
  const wrapped = defineAdapter(original, null);
  original.invoke = async function* () {
    throw new Error("replacement invoke must not be called");
  };
  const events = [];
  for await (const event of wrapped.invoke(request, context)) events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
  assert.equal(Object.isFrozen(wrapped), true);
});
