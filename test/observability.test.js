import test from "node:test";
import assert from "node:assert/strict";
import { access, appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  LocalObservability,
  redactCredentials,
  redactCredentialsWithMetadata,
  writeMinimalCrashReport
} from "@mininglamp-oss/octo-harness-observability";
import { assertInvokeRequest } from "@mininglamp-oss/octo-harness-protocol";

function options(directory, overrides = {}) {
  return {
    directory,
    ...DEFAULT_OBSERVABILITY_CONFIGURATION,
    component: "daemon",
    ...overrides
  };
}

function rpcInvokeRequest(overrides = {}) {
  const request = {
    protocolVersion: 2,
    invocationId: "inv-1",
    agentSessionKey: "session-1",
    runKey: "run-1",
    prompt: "work",
    modelInput: "work",
    controlInstructions: "",
    workdir: process.cwd(),
    context: { schema: "octo.context-envelope/v3", items: [] },
    runMetadata: { profile: "work", runtimeKey: "runtime-work" },
    approvalMode: "full_access",
    agentSource: "provisioned", agentConfig: {},
    ...overrides
  };
  assertInvokeRequest(request);
  return request;
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
  const operational = [];
  const logger = new LocalObservability(options(directory, {
    logLevel: "debug",
    verbose: true,
    traceRpc: true,
    captureProviderIo: "full",
    requireProviderCapture: true
  }), { operationalSink: record => operational.push(record) });
  try {
    logger.log({
      level: "info",
      scope: "test",
      event: "credentials.checked",
      message: "credential redaction",
      runKey: "run-1",
      data: { Authorization: "Bearer must-not-leak", nested: { access_token: "also-secret", result: "ok" } }
    });
    logger.traceRpc("send", JSON.stringify({
      id: "rpc-1",
      method: "invoke",
      params: {
        apiKey: "rpc-secret",
        adapterType: "codex",
        request: rpcInvokeRequest()
      }
    }));
    logger.traceRpc("receive", JSON.stringify({
      method: "invoke.event",
      params: {
        invocationId: "inv-1",
        event: { protocolVersion: 2,
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
      profile: "work",
      runtimeKey: "runtime-work",
      runKey: "run-1",
      invocationId: "inv-1",
      agentSessionKey: "session-1",
      adapterType: "codex"
    }, {
      event: "provider.input",
      rpcMethod: "turn/start",
      carrier: { kind: "json_params", content: { prompt: "evaluate this exact prompt", authToken: "provider-secret" } }
    });

    assert.equal(receipt.state, "durable");
    assert.equal(receipt.complete, true);
    const ordinary = await logger.query({ runKey: "run-1" });
    assert.deepEqual(ordinary.map(record => record.event), ["credentials.checked"]);
    assert.equal(ordinary[0].data.Authorization, undefined);
    assert.equal(ordinary[0].data.nested.access_token, undefined);
    assert.equal(ordinary[0].data._redaction.redacted, true);
    assert.deepEqual(operational.map(record => record.event), ["credentials.checked"]);
    assert.doesNotMatch(JSON.stringify(operational), /must-not-leak|also-secret/);

    const sensitive = await logger.query({ runKey: "run-1", includeSensitive: true });
    assert.ok(sensitive.some(record => record.event === "rpc.frame"));
    assert.ok(sensitive.filter(record => record.event === "rpc.frame")
      .every(record => record.profile === "work" && record.runtime_key === "runtime-work"));
    const rpcFrames = sensitive.filter(record => record.event === "rpc.frame");
    assert.equal(rpcFrames.length, 2);
    assert.deepEqual(rpcFrames.map(record => [record.data.direction, record.run_key, record.invocation_id, record.agent_session_key, record.adapter_type]), [
      ["send", "run-1", "inv-1", "session-1", "codex"],
      ["receive", "run-1", "inv-1", "session-1", "codex"]
    ]);
    assert.deepEqual(rpcFrames[0].data.frame.params.request.runMetadata, { profile: "work", runtimeKey: "runtime-work" });
    assert.deepEqual(rpcFrames[0].data.frame.params.request.context, { schema: "octo.context-envelope/v3", items: [] });
    assert.equal(rpcFrames[0].data.frame.params.apiKey, undefined);
    assert.doesNotMatch(JSON.stringify(sensitive), /private-chain-of-thought-must-not-be-stored|must-not-leak|also-secret|rpc-secret|provider-secret/);
    const reasoningFrame = sensitive.find(record =>
      record.event === "rpc.frame" && record.data.frame?.params?.event?.payload?.body_omitted === true
    );
    assert.equal(reasoningFrame.data.frame.params.event.payload.text, undefined);
    const provider = sensitive.find(record => record.event === "provider.input");
    assert.equal(provider.profile, "work");
    assert.equal(provider.runtime_key, "runtime-work");
    assert.equal(provider.adapter_type, "codex");
    assert.equal(provider.data.projection.content.prompt, "evaluate this exact prompt");
    assert.equal(provider.data.projection.content.authToken, undefined);
    assert.deepEqual(provider.data.projection.excluded_credential_paths, ["$.authtoken"]);
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
  const source = {
    headers: { Authorization: "Bearer header-secret", "x-api-key": "api-secret" },
    env: { NORMAL: "kept", ACCESS_TOKEN: "env-secret" },
    args: [
      "--model", "gpt", "--auth-token=one", "--client-secret", "two",
      "--endpoint-url", "https://user:pass@example.test/v1?access_token=argv-secret&mode=stream",
      "--callback-url=https://name:word@example.test/hook?api_key=callback-secret&ok=1"
    ],
    endpointUrl: "https://user:pass@example.test/v1?access_token=url-secret&mode=stream",
    inlineConfig: { nested: { aws_secret_access_key: "config-secret", region: "cn" } },
    jsonConfig: JSON.stringify({ apiKey: "json-secret", region: "us" }),
    yamlConfig: "api_key: yaml-secret\nregion: eu\n",
    tomlConfig: 'api_key = "toml-secret"\nregion = "ap"\n'
  };
  const result = redactCredentialsWithMetadata(source);
  const redacted = result.value;

  assert.equal(redacted.headers.Authorization, undefined);
  assert.equal(redacted.headers["x-api-key"], undefined);
  assert.deepEqual(redacted.env, { NORMAL: "kept" });
  assert.equal(redacted.args[2], "--auth-token=[redacted]");
  assert.equal(redacted.args[4], "[redacted]");
  assert.match(redacted.args[6], /^https:\/\/example\.test\/v1\?/);
  assert.doesNotMatch(redacted.args[6], /argv-secret|user:pass/);
  assert.match(redacted.args[7], /^--callback-url=https:\/\/example\.test\/hook\?/);
  assert.doesNotMatch(redacted.args[7], /callback-secret|name:word/);
  assert.match(redacted.endpointUrl, /^https:\/\/example\.test\/v1\?/);
  assert.doesNotMatch(redacted.endpointUrl, /url-secret|user:pass/);
  assert.match(redacted.endpointUrl, /mode=stream/);
  assert.equal(redacted.inlineConfig.nested.aws_secret_access_key, undefined);
  assert.deepEqual(JSON.parse(redacted.jsonConfig), { region: "us" });
  assert.doesNotMatch(redacted.yamlConfig, /api.?key|yaml-secret/i);
  assert.match(redacted.yamlConfig, /region: eu/);
  assert.doesNotMatch(redacted.tomlConfig, /api.?key|toml-secret/i);
  assert.match(redacted.tomlConfig, /region\s*=\s*["']ap["']/);
  assert.equal(result.complete, true);
  assert.ok(result.excludedCredentialPaths.includes("$.headers.authorization"));
  assert.ok(result.excludedCredentialPaths.includes("$.endpointurl.userinfo"));
  assert.doesNotMatch(
    JSON.stringify(redactCredentials(source)),
    /header-secret|api-secret|env-secret|url-secret|config-secret|argv-secret|callback-secret|json-secret|yaml-secret|toml-secret/
  );
});

test("unparseable inline configuration is omitted and marked incomplete", () => {
  const canary = "INLINE_CONFIG_SECRET";
  const redaction = redactCredentialsWithMetadata({ inlineConfig: `apiKey: [${canary}` });
  assert.deepEqual(redaction.value, {});
  assert.equal(redaction.complete, false);
  assert.deepEqual(redaction.excludedCredentialPaths, ["$.inlineconfig"]);
  assert.doesNotMatch(JSON.stringify(redaction), new RegExp(canary));
});

test("unparseable URL-shaped carriers are omitted and mark provider capture incomplete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-unparseable-carrier-"));
  const ambiguous = "https://user:credential@[broken-host";
  const redaction = redactCredentialsWithMetadata({ endpointUrl: ambiguous, mode: "stream" });
  assert.deepEqual(redaction.value, { mode: "stream" });
  assert.equal(redaction.complete, false);
  assert.deepEqual(redaction.excludedCredentialPaths, ["$.endpointurl"]);
  assert.doesNotMatch(JSON.stringify(redaction), /user:credential/);

  const logger = new LocalObservability(options(directory, { captureProviderIo: "input" }));
  try {
    const receipt = await logger.observeProvider({
      runKey: "run-incomplete",
      invocationId: "inv-incomplete",
      agentSessionKey: "session-incomplete",
      adapterType: "codex"
    }, {
      event: "provider.input",
      carrier: { kind: "json_params", content: { endpointUrl: ambiguous, prompt: "safe" } }
    });
    assert.equal(receipt.complete, false);
    await logger.flush();
    const records = await logger.query({ runKey: "run-incomplete", includeSensitive: true });
    const input = records.find(record => record.event === "provider.input");
    const failed = records.find(record => record.event === "capture.receipt");
    assert.equal(input.data.projection.content.endpointUrl, undefined);
    assert.equal(input.data.projection.complete, false);
    assert.equal(failed.data.capture_id, receipt.captureId);
    assert.equal(failed.data.state, "failed");
    assert.doesNotMatch(JSON.stringify(records), /user:credential/);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC correlation expires after its 24 hour TTL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-correlation-ttl-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const records = [];
  const logger = new LocalObservability(options(directory, { fileLog: false }), {
    now: () => now,
    eventSink: record => records.push(record)
  });
  try {
    logger.traceRpc("send", JSON.stringify({
      id: 1,
      method: "invoke",
      params: { request: rpcInvokeRequest({ runKey: "run-expired", invocationId: "inv-expired" }) }
    }));
    now = new Date("2026-01-02T01:00:00.000Z");
    logger.traceRpc("receive", JSON.stringify({ id: 2, result: {} }));
    logger.traceRpc("receive", JSON.stringify({ id: 1, result: {} }));
    const response = records.at(-1);
    assert.equal(response.event, "rpc.frame");
    assert.equal(response.run_key, undefined);
    assert.equal(response.profile, undefined);
    assert.equal(response.runtime_key, undefined);
    assert.equal(response.invocation_id, undefined);
    assert.ok(records.some(record => record.event === "bus.correlation_gap"));
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("full provider output capture strips private reasoning even when an adapter does not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-private-output-"));
  const logger = new LocalObservability(options(directory, { captureProviderIo: "full" }));
  try {
    await logger.observeProvider({
      runKey: "run-private-output",
      invocationId: "inv-private-output",
      agentSessionKey: "session-private-output",
      adapterType: "codex"
    }, {
      event: "provider.output",
      rpcMethod: "item/reasoning/textDelta",
      data: {
        native: { method: "item/reasoning/textDelta", params: { delta: "private-native-body" } },
        canonical: { protocolVersion: 2,
          type: "message.delta",
          payload: { channel: "analysis", exposure: "private_reasoning", text: "private-canonical-body" }
        }
      }
    });
    await logger.flush();
    const records = await logger.query({ runKey: "run-private-output", includeSensitive: true });
    const output = records.find(record => record.event === "provider.output");
    assert.ok(output);
    assert.equal(output.data.native.body_omitted, true);
    assert.equal(output.data.native.method, "item/reasoning/textDelta");
    assert.equal(output.data.canonical.payload.body_omitted, true);
    assert.match(output.data.canonical.payload.body_sha256, /^sha256:/);
    assert.doesNotMatch(JSON.stringify(records), /private-native-body|private-canonical-body/);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
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
        runKey: "run-strict",
        invocationId: "inv-strict",
        agentSessionKey: "session-strict",
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

test("strict provider capture fails closed on a symlinked target file", async t => {
  if (process.platform === "win32") return t.skip("symlink ownership semantics differ on Windows");
  const directory = await mkdtemp(join(tmpdir(), "oh-log-target-symlink-"));
  const now = new Date(2026, 0, 2, 10, 0, 0);
  const evaluation = join(directory, "2026-01-02", "evaluation");
  const target = join(directory, "outside.jsonl");
  await mkdir(evaluation, { recursive: true, mode: 0o700 });
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, join(evaluation, "provider-io.jsonl"));
  const logger = new LocalObservability(options(directory, {
    captureProviderIo: "input",
    requireProviderCapture: true
  }), { now: () => now, stderr: () => undefined });
  try {
    await assert.rejects(
      logger.observeProvider({
        runKey: "run-target-symlink",
        invocationId: "inv-target-symlink",
        agentSessionKey: "session-target-symlink",
        adapterType: "codex"
      }, {
        event: "provider.input",
        carrier: { kind: "json_params", content: { prompt: "must not dispatch" } }
      }),
      error => error.code === "trace_capture_failed"
    );
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("minimal crash reports omit exception messages and sensitive process inputs", async t => {
  if (process.platform === "win32") return t.skip("O_NOFOLLOW and directory fsync are required");
  const directory = await mkdtemp(join(tmpdir(), "oh-crash-report-"));
  const canary = "crash-canary-must-never-persist";
  try {
    const error = Object.assign(new TypeError(`ordinary summary\n${canary}`), { code: "E_CRASH_TEST" });
    const path = writeMinimalCrashReport({
      directory,
      component: "daemon",
      now: () => new Date("2026-09-06T08:30:12.123Z")
    }, error, "unhandledRejection");
    const content = await readFile(path, "utf8");
    const report = JSON.parse(content);
    assert.equal(report.ts, "2026-09-06T08:30:12.123Z");
    assert.equal(report.event, "process.crash");
    assert.equal(report.component, "daemon");
    assert.equal(report.origin, "unhandledRejection");
    assert.equal(report.error.name, "TypeError");
    assert.equal(report.error.code, "E_CRASH_TEST");
    assert.equal(report.error.message, undefined);
    assert.equal(report.process.argv, undefined);
    assert.equal(report.process.cwd, undefined);
    assert.equal(report.process.env, undefined);
    assert.doesNotMatch(content, new RegExp(canary));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(directory, "crash"))).mode & 0o777, 0o700);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted capture records a same-id failed receipt and degraded status after EACCES", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-capture-eacces-"));
  const attempts = [];
  const failure = Object.assign(new Error("injected permission failure"), { code: "EACCES" });
  const logger = new LocalObservability(options(directory, { captureProviderIo: "input" }), {
    async append(path, line) {
      const record = JSON.parse(line);
      attempts.push(record);
      if (record.event === "provider.input") throw failure;
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
    }
  });
  try {
    const receipt = await logger.observeProvider({
      runKey: "run-eacces",
      invocationId: "inv-eacces",
      agentSessionKey: "session-eacces",
      adapterType: "codex"
    }, {
      event: "provider.input",
      carrier: { kind: "json_params", content: { prompt: "safe" } }
    });
    assert.equal(receipt.state, "accepted");
    await logger.flush();
    assert.equal(logger.status.degraded, true);
    assert.equal(logger.status.degradedReason, "EACCES");
    const failed = attempts.find(record => record.event === "capture.receipt");
    assert.equal(failed.data.capture_id, receipt.captureId);
    assert.equal(failed.data.state, "failed");
    assert.equal(failed.data.complete, false);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict provider capture reports ENOSPC before dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-capture-enospc-"));
  const logger = new LocalObservability(options(directory, {
    captureProviderIo: "input",
    requireProviderCapture: true
  }), {
    append: async () => { throw Object.assign(new Error("injected disk full"), { code: "ENOSPC" }); }
  });
  try {
    await assert.rejects(
      logger.observeProvider({
        runKey: "run-enospc",
        invocationId: "inv-enospc",
        agentSessionKey: "session-enospc",
        adapterType: "codex"
      }, {
        event: "provider.input",
        carrier: { kind: "json_params", content: { prompt: "must not dispatch" } }
      }),
      error => error.code === "trace_capture_failed"
    );
    assert.equal(logger.status.degraded, true);
    assert.equal(logger.status.degradedReason, "ENOSPC");
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("constructor rejects inconsistent strict-capture policy and invalid runtime values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-invalid-options-"));
  try {
    assert.throws(
      () => new LocalObservability(options(directory, {
        fileLog: false,
        captureProviderIo: "input",
        requireProviderCapture: true
      })),
      /strict provider capture requires fileLog/
    );
    assert.throws(
      () => new LocalObservability(options(directory, { requireProviderCapture: true })),
      /strict provider capture requires provider input capture/
    );
    assert.throws(
      () => new LocalObservability(options(directory, { retentionDays: 0 })),
      /retentionDays must be a positive safe integer/
    );
    assert.throws(
      () => new LocalObservability(options(directory, { maxFileBytes: Number.NaN })),
      /maxFileBytes must be a positive safe integer/
    );
    assert.throws(
      () => new LocalObservability(options(directory, { logLevel: "verbose" })),
      /logLevel is invalid/
    );
    assert.throws(
      () => new LocalObservability(options(directory, { captureProviderIo: "everything" })),
      /captureProviderIo is invalid/
    );
    assert.throws(
      () => new LocalObservability(options(directory), { maintenanceIntervalMs: -1 }),
      /maintenanceIntervalMs must be a non-negative safe integer/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict capture immediately observes startup capacity before provider dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-startup-strict-capacity-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const inputPath = join(directory, "2026-01-10", "evaluation", "provider-io.jsonl");
  await writeLog(join(directory, "2026-01-10", "daemon.jsonl"), now.toISOString(), "current.seed", 300);
  const logger = new LocalObservability(options(directory, {
    captureProviderIo: "input",
    requireProviderCapture: true,
    maxTotalBytes: 100
  }), { now: () => now, stderr: () => undefined });
  try {
    await assert.rejects(
      logger.observeProvider({
        runKey: "run-startup-capacity",
        invocationId: "inv-startup-capacity",
        agentSessionKey: "session-startup-capacity",
        adapterType: "codex"
      }, {
        event: "provider.input",
        carrier: { kind: "json_params", content: { prompt: "must not dispatch" } }
      }),
      error => error.code === "trace_capture_failed"
    );
    await assert.rejects(access(inputPath));
    assert.equal(logger.status.degraded, true);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup maintenance keeps exactly the configured local-day buckets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-retention-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const oldDay = "2026-01-07";
  const boundaryDay = "2026-01-08";
  const oldOperational = join(directory, oldDay, "daemon.jsonl");
  const keptOperational = join(directory, boundaryDay, "daemon.jsonl");
  const oldEvaluation = join(directory, oldDay, "evaluation", "provider-io.jsonl");
  const keptEvaluation = join(directory, boundaryDay, "evaluation", "provider-io.jsonl");
  const oldCrash = join(directory, "crash", "old.json");
  const keptCrash = join(directory, "crash", "kept.json");
  await writeLog(oldOperational, new Date(2026, 0, 7, 12).toISOString(), "old.operational");
  await writeLog(keptOperational, new Date(2026, 0, 8, 12).toISOString(), "kept.operational");
  await writeLog(oldEvaluation, new Date(2026, 0, 7, 12).toISOString(), "old.evaluation");
  await writeLog(keptEvaluation, new Date(2026, 0, 8, 12).toISOString(), "kept.evaluation");
  await writeLog(oldCrash, new Date(2026, 0, 7, 12).toISOString(), "old.crash");
  await writeLog(keptCrash, new Date(2026, 0, 8, 12).toISOString(), "kept.crash");

  const logger = new LocalObservability(options(directory, {
    retentionDays: 3,
    traceRetentionDays: 3,
    crashRetentionDays: 3
  }), { now: () => now });
  try {
    await logger.flush();
    for (const path of [oldOperational, oldEvaluation, oldCrash]) await assert.rejects(access(path));
    for (const path of [keptOperational, keptEvaluation, keptCrash]) await access(path);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capacity cleanup removes old evaluation first and suppresses current-day debug records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-capacity-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const priorOperational = join(directory, "2026-01-09", "daemon.jsonl");
  const priorEvaluation = join(directory, "2026-01-09", "evaluation", "provider-io.jsonl");
  await writeLog(priorOperational, new Date(2026, 0, 9, 12).toISOString(), "prior.operational", 180);
  await writeLog(priorEvaluation, new Date(2026, 0, 9, 11).toISOString(), "prior.evaluation", 180);
  const operationalSize = (await stat(priorOperational)).size;
  const reclaiming = new LocalObservability(options(directory, {
    maxTotalBytes: operationalSize + 16
  }), { now: () => now });
  await reclaiming.flush();
  await access(priorOperational);
  await assert.rejects(access(priorEvaluation));
  await reclaiming.close();

  const current = join(directory, "2026-01-10", "daemon.jsonl");
  await writeLog(current, now.toISOString(), "current.seed", 300);
  const degraded = new LocalObservability(options(directory, {
    logLevel: "debug",
    maxTotalBytes: 100
  }), { now: () => now });
  try {
    await degraded.flush();
    assert.equal(degraded.status.degradedReason, "current_day_over_cap");
    degraded.log({ level: "debug", scope: "test", event: "debug.suppressed", message: "must be dropped" });
    degraded.log({ level: "info", scope: "test", event: "info.retained", message: "must remain" });
    await degraded.flush();
    const records = await degraded.query();
    assert.equal(records.some(record => record.event === "debug.suppressed"), false);
    assert.equal(records.some(record => record.event === "info.retained"), true);
    assert.ok(degraded.status.droppedRecords >= 1);
  } finally {
    await degraded.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an operational write queued during startup rechecks current-day capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-startup-operational-capacity-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  await writeLog(join(directory, "2026-01-10", "daemon.jsonl"), now.toISOString(), "current.seed", 300);
  const logger = new LocalObservability(options(directory, {
    logLevel: "debug",
    maxTotalBytes: 100
  }), { now: () => now });
  try {
    logger.log({
      level: "debug",
      scope: "test",
      event: "startup.debug.suppressed",
      message: "must be dropped after queued maintenance"
    });
    await logger.flush();
    const records = await logger.query();
    assert.equal(records.some(record => record.event === "startup.debug.suppressed"), false);
    assert.equal(logger.status.degradedReason, "current_day_over_cap");
    assert.ok(logger.status.droppedRecords >= 1);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query keeps the newest timestamps across component files before applying its limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-query-order-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  await writeLog(join(directory, "2026-01-10", "adapter-host.jsonl"), "2026-01-10T12:00:03.000Z", "adapter.newest");
  const daemonPath = join(directory, "2026-01-10", "daemon.jsonl");
  await writeLog(daemonPath, "2026-01-10T12:00:01.000Z", "daemon.oldest");
  await appendFile(daemonPath, `${JSON.stringify({ ts: "2026-01-10T12:00:02.000Z", event: "daemon.second" })}\n`);
  const logger = new LocalObservability(options(directory), { now: () => now });
  try {
    const records = await logger.query({ limit: 2 });
    assert.deepEqual(records.map(record => record.event), ["daemon.second", "adapter.newest"]);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query streams shards and skips an oversized log line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-query-bounded-line-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const path = join(directory, "2026-01-10", "daemon.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
  await appendFile(path, `${JSON.stringify({ ts: now.toISOString(), event: "after.oversized" })}\n`);
  const logger = new LocalObservability(options(directory), { now: () => now });
  try {
    const records = await logger.query();
    assert.deepEqual(records.map(record => record.event), ["after.oversized"]);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query bounds the retained result set by encoded bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-query-result-bytes-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const path = join(directory, "2026-01-10", "daemon.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const oldest = JSON.stringify({ ts: "2026-01-10T12:00:01.000Z", event: "oldest", data: "x".repeat(900) });
  const newest = JSON.stringify({ ts: "2026-01-10T12:00:02.000Z", event: "newest", data: "x".repeat(900) });
  await writeFile(path, `${oldest}\n${newest}\n`);
  const logger = new LocalObservability(options(directory), { now: () => now });
  try {
    const records = await logger.query({ limit: 500, maxBytes: Buffer.byteLength(newest) + 10 });
    assert.deepEqual(records.map(record => record.event), ["newest"]);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("query propagates unreadable log files and marks observability degraded", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return t.skip("POSIX owner permission enforcement requires a non-root user");
  }
  const directory = await mkdtemp(join(tmpdir(), "oh-query-eacces-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const logger = new LocalObservability(options(directory), { now: () => now, stderr: () => undefined });
  const path = join(directory, "2026-01-10", "daemon.jsonl");
  try {
    await logger.flush();
    await writeLog(path, now.toISOString(), "unreadable");
    await chmod(path, 0o000);
    await assert.rejects(logger.query(), error => error.code === "EACCES");
    assert.equal(logger.status.degradedReason, "EACCES");
  } finally {
    await chmod(path, 0o600).catch(() => undefined);
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention deletion errors propagate and leave an explicit degraded status", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return t.skip("POSIX owner permission enforcement requires a non-root user");
  }
  const directory = await mkdtemp(join(tmpdir(), "oh-retention-eacces-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const oldDayPath = join(directory, "2026-01-01");
  const oldPath = join(oldDayPath, "daemon.jsonl");
  await writeLog(oldPath, "2026-01-01T12:00:00.000Z", "expired");
  await chmod(oldDayPath, 0o500);
  const logger = new LocalObservability(options(directory, { retentionDays: 3 }), {
    now: () => now,
    stderr: () => undefined
  });
  try {
    await logger.flush();
    assert.equal(logger.status.degradedReason, "EACCES");
    await assert.rejects(logger.cleanup(), error => error.code === "EACCES");
    await access(oldPath);
  } finally {
    await chmod(oldDayPath, 0o700).catch(() => undefined);
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("current-day capacity limits retained operational records to 100 per minute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-capacity-rate-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  await writeLog(join(directory, "2026-01-10", "daemon.jsonl"), now.toISOString(), "current.seed", 300);
  const logger = new LocalObservability(options(directory, { maxTotalBytes: 100 }), { now: () => now });
  try {
    await logger.flush();
    for (let index = 0; index < 120; index += 1) {
      logger.log({ level: "info", scope: "test", event: `info.rate.${index}`, message: "bounded" });
    }
    await logger.flush();
    const records = await logger.query();
    assert.equal(records.filter(record => String(record.event).startsWith("info.rate.")).length, 100);
    assert.ok(logger.status.droppedRecords >= 20);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("periodic maintenance detects capacity growth without another log append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-periodic-capacity-"));
  const now = new Date(2026, 0, 10, 12, 0, 0);
  const logger = new LocalObservability(options(directory, { maxTotalBytes: 100 }), {
    now: () => now,
    maintenanceIntervalMs: 10
  });
  try {
    await logger.flush();
    await writeLog(join(directory, "2026-01-10", "daemon.jsonl"), now.toISOString(), "external.growth", 300);
    await new Promise(resolve => setTimeout(resolve, 40));
    await logger.flush();
    assert.equal(logger.status.degradedReason, "current_day_over_cap");
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeLog(path, ts, event, padding = 0) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ ts, event, padding: "x".repeat(padding) })}\n`, { mode: 0o600 });
}

test("reasoning mapping persists requested and native levels without provider input capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oh-reasoning-"));
  const records = [];
  const logger = new LocalObservability(options(directory, { captureProviderIo: "off" }), { operationalSink: record => records.push(record) });
  try {
    for (const native of ["high", null]) await logger.observeProvider({ runKey: "reasoning-run", invocationId: "reasoning-invoke", agentSessionKey: "reasoning-session", adapterType: "fixture" }, {
      event: "provider.stage.completed", rpcMethod: "adapter.reasoning.map",
      data: { stage: "reasoning_mapping", outcome: native === null ? "not_applied" : "mapped", duration_ms: 0, requested_effort: "xhigh", native_effort: native }
    });
    await logger.flush();
    assert.deepEqual(records.map(record => [record.data.requested_effort, record.data.native_effort, record.data.outcome]), [["xhigh", "high", "mapped"], ["xhigh", null, "not_applied"]]);
    const stored = await logger.query({ runKey: "reasoning-run" });
    assert.deepEqual(stored.map(record => record.data.native_effort), ["high", null]);
  } finally { await logger.close(); await rm(directory, { recursive: true, force: true }); }
});
