import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";
import { probeCommand } from "../packages/octo-runtime-adapter-sdk/dist/index.js";

test("provider discovery reports real executable path/version, not adapter version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-provider-discovery-"));
  try {
    const command = join(directory, "provider");
    await writeFile(command, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'provider v1.2.3'; fi\n");
    await chmod(command, 0o700);
    const result = await probeCommand(command);
    assert.deepEqual(result, { available: true, command, version: "1.2.3" });
    const host = new AdapterHost();
    host.register({ metadata: { protocolSupport: { protocol: ("codex") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "codex", agentSources: ["provisioned"] },
      probe: () => probeCommand(command), async *invoke() {} });
    assert.deepEqual(await host.describe(), [{ type: "codex", agentSources: ["provisioned"], protocolSupport: { protocol: "codex.canonical", modes: ["canonical"], nativeMethods: [] },
      available: true, providerPath: command, providerVersion: "1.2.3", unavailableReason: null }]);
    assert.ok(host.list().every((adapter) => !Object.hasOwn(adapter, "capabilities")));
    assert.ok([...host.list(), ...await host.describe()].every(adapter =>
      !Object.hasOwn(adapter, "executionFeatures")));
    await mkdir(join(directory, "not-a-command"));
    assert.equal((await probeCommand(join(directory, "not-a-command"))).available, false);
    assert.equal((await probeCommand(join(directory, "missing"))).available, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing and failed probes report unavailable without invented provider metadata", async () => {
  const host = new AdapterHost();
  for (const [type, probe] of [["missing", () => ({ available: false, command: "missing", reason: "command_not_found" })],
    ["failed", () => { throw new Error("probe failed"); }], ["unchecked", undefined]]) {
    host.register({ metadata: { protocolSupport: { protocol: (type) + '.canonical', modes: ['canonical'], nativeMethods: [] }, type, agentSources: ["provisioned"] }, ...(probe ? { probe } : {}), async *invoke() {} });
  }
  for (const provider of await host.describe()) {
    assert.equal(provider.available, false);
    assert.equal(provider.providerPath, null);
    assert.equal(provider.providerVersion, null);
    assert.equal(provider.unavailableReason, { missing: "command_not_found", failed: "probe_failed", unchecked: "probe_missing" }[provider.type]);
  }
});
