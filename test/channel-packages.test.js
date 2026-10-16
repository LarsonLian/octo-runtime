import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredCredential as gatewayCredential, validateImConfig as gatewayConfig, default as gatewayExtra, name as gatewayName } from '@mininglamp-oss/octo-runtime-extra-channel-gateway';
import { configuredCredential as wecomCredential, validateImConfig as wecomConfig, default as wecomExtra, name as wecomName } from '@mininglamp-oss/octo-runtime-extra-channel-wecom';
import { ImChannelManager as GatewayManager } from '../packages/octo-runtime-extra-channel-gateway/dist/lifecycle/manager.js';
import { ImChannelManager as WecomManager } from '../packages/octo-runtime-extra-channel-wecom/dist/lifecycle/manager.js';
import { ExtraPlugins } from '@mininglamp-oss/octo-runtime-daemon';

test('hosts resolve credential storage before passing values to channel SDKs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'octo-host-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credential');
  await writeFile(file, '  bf_host_fixture\n', { mode: 0o600 });
  for (const [readCredential, field] of [[gatewayCredential, 'bf_token'], [wecomCredential, 'app_secret']]) {
    assert.equal(readCredential({ [`${field}_file`]: file }), undefined);
    // 配置来源归宿主；同一 SDK 输入也可以由 SQLite 或 Nacos 取得。
    const config = { [field]: await readFile(file, 'utf8') };
    assert.equal(readCredential(config), 'bf_host_fixture');
    assert.equal(readCredential({ ...config, [`${field}_file`]: '/nonexistent/ignored' }), 'bf_host_fixture');
  }
});

test('independent channels accept Bots without type and validate platform fields', () => {
  const common = { bot_id: 'bot', adapter: { workdir: process.cwd() } };
  const gateway = { ...common, api_url: 'https://im-test.deepminer.com.cn/api' };
  const wecom = { ...common };
  gatewayConfig(gateway);
  wecomConfig(wecom);
  for (const [validate, config] of [[gatewayConfig, gateway], [wecomConfig, wecom]]) {
    validate({ ...config, bot_name: '项目助理' });
    for (const bot_name of ['', '  ', 42, null]) {
      assert.throws(() => validate({ ...config, bot_name }), /IM_BOT_NAME_INVALID/);
    }
  }
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
    await load({ adapterHost: {}, signal: new AbortController().signal, onDispose: dispose => disposers.push(dispose), onStatus: callback => { status = callback; } }, { bots: [] })({});
    assert.deepEqual(status(), { bots: [], errors: [] });
    assert.equal(disposers.length, 2);
    for (const dispose of disposers.reverse()) await dispose();
  }
});

test('channel Extra reports disabled Bots and reloads a full snapshot with explicit authorization', async () => {
  for (const [name, load, Manager, type] of [[gatewayName, gatewayExtra, GatewayManager, 'octo'], [wecomName, wecomExtra, WecomManager, 'wecom']]) {
    const calls = [];
    const original = Manager.prototype.upsert;
    Manager.prototype.upsert = function (bot) {
      calls.push(bot.bot_id);
      this.dependencies.authorizeSpace?.('allowed');
      assert.throws(() => this.dependencies.authorizeSpace?.('other'), /IM_TENANT_NOT_ACTIVE/);
      return original.call(this, bot);
    };
    const bot = id => ({ bot_id: id, ...(id === 'first' ? { bot_name: '项目助理' } : {}), enabled: false, adapter: { adapter_type: 'codex', workdir: process.cwd() }, ...(type === 'octo' ? { api_url: 'https://im-test.deepminer.com.cn/api' } : {}) });
    const registration = bots => ({ name, module: name, load: async () => ({ name, default: load }), config: { bots, authorized_space_ids: ['allowed'] } });
    const extras = new ExtraPlugins([registration([bot('first'), bot('second')])], {});
    try {
      await extras.loadConfigured();
      const status = await extras.inspect(name);
      assert.equal(status.bots.length, 2);
      assert.deepEqual(status.bots.map(bot => bot.bot_name), ['项目助理', 'second']);
      assert.ok(status.bots.every(bot => bot.enabled === false && bot.state === 'stopped' && bot.connected === false));
      await extras.unload(name);
      await extras.load(name, registration([bot('second')]));
      assert.deepEqual(calls, ['first', 'second', 'second']);
      assert.equal((await extras.inspect(name)).bots.length, 1);
      await extras.unload(name);
      await extras.load(name, registration([bot('second'), bot('second'), { ...bot('bad'), adapter: { adapter_type: 42 } }, bot('third')]));
      const partial = await extras.inspect(name);
      assert.equal(extras.status[name].phase, 'loaded');
      assert.equal(partial.bots.filter(bot => bot.state === 'stopped').length, 2);
      assert.equal(partial.bots.filter(bot => bot.state === 'config_error').length, 2);
      assert.equal(partial.errors[0].error, 'IM_BOT_DUPLICATED');
      assert.deepEqual(partial.errors.map(error => error.config_index), [1, 2]);
      await extras.unload(name);
      await extras.load(name, { ...registration([bot('second')]), config: { bots: [bot('second')], authorized_space_ids: 'invalid' } });
      assert.deepEqual((await extras.inspect(name)).errors, [{ error: 'IM_AUTHORIZED_SPACES_INVALID' }]);
      assert.deepEqual((await extras.inspect(name)).bots, []);
    } finally {
      await extras.close();
      Manager.prototype.upsert = original;
    }
  }
});
