import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  LocalObservability,
  redactCredentials
} from "@mininglamp-oss/octo-harness-observability";

function options(directory, overrides = {}) {
  return {
    directory,
    ...DEFAULT_OBSERVABILITY_CONFIGURATION,
    component: "daemon",
    ...overrides
  };
}

test("local logs roll by calendar day, rotate by size and use owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-logs-"));
  let now = new Date(2026, 0, 2, 10, 0, 0);
  const logger = new LocalObservability(options(directory, { maxFileBytes: 450 }), { now: () => now });
  try {
    logger.log({ level: "info", scope: "test", event: "day.one", message: "x".repeat(350) });
    logger.log({ level: "info", scope: "test", event: "day.one.second", message: "x".repeat(350) });
    await logger.flush();
    now = new Date(2026, 0, 3, 10, 0, 0);
    logger.log({ level: "info", scope: "test", event: "day.two", message: "next day" });
    await logger.flush();

    const firstDay = join(directory, "2026-01-02");
    const secondDay = join(directory, "2026-01-03");
    assert.deepEqual((await readdir(firstDay)).sort(), ["daemon.001.jsonl", "daemon.jsonl"]);
    assert.deepEqual(await readdir(secondDay), ["daemon.jsonl"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(firstDay)).mode & 0o777, 0o700);
      assert.equal((await stat(join(firstDay, "daemon.jsonl"))).mode & 0o777, 0o600);
    }
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("operational logs redact credentials and restricted provider evidence is opt-in to queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-sensitive-logs-"));
  const logger = new LocalObservability(options(directory, {
    logLevel: "debug",
    verbose: true,
    traceRpc: true,
    captureProviderIo: "full",
    requireProviderCapture: true
  }));
  try {
    logger.log({
      level: "info",
      scope: "test",
      event: "credentials.checked",
      message: "credential redaction",
      runId: "run-1",
      data: { Authorization: "Bearer must-not-leak", nested: { access_token: "also-secret", result: "ok" } }
    });
    logger.traceRpc("send", JSON.stringify({
      id: "rpc-1",
      method: "invoke",
      params: {
        apiKey: "rpc-secret",
        adapterType: "codex",
        request: { runId: "run-1", invocationId: "inv-1", sessionId: "session-1" }
      }
    }));
    logger.traceRpc("receive", JSON.stringify({
      method: "invoke.event",
      params: {
        invocationId: "inv-1",
        event: {
          type: "message.delta",
          payload: {
            channel: "analysis",
            exposure: "private_reasoning",
            text: "private-chain-of-thought-must-not-be-stored"
          }
        }
      }
    }));
    const receipt = await logger.observeProvider({
      runId: "run-1",
      invocationId: "inv-1",
      sessionId: "session-1",
      adapterType: "codex"
    }, {
      event: "provider.input",
      rpcMethod: "turn/start",
      carrier: { kind: "json_params", content: { prompt: "evaluate this exact prompt", authToken: "provider-secret" } }
    });

    assert.equal(receipt.state, "durable");
    assert.equal(receipt.complete, true);
    const ordinary = await logger.query({ runId: "run-1" });
    assert.deepEqual(ordinary.map(record => record.event), ["credentials.checked"]);
    assert.equal(ordinary[0].data.Authorization, "[redacted]");
    assert.equal(ordinary[0].data.nested.access_token, "[redacted]");

    const sensitive = await logger.query({ runId: "run-1", includeSensitive: true });
    assert.ok(sensitive.some(record => record.event === "rpc.frame"));
    assert.doesNotMatch(JSON.stringify(sensitive), /private-chain-of-thought-must-not-be-stored/);
    const reasoningFrame = sensitive.find(record =>
      record.event === "rpc.frame" && record.data.frame?.params?.event?.payload?.body_omitted === true
    );
    assert.equal(reasoningFrame.data.frame.params.event.payload.text, undefined);
    const provider = sensitive.find(record => record.event === "provider.input");
    assert.equal(provider.adapter_type, "codex");
    assert.equal(provider.data.projection.content.prompt, "evaluate this exact prompt");
    assert.equal(provider.data.projection.content.authToken, "[redacted]");
    const day = (await readdir(directory)).find(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry));
    const providerPath = join(directory, day, "evaluation", "provider-io.jsonl");
    assert.match(await readFile(providerPath, "utf8"), /provider\.input/);
    assert.equal((await logger.query({ limit: Number.NaN })).length > 0, true);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential redaction covers nested keys, env, argv forms and URL credentials", () => {
  const redacted = redactCredentials({
    headers: { Authorization: "Bearer header-secret", "x-api-key": "api-secret" },
    env: { NORMAL: "kept", ACCESS_TOKEN: "env-secret" },
    args: ["--model", "gpt", "--auth-token=one", "--client-secret", "two"],
    endpointUrl: "https://user:pass@example.test/v1?access_token=url-secret&mode=stream",
    inlineConfig: { nested: { aws_secret_access_key: "config-secret", region: "cn" } }
  });

  assert.equal(redacted.headers.Authorization, "[redacted]");
  assert.equal(redacted.headers["x-api-key"], "[redacted]");
  assert.deepEqual(redacted.env, { NORMAL: "kept", ACCESS_TOKEN: "[redacted]" });
  assert.deepEqual(redacted.args, ["--model", "gpt", "--auth-token=[redacted]", "--client-secret", "[redacted]"]);
  assert.match(redacted.endpointUrl, /^https:\/\/%5Bredacted%5D:%5Bredacted%5D@example\.test\/v1\?/);
  assert.doesNotMatch(redacted.endpointUrl, /url-secret|user:pass/);
  assert.match(redacted.endpointUrl, /mode=stream/);
  assert.equal(redacted.inlineConfig.nested.aws_secret_access_key, "[redacted]");
});

test("strict provider capture fails closed on a symlinked log root", async t => {
  if (process.platform === "win32") return t.skip("symlink ownership semantics differ on Windows");
  const directory = await mkdtemp(join(tmpdir(), "oh-log-symlink-"));
  const target = join(directory, "target");
  const logRoot = join(directory, "logs");
  await symlink(target, logRoot);
  const degraded = [];
  const logger = new LocalObservability(options(logRoot, {
    captureProviderIo: "input",
    requireProviderCapture: true
  }), { stderr: line => degraded.push(line) });
  try {
    await assert.rejects(
      logger.observeProvider({
        runId: "run-strict",
        invocationId: "inv-strict",
        sessionId: "session-strict",
        adapterType: "codex"
      }, {
        event: "provider.input",
        carrier: { kind: "json_params", content: { prompt: "must not dispatch" } }
      }),
      error => error.code === "trace_capture_failed"
    );
    assert.equal(logger.status.degraded, true);
    assert.equal(degraded.length, 1);
    await assert.rejects(stat(target));
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
