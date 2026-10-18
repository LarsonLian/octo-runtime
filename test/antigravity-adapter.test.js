import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCanonicalEvent,
  invocationInput,
  resolveStreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  AntigravityEventNormalizer,
  antigravityLogError,
  buildAntigravityCommand,
  createAntigravityAdapter
} from "@mininglamp-oss/octo-runtime-adapter-antigravity";

const request = {
  protocolVersion: 2,
  invocationId: "inv-agy",
  agentSessionId: "session-agy",
  runId: "run-agy",
  prompt: "display",
  modelInput: "actual user input",
  workdir: process.cwd(),
  context: { schema: "octo.context-envelope/v3", items: [] },
  controlInstructions: "CONTROL",
  approvalMode: "full_access",
  agentSource: "provisioned",
  agentConfig: {}
};
const fixture = fileURLToPath(new URL("./fixtures/antigravity-cli.mjs", import.meta.url));
const create = () =>
  createAntigravityAdapter({ command: process.execPath, commandArgsPrefix: [fixture] });
const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) {
    assertCanonicalEvent(event);
    events.push(event);
  }
  return events;
};
const step = (index, overrides = {}) => ({
  event: "step_update",
  step_update: { step_index: index, step_type: "agent_response", state: "ACTIVE", ...overrides }
});

test("Antigravity preserves non-retryable provider capacity evidence through the Host", async (context) => {
  const host = new AdapterHost();
  host.register(create());
  context.after(() => host.shutdown());
  const frames = [];
  for await (const frame of host.invokeFrames(
    invocationInput(request, "canonical", "antigravity"),
    {
      streamLimits: resolveStreamLimitPolicy({ rawMessageMaxBytes: 64 })
    }
  ))
    frames.push(frame);
  const failure = frames.find(
    (frame) => frame.kind === "canonical" && frame.event.type === "run.failed"
  )?.event.payload.failure;
  assert.equal(failure.code, "OH-PRV-4009");
  assert.equal(failure.reasonCode, "PROVIDER_MESSAGE_TOO_LARGE");
  assert.equal(failure.retryable, false);
  assert.ok(failure.diagnosticId);
  assert.equal(failure.params.boundary, "provider.stdout");
  assert.equal(failure.params.limitBytes, 64);
  assert.ok(failure.params.measuredBytes > 64);
  assert.equal(frames.at(-1).control.state, "failed");
});

test("Antigravity builds an isolated stdin carrier, exact model and explicit yolo mode", () => {
  const spec = buildAntigravityCommand({
    ...request,
    agentConfig: { model: "Gemini Model (High)", effort: "high" }
  });
  assert.equal(spec.cwd, request.workdir);
  assert.ok(spec.args.includes("--dangerously-skip-permissions"));
  assert.equal(spec.args[spec.args.indexOf("--mode") + 1], "accept-edits");
  assert.ok(!spec.args.includes("--conversation"));
  assert.equal(spec.args[spec.args.indexOf("--model") + 1], "Gemini Model (High)");
  assert.equal(spec.args[spec.args.indexOf("--print-timeout") + 1], "0");
  assert.ok(!spec.args.join(" ").includes("CONTROL"));
  assert.ok(!spec.args.includes("--continue"));
  assert.deepEqual(JSON.parse(spec.input), {
    event: "user",
    message: {
      content: [
        {
          type: "text",
          text: "Runtime control instructions (apply throughout this session):\nCONTROL"
        },
        { type: "text", text: "User input:\nactual user input" }
      ]
    }
  });
  const resumed = buildAntigravityCommand({
    ...request,
    providerSession: { sessionId: "conversation-specific" }
  });
  assert.equal(resumed.args[resumed.args.indexOf("--conversation") + 1], "conversation-specific");
  assert.equal(resumed.args[resumed.args.indexOf("--conversation") + 1], "conversation-specific");
  assert.deepEqual(JSON.parse(resumed.input), {
    event: "user",
    message: { content: "actual user input" }
  });
});

