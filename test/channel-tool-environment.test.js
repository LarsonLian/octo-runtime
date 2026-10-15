import { preparedFrames } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { PassThrough } from "node:stream";
import { octoCliEnvironment } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
import { configureCliOpenClaw, syncCliOpenClawToolEnvironment } from "@mininglamp-oss/octo-runtime-daemon-app/openclaw";
import { spawnAdapterHost, AdapterHostRpcClient } from "@mininglamp-oss/octo-runtime-adapter-host";
import { assertInvokeRequest, invocationInput, InvokeInput } from "@mininglamp-oss/octo-runtime-protocol";
import { codexEnvironmentConfig } from "../packages/octo-runtime-adapter-codex/dist/environment.js";
import { sanitizePublicValue } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { invokeRequest } from "./runtime-fixture.js";

const token = "bf_tool_fixture";
const base = "https://im-test.deepminer.com.cn";
const context = { schema: "octo.context-envelope/v3", items: [{ namespace: "octo.execution", name: "envs", payload: { env_variables: [
  { key: "OCTO_BOT_TOKEN", value: "wrong-context" }, { key: "OCTO_API_BASE_URL", value: "wrong-context" },
  { key: "EXTRA_TOOL_VALUE", value: "kept" }, { key: "EXPECTED_TOKEN", value: token }
] } }] };

test("channel tool URL normalization removes only the final api segment", () => {
  for (const [input, expected] of [[`${base}/api/`, base], [base, base], [`${base}:8443/api`, `${base}:8443`], [`${base}/api/tools`, `${base}/api/tools`]])
    assert.equal(octoCliEnvironment(input, token).env_variables[1].value, expected);
  for (const input of ["file:///tmp/api", "https://user:pass@example.com/api", `${base}/api?x=1`, `${base}/api#x`])
    assert.throws(() => octoCliEnvironment(input, token), /IM_API_URL_INVALID/);
  assert.throws(() => octoCliEnvironment(base, ""), /IM_BOT_TOKEN_INVALID/);
});

test("tool overrides cross a real Host subprocess and reach child tools without changing Context", async t => {
  const root = await mkdtemp(join(tmpdir(), "octo-tool-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = join(root, "adapters.json");
  await writeFile(manifest, JSON.stringify({ version: 1, adapters: [{ type: "tool-env", module: resolve("test/fixtures/tool-environment-adapter.js"), export: "adapter" }] }));
  const host = await spawnAdapterHost({ entrypoint: resolve("apps/adapter-host/dist/index.js"), manifest,
    env: { ...process.env, OCTO_RUNTIME_HOME: root, OCTO_RUNTIME_DEBUG: "1", OCTO_BOT_TOKEN: "wrong-device", OCTO_API_BASE_URL: "wrong-device" } });
  t.after(() => host.close());
  const original = structuredClone(context);
  const execute = async (value, index) => {
    const ctx = structuredClone(context);
    ctx.items[0].payload.env_variables.find(item => item.key === "EXPECTED_TOKEN").value = value;
    const request = invokeRequest({ invocationId: `tool-${index}`, runId: `tool-${index}`, approvalMode: "full_access", context: ctx });
    const input = invocationInput(request, "canonical");
    input.contexts.items.unshift({ namespace: "octo.execution", name: "adapter", payload: { type: "tool-env" } });
    const events = [];
    for await (const event of host.client.invoke({ ...input, protocol_mode: "canonical" }, { executionEnvOverrides: octoCliEnvironment(`${base}/api`, value) })) events.push(event);
    assert.deepEqual(JSON.parse(events.findLast(event => event.type === "message.update").payload.text), { tokenMatches: true, baseMatches: true, extraKept: true });
  };
  await Promise.all([execute(token, 1), execute("bf_another_fixture", 2)]);
  assert.deepEqual(context, original);
  assert.ok(!(await readFile(join(root, "logs/adapter-host.log"), "utf8")).includes(token));
  const request = invokeRequest({ context, executionEnvOverrides: octoCliEnvironment(`${base}/api`, token) });
  assert.equal(codexEnvironmentConfig(request, {})["shell_environment_policy.set"].OCTO_BOT_TOKEN, token);
  assert.equal(sanitizePublicValue(request).executionEnvOverrides, "[REDACTED]");
  assert.throws(() => InvokeInput.check({ ...invocationInput(request), executionEnvOverrides: request.executionEnvOverrides }), /local invoke environment/);
  for (const invalid of [{ env_variables: [{ key: "BAD-KEY", value: "x" }] }, { env_variables: [{ key: "X", value: "a\0b" }] },
    { env_variables: [{ key: "X", value: "a" }, { key: "X", value: "b" }] }, { env_variables: [{ key: "X", value: "a".repeat(65536) }] }])
    assert.throws(() => assertInvokeRequest({ ...request, executionEnvOverrides: invalid }));
});

test("old Host cannot silently ignore the tool environment", async t => {
  const input = new PassThrough(), output = new PassThrough();
  const client = new AdapterHostRpcClient({ input, output });
  t.after(() => { client.close(); input.destroy(); output.destroy(); });
  let method;
  output.on("data", bytes => {
    const message = JSON.parse(bytes.toString());
    method = message.method;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } }) + "\n");
  });
  await assert.rejects(async () => {
    for await (const frame of preparedFrames(client, "test", invokeRequest({ executionEnvOverrides: octoCliEnvironment(base, token) }))) void frame;
  }, /unknown method/);
  assert.equal(method, "invoke.with-environment");
});

