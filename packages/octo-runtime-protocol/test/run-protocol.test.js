import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  RUN_PROTOCOL_ERRORS,
  CANONICAL_EVENT_TYPES,
  assertAdapterProtocolSupport,
  assertHostControl,
  assertHostFrame,
  assertHostFrameIdentity,
  assertHostRunReceipt,
  assertNativeInteractionResponse,
  assertProtocolSupport,
  canonicalEvents,
  isHostTerminal,
  resolveHostInvokeOptions
} from "../dist/index.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../schema/run-protocol-fixtures.json", import.meta.url), "utf8")
);
const schema = JSON.parse(
  readFileSync(new URL("../schema/protocol.schema.json", import.meta.url), "utf8")
);
const Ajv = createRequire(new URL("../../octo-runtime-daemon/package.json", import.meta.url))(
  "ajv"
);
const ajv = new Ajv({ strict: false, logger: false });
ajv.addSchema(schema);
const validators = {
  HostInvokeOptions: resolveHostInvokeOptions,
  HostRunReceipt: assertHostRunReceipt,
  AdapterProtocolSupport: assertAdapterProtocolSupport,
  NativeInteractionResponse: assertNativeInteractionResponse,
  HostControl: assertHostControl,
  HostFrame: assertHostFrame
};

for (const [name, validateRuntime] of Object.entries(validators)) {
  test(`${name}: shared fixtures agree between schema and runtime`, () => {
    const validateSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/${name}` });
    for (const value of fixtures.valid[name]) {
      const before = structuredClone(value);
      assert.equal(validateSchema(value), true, JSON.stringify(validateSchema.errors));
      assert.doesNotThrow(() => validateRuntime(value));
      assert.deepEqual(value, before);
    }
    for (const value of fixtures.invalid[name]) {
      assert.equal(validateSchema(value), false, JSON.stringify(value));
      assert.throws(() => validateRuntime(value), JSON.stringify(value));
    }
  });
}

test("only omission defaults to native; resolved options freeze an explicit selector", () => {
  assert.deepEqual(resolveHostInvokeOptions(), { protocolMode: "native" });
  for (const mode of [undefined, null, "", "auto", false]) {
    assert.throws(
      () => resolveHostInvokeOptions({ protocolMode: mode }),
      (error) => error.code === "PROTOCOL_MODE_INVALID"
    );
  }
  const input = { protocolMode: "canonical", protocol: "codex.app-server" };
  const resolved = resolveHostInvokeOptions(input);
  input.protocolMode = "native";
  assert.equal(resolved.protocolMode, "canonical");
  assert.equal(Object.isFrozen(resolved), true);
});

test("mode support never infers native from a canonical implementation", () => {
  const support = fixtures.valid.AdapterProtocolSupport[1];
  assert.throws(
    () => assertProtocolSupport(support, {}),
    (error) => error.code === "PROTOCOL_MODE_UNSUPPORTED"
  );
  assert.doesNotThrow(() => assertProtocolSupport(support, { protocolMode: "canonical" }));
  assert.throws(
    () =>
      assertProtocolSupport(support, { protocolMode: "canonical", protocol: "codex.app-server" }),
    (error) => error.code === "EXECUTION_PROTOCOL_MISMATCH"
  );
});

test("native objects keep provider IDs, errors and optional extension fields", () => {
  for (const frame of fixtures.valid.HostFrame.filter((value) => value.kind === "native")) {
    const payload = frame.payload;
    assertHostFrame(frame);
    assert.strictEqual(frame.payload, payload);
    assert.deepEqual(JSON.parse(JSON.stringify(frame)).payload, payload);
  }
});

test("frame identity freezes mode, provider protocol, stream and session generation", () => {
  const frame = fixtures.valid.HostFrame[0],
    receipt = fixtures.valid.HostRunReceipt[0];
  assert.doesNotThrow(() => assertHostFrameIdentity(frame, receipt));
  for (const key of [
    "run_id",
    "invocation_id",
    "stream_id",
    "agent_session_id",
    "protocol",
    "session_generation",
    "protocol_mode"
  ]) {
    const next = {
      ...receipt,
      [key]:
        key === "session_generation"
          ? receipt[key] + 1
          : key === "protocol_mode"
            ? "canonical"
            : receipt[key] + "-other"
    };
    assert.throws(
      () => assertHostFrameIdentity(frame, next),
      (error) => error.code === "EXECUTION_IDENTITY_CONFLICT"
    );
  }
});

test("only Host terminal facts end a native stream; provider payload does not decide Host state", () => {
  const frame = fixtures.valid.HostFrame[0];
  assert.equal(
    isHostTerminal({ ...frame, payload: { type: "result", status: "completed" } }),
    false
  );
  for (const state of ["running", "completed", "failed", "cancelled", "lost"]) {
    const control = {
      ...fixtures.valid.HostRunReceipt[0],
      seq: 1,
      kind: "control",
      control: { type: "state", state }
    };
    assertHostFrame(control);
    assert.equal(isHostTerminal(control), state !== "running");
  }
});

async function* stream(...frames) {
  yield* frames;
}
async function collect(source) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

test("canonical view validates events and refuses native, cross-stream data or sequence gaps", async () => {
  const eventFrame = fixtures.valid.HostFrame.find((frame) => frame.kind === "canonical");
  const done = {
    ...eventFrame,
    seq: 2,
    event: { protocolVersion: 2, type: "run.completed", payload: {} }
  };
  assert.deepEqual(await collect(canonicalEvents(stream(eventFrame, done))), [
    eventFrame.event,
    done.event
  ]);
  await assert.rejects(
    collect(canonicalEvents(stream(fixtures.valid.HostFrame[0]))),
    (error) => error.code === "EXECUTION_PROTOCOL_MISMATCH"
  );
  await assert.rejects(
    collect(canonicalEvents(stream(eventFrame, { ...done, stream_id: "other" }))),
    (error) => error.code === "EXECUTION_IDENTITY_CONFLICT"
  );
  for (const seq of [1, 3])
    await assert.rejects(
      collect(canonicalEvents(stream(eventFrame, { ...done, seq }))),
      (error) => error.code === "STREAM_GAP"
    );
  await assert.rejects(
    collect(
      canonicalEvents(
        stream({
          ...eventFrame,
          event: { protocolVersion: 2, type: "message.delta", payload: { text: 1 } }
        })
      )
    ),
    /text/
  );
});

test("Host errors and explicit gaps are surfaced by the canonical view", async () => {
  const identity = {
    ...fixtures.valid.HostRunReceipt[0],
    protocol_mode: "canonical",
    seq: 1,
    kind: "control"
  };
  await assert.rejects(
    collect(
      canonicalEvents(
        stream({
          ...identity,
          control: { type: "error", code: "HOST_EXECUTION_FAILED", message: "Failed" }
        })
      )
    ),
    (error) => error.code === "HOST_EXECUTION_FAILED"
  );
  await assert.rejects(
    collect(
      canonicalEvents(
        stream({
          ...identity,
          control: { type: "gap", requested_after_seq: 0, oldest_seq: 5, latest_seq: 10 }
        })
      )
    ),
    (error) => error.code === "STREAM_GAP"
  );
  for (const control of [
    { type: "gap", requested_after_seq: 5, oldest_seq: 5, latest_seq: 10 },
    { type: "gap", requested_after_seq: 0, oldest_seq: 12, latest_seq: 10 }
  ])
    assert.throws(
      () => assertHostControl(control),
      (error) => error.code === "HOST_CONTROL_INVALID"
    );
});

test("new contracts preserve JSON validity and the existing independent protocol versions", () => {
  const frame = fixtures.valid.HostFrame[0];
  for (const payload of [{ extension: undefined }, { value: Infinity }, { text: "\ud800" }])
    assert.throws(
      () => assertHostFrame({ ...frame, payload }),
      (error) => error.code === "HOST_FRAME_INVALID"
    );
  assert.deepEqual(schema.definitions.RunProtocolErrorCode.enum, RUN_PROTOCOL_ERRORS);
  assert.deepEqual(
    schema.definitions.CanonicalEventWire.properties.type.enum,
    CANONICAL_EVENT_TYPES
  );
  assert.equal(schema.definitions.InvokeRequestWire.properties.protocolVersion.const, 2);
  assert.equal(
    schema.definitions.ContextEnvelope.properties.schema.const,
    "octo.context-envelope/v3"
  );
});