test("Antigravity rejects unsupported permissions and managed arguments before spawn", async () => {
  for (const mode of ["ask", "assisted"])
    assert.throws(
      () => buildAntigravityCommand({ ...request, approvalMode: mode }),
      /APPROVAL_MODE_UNSUPPORTED/
    );
  for (const flag of [
    "--mode=plan",
    "--conversation",
    "--output-format=text",
    "--dangerously-skip-permissions",
    "-psecret"
  ])
    assert.throws(() => buildAntigravityCommand(request, "agy", [flag]), /MANAGED_ARGUMENT/);
  const host = new AdapterHost();
  host.register(create());
  await assert.rejects(
    collect(
      preparedTestInvoke((...args) => preparedFrames(host, ...args))(
        "antigravity",
        { ...request, approvalMode: "ask" },
        { protocolMode: "canonical" }
      )
    ),
    /APPROVAL_MODE_UNSUPPORTED/
  );
});

test("Antigravity probe reports a missing executable without invoking a user CLI", async () => {
  const probe = await createAntigravityAdapter({ command: "/missing-octo-fixture-agy" }).probe();
  assert.equal(probe.available, false);
  assert.equal(probe.reason, "command_not_found");
});

test("Antigravity preserves segmented text, snapshot corrections and only one root terminal", () => {
  const n = new AntigravityEventNormalizer("inv");
  const events = [
    ...n.normalize({ event: "init", conversation_id: "session" }),
    ...n.normalize(step(1, { text_delta: "before tools", state: "DONE" })),
    ...n.normalize(step(2, { text_delta: "partial", state: "DONE" })),
    ...n.normalize({ event: "result", result: { status: "SUCCESS", response: "correct final" } }),
    ...n.finish(),
    ...n.finish()
  ];
  events.forEach(assertCanonicalEvent);
  assert.equal(events.filter((e) => e.type === "message.create").length, 2);
  assert.equal(events.filter((e) => e.type === "run.completed").length, 1);
  assert.equal(
    events.filter((e) => e.type === "message.update").at(-1).payload.text,
    "correct final"
  );
  assert.equal(
    events.filter((e) => e.type === "message.update").at(-1).payload.status,
    "completed"
  );
  assert.deepEqual(n.normalize(step(3, { text_delta: "late" })), []);
});

test("Antigravity tool snapshots keep activity until DONE and deduplicate terminal-only tools", () => {
  const n = new AntigravityEventNormalizer("inv");
  const native = step(4, {
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { parameters: { CommandLine: "echo test" }, output: "partial" }
  });
  const start = n.normalize(native);
  assert.equal(start[0].type, "tool_call.create");
  assert.deepEqual(start[0].payload.args, { command: "echo test" });
  assert.equal(start[1].type, "tool_call.delta");
  assert.equal(
    n.normalize(native).some((e) => e.type === "tool_call.update"),
    false
  );
  const done = {
    ...native,
    step_update: {
      ...native.step_update,
      state: "DONE",
      tool_info: { output: "failure", error: { type: "exit", message: "exit 1" } }
    }
  };
  assert.equal(n.normalize(done)[0].payload.status, "failed");
  assert.deepEqual(n.normalize(done), []);
  const terminalOnly = n.normalize(
    step(7, {
      step_type: "tool",
      state: "DONE",
      tool_name: "read",
      tool_info: { output: "result" }
    })
  );
  assert.deepEqual(
    terminalOnly.map((e) => e.type),
    ["tool_call.create", "tool_call.update"]
  );
  assert.equal(terminalOnly[0].payload.id, terminalOnly[1].payload.id);
});

