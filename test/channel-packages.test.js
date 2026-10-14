import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImConfig as gatewayConfig, default as gatewayExtra, name as gatewayName } from '@mininglamp-oss/octo-runtime-extra-channel-gateway';
import { validateImConfig as wecomConfig, default as wecomExtra, name as wecomName } from '@mininglamp-oss/octo-runtime-extra-channel-wecom';

test('independent channels reject the other platform configuration', () => {
  const common = { bot_id: 'bot', adapter: { workdir: process.cwd() } };
  const gateway = { ...common, type: 'octo', api_url: 'https://im-test.deepminer.com.cn/api' };
  const wecom = { ...common, type: 'wecom' };
  gatewayConfig(gateway);
  wecomConfig(wecom);
  assert.throws(() => gatewayConfig(wecom), /IM_TYPE_INVALID/);
  assert.throws(() => wecomConfig(gateway), /IM_TYPE_INVALID/);
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
