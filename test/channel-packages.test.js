import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImConfig as gatewayConfig, default as gatewayExtra, name as gatewayName } from '@mininglamp-oss/octo-runtime-extra-channel-gateway';
import { validateImConfig as wecomConfig, default as wecomExtra, name as wecomName } from '@mininglamp-oss/octo-runtime-extra-channel-wecom';
import { ImChannelManager as GatewayManager } from '../packages/octo-runtime-extra-channel-gateway/dist/lifecycle/manager.js';
import { ImChannelManager as WecomManager } from '../packages/octo-runtime-extra-channel-wecom/dist/lifecycle/manager.js';
import { ExtraPlugins } from '@mininglamp-oss/octo-runtime-daemon';

test('independent channels accept Bots without type and validate platform fields', () => {
  const common = { bot_id: 'bot', adapter: { workdir: process.cwd() } };
  const gateway = { ...common, api_url: 'https://im-test.deepminer.com.cn/api' };
  const wecom = { ...common };
  gatewayConfig(gateway);
  wecomConfig(wecom);
  for (const validate of [gatewayConfig, wecomConfig]) {
    for (const invalid of [null, [], 'octo']) assert.throws(() => validate(invalid), /IM_CONFIG_INVALID/);
  }
  assert.throws(() => gatewayConfig(wecom), /IM_API_URL_INVALID/);
  assert.throws(() => wecomConfig(gateway), /IM_CONFIG_UNKNOWN_FIELD/);
});

test('both channels load as extras and dispose their own resources', async () => {
  for (const [name, load] of [[gatewayName, gatewayExtra], [wecomName, wecomExtra]]) {
    assert.ok(['channel-gateway', 'channel-wecom'].includes(name));
    const disposers = [];
    let status;
    await load({ adapterHost: {}, signal: new AbortController().signal, onDispose: dispose => disposers.push(dispose), onStatus: callback => { status = callback; }, onConfigure() {}, onRequest() {} }, { bots: [] });
    assert.deepEqual(status(), { bots: [], errors: [] });
    assert.equal(disposers.length, 1);
    await disposers[0]();
  }
});

test('channel Extra applies full Bot snapshots incrementally and preserves explicit authorization', async () => {
  for (const [name, load, Manager, type] of [[gatewayName, gatewayExtra, GatewayManager, 'octo'], [wecomName, wecomExtra, WecomManager, 'wecom']]) {
    const calls = [];
    const original = Manager.prototype.upsert;
    Manager.prototype.upsert = function (bot) {
      calls.push(bot.bot_id);
      this.dependencies.authorizeSpace?.('allowed');
      assert.throws(() => this.dependencies.authorizeSpace?.('other'), /IM_TENANT_NOT_ACTIVE/);
      return original.call(this, bot);
    };
    const bot = id => ({ bot_id: id, enabled: false, adapter: { adapter_type: 'codex', workdir: process.cwd() }, ...(type === 'octo' ? { api_url: 'https://im-test.deepminer.com.cn/api' } : {}) });
    const registration = bots => ({ name, module: name, load: async () => ({ name, default: load }), config: { bots, authorized_space_ids: ['allowed'] } });
    const extras = new ExtraPlugins([registration([bot('first'), bot('second')])], {});
    try {
      await extras.loadConfigured();
      await extras.configure(registration([bot('first'), { ...bot('second'), adapter: { ...bot('second').adapter, effort: 'high' } }]));
      assert.deepEqual(calls, ['first', 'second', 'second']);
      assert.equal((await extras.request(name, 'status')).length, 2);
      await extras.configure(registration([bot('second')]));
      assert.equal((await extras.request(name, 'status')).length, 1);
      await assert.rejects(extras.configure(registration([bot('second'), bot('second')])), /IM_BOT_DUPLICATED/);
      assert.equal((await extras.request(name, 'status')).length, 1);
      await assert.rejects(extras.request(name, 'unknown'), /IM_EXTRA_METHOD_NOT_FOUND/);
    } finally {
      await extras.close();
      Manager.prototype.upsert = original;
    }
  }
});