test("Antigravity sums invocation step usage without cumulative resumed usage or thinking double count", () => {
  const n = new AntigravityEventNormalizer("resume", true);
  const native = step(1, {
    state: "DONE",
    text_delta: "answer",
    usage: { input_tokens: 5, output_tokens: 4, thinking_tokens: 3, cache_read_tokens: 20 }
  });
  n.normalize(native);
  n.normalize(native);
  n.normalize({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "answer",
      usage: { input_tokens: 100, output_tokens: 100 }
    }
  });
  const events = n.finish();
  assert.deepEqual(events.find((e) => e.type === "usage.update").payload, {
    inputTokens: 5,
    outputTokens: 4,
    cacheReadTokens: 20,
    cacheWriteTokens: 0
  });
  const unknown = new AntigravityEventNormalizer("resume-no-steps", true);
  unknown.normalize({
    event: "result",
    result: { status: "SUCCESS", response: "answer", usage: { input_tokens: 100 } }
  });
  assert.equal(
    unknown.finish().some((e) => e.type === "usage.update"),
    false
  );
});

test("Antigravity suppresses private and unidentified reasoning", () => {
  const n = new AntigravityEventNormalizer("inv");
  assert.deepEqual(
    n.normalize(step(1, { step_type: "thinking", text_delta: "PRIVATE_CANARY" })),
    []
  );
});

test("Antigravity distinguishes canceled, incomplete and empty successful results", () => {
  for (const status of ["ERROR", "INVALID", "WAITING", "RUNNING", "SUCCESS"]) {
    const n = new AntigravityEventNormalizer(status);
    n.normalize({ event: "result", result: { status, response: "" } });
    assert.equal(n.finish().at(-1).type, "run.failed");
  }
  for (const status of ["CANCELED", "INTERRUPTED"]) {
    const n = new AntigravityEventNormalizer(status);
    n.normalize({ event: "result", result: { status } });
    assert.equal(n.finish().at(-1).type, "run.cancelled");
  }
});

test("Antigravity rejects malformed results before accepting a terminal snapshot", () => {
  const n = new AntigravityEventNormalizer("malformed");
  assert.throws(
    () =>
      n.normalize({
        event: "result",
        result: { status: "SUCCESS", response: { text: "invalid" } }
      }),
    /RESULT_INVALID/
  );
  assert.equal(n.hasResult, false);
  assert.equal(n.finish().at(-1).type, "run.failed");
});

test("Antigravity ignores transient startup login diagnostics but surfaces explicit loop errors", () => {
  assert.equal(
    antigravityLogError("Cache refresh failed: You are not logged into Antigravity."),
    undefined
  );
  assert.match(
    antigravityLogError("exiting agent loop due to error: authentication required"),
    /AUTH_REQUIRED/
  );
});

test("Antigravity subprocess runs and resumes without changing AGENTS.md", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-agy-test-"));
  try {
    await writeFile(join(directory, "AGENTS.md"), "USER RULES");
    const events = await collect(
      create().invoke({
        ...request,
        workdir: directory,
        providerSession: { sessionId: "resume-specific" }
      })
    );
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(
      events.find((e) => e.type === "session.update").payload.providerSession.sessionId,
      "resume-specific"
    );
    assert.equal(events.find((e) => e.type === "usage.update").payload.inputTokens, 12);
    assert.equal(await readFile(join(directory, "AGENTS.md"), "utf8"), "USER RULES");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const model of ["empty", "bad-json", "exit-error", "provider-error", "log-error"]) {
  test(`Antigravity cannot report success for ${model}`, async () => {
    const events = await collect(create().invoke({ ...request, agentConfig: { model } }));
    assert.equal(events.at(-1).type, "run.failed");
    assert.equal(events.filter((e) => e.type.startsWith("run.")).length, 1);
  });
}

test(
  "Antigravity cancels and reclaims a TERM-resistant provider process tree",
  { skip: process.platform === "win32" },
  async () => {
    const controller = new AbortController();
    const pids = [];
    const events = [];
    for await (const event of create().invoke({
      ...request,
      agentConfig: { model: "hang" },
      signal: controller.signal
    })) {
      events.push(event);
      if (event.type === "tool_call.create") {
        pids.push(event.payload.args.parentPid, event.payload.args.childPid);
        controller.abort();
      }
    }
    assert.equal(events.at(-1).type, "run.cancelled");
    for (const pid of pids)
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH"
      );
  }
);