test("OpenClaw CLI updates only two dotenv keys, last Bot wins and different directories stay independent", async t => {
  const root = await mkdtemp(join(tmpdir(), "octo-tool-dotenv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native"), profile = join(root, "profile");
  await mkdir(native);
  await writeFile(join(native, "openclaw.json"), JSON.stringify({ gateway: { port: 19900, auth: { token: "gateway-test" } } }));
  await configureCliOpenClaw(profile, { openclawHome: native });
  const file = join(native, ".env");
  await writeFile(file, '# Keep this comment\nOTHER="line1\nline2"\nexport OCTO_BOT_TOKEN="old\nvalue"\nOCTO_BOT_TOKEN=duplicate\nOCTO_API_BASE_URL=old\n');
  const extra = bots => [{ name: "channel-gateway", config: { bots }, load: async () => ({}) }];
  const bot = (id, credential) => ({ bot_id: id, api_url: `${base}/api/`, bf_token: credential, adapter: { adapter_type: "openclaw" } });
  const credentialFile = join(root, "bot-token");
  await writeFile(credentialFile, "bf_last_fixture\n", { mode: 0o600 });
  const second = { ...bot("second", undefined), bf_token_file: credentialFile };
  const configs = extra([bot("first", token), second, { ...bot("disabled", "bf_disabled"), enabled: false }]);
  assert.equal((await syncCliOpenClawToolEnvironment(profile, configs)).written, true);
  const content = await readFile(file, "utf8");
  assert.deepEqual(parseEnv(content), { OTHER: "line1\nline2", OCTO_BOT_TOKEN: "bf_last_fixture", OCTO_API_BASE_URL: base });
  assert.ok(content.startsWith("# Keep this comment\n"));
  assert.equal((content.match(/OCTO_BOT_TOKEN=/g) ?? []).length, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await syncCliOpenClawToolEnvironment(profile, configs), { file, written: false, restartRequired: true });
  const other = join(root, "other");
  await mkdir(other);
  await writeFile(join(other, "openclaw.json"), JSON.stringify({ gateway: { auth: { token: "other-gateway" } } }));
  await configureCliOpenClaw(join(root, "other-profile"), { openclawHome: other });
  await syncCliOpenClawToolEnvironment(join(root, "other-profile"), extra([bot("first", token)]));
  assert.equal(parseEnv(await readFile(join(other, ".env"), "utf8")).OCTO_BOT_TOKEN, token);
  assert.equal(await readFile(file, "utf8"), content);
  const state = join(root, "state"), custom = join(root, "custom.json"), customProfile = join(root, "custom-profile");
  await mkdir(state);
  await writeFile(custom, JSON.stringify({ gateway: { auth: { token: "custom-gateway" } } }));
  await configureCliOpenClaw(customProfile, {}, { OPENCLAW_CONFIG_PATH: custom, OPENCLAW_STATE_DIR: state });
  await configureCliOpenClaw(customProfile, {}, {});
  const synced = await syncCliOpenClawToolEnvironment(customProfile, extra([bot("custom", token)]));
  assert.equal(synced.file, join(state, ".env"));
  await configureCliOpenClaw(join(root, "remote-profile"), { url: "wss://gateway.example", token: "remote-token" });
  assert.deepEqual(await syncCliOpenClawToolEnvironment(join(root, "remote-profile"), configs), { written: false, restartRequired: false });
});
