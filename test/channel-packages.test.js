import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImConfig as gatewayConfig, default as gatewayExtra, name as gatewayName } from '@mininglamp-oss/octo-runtime-extra-channel-gateway';
import { validateImConfig as wecomConfig, default as wecomExtra, name as wecomName } from '@mininglamp-oss/octo-runtime-extra-channel-wecom';

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
    await load({ adapterHost: {}, signal: new AbortController().signal, onDispose: dispose => disposers.push(dispose) }, { bots: [] });
    assert.equal(disposers.length, 1);
    await disposers[0]();
  }
});
