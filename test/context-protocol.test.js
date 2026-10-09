import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { APPROVAL_MODES, CONTEXT_MAX_BYTES, CONTEXT_MAX_ITEMS, assertApprovalRequest, assertContextEnvelope, assertMcpServers, canonicalContext, contextHash, mergeContext, assertInvokeRequest, assertResolvedExecutionPlan } from "../packages/octo-harness-protocol/dist/index.js";

const fixtures = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/context-fixtures.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/protocol.schema.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.resolve("eslint"));
const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, logger: false });
ajv.addKeyword("x-octo-unique-type-keys", {
  type: "object",
  validate: (enabled, value) => {
    if (!enabled || !Array.isArray(value.items)) return true;
    const keys = value.items.map(item => JSON.stringify([item?.namespace, item?.name]));
    return new Set(keys).size === keys.length;
  }
});
ajv.addKeyword("x-octo-max-json-bytes", {
  type: "object",
  validate: (maximum, value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum
});
ajv.addKeyword("x-octo-max-json-depth", {
  type: "object",
  validate: (maximum, value) => withinDepth(value, maximum)
});
ajv.addKeyword("x-octo-max-utf16-length", {
  type: "string",
  validate: (maximum, value) => value.length <= maximum
});
ajv.addKeyword("x-octo-unicode-scalar-strings", {
  validate: (enabled, value) => !enabled || scalarStrings(value)
});
ajv.addKeyword("x-octo-http-url", {
  type: "string",
  validate: (enabled, value) => {
    if (!enabled) return true;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
});
ajv.addKeyword("x-octo-matching-trigger-fields", {
  type: "object",
  validate: (enabled, value) => !enabled || (value.trigger_fact?.message_id === value.trigger_message_id
    && value.trigger_fact?.message_seq === value.trigger_seq
    && Object.hasOwn(value.trigger_fact ?? {}, "message_seq") === Object.hasOwn(value, "trigger_seq"))
});
ajv.addKeyword("x-octo-capability-selection", {
  type: "object",
  validate: (enabled, value) => {
    if (!enabled || !Array.isArray(value.include) || !Array.isArray(value.exclude)) return true;
    const ids = value.include.map(item => item?.resource_id);
    return new Set(ids).size === ids.length && ids.every(id => !value.exclude.includes(id));
  }
});
ajv.addSchema(schema);
const validateContextSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/ContextEnvelope` });
const validatePlanSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/ResolvedExecutionPlan` });

function withinDepth(value, maximum, depth = 0) {
  if (depth > maximum) return false;
  if (value !== null && typeof value === "object") return Object.values(value).every(item => withinDepth(item, maximum, depth + 1));
  return true;
}

function scalarStrings(value) {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(scalarStrings);
  if (value !== null && typeof value === "object") return Object.entries(value).every(([key, item]) => key.isWellFormed() && scalarStrings(item));
  return true;
}

function validateDefinition(name, value) {
  return ajv.validate({ $ref: `${schema.$id}#/definitions/${name}` }, value);
}

for (const fixture of fixtures) {
  if (Object.hasOwn(fixture, "resolved_execution_plan")) {
    test(`shared resolved plan fixture: ${fixture.name}`, () => {
      const plan = fixture.resolved_execution_plan;
      assert.equal(validatePlanSchema(plan), fixture.valid, JSON.stringify(validatePlanSchema.errors));
      if (fixture.valid) {
        assert.doesNotThrow(() => assertResolvedExecutionPlan(plan));
        if (plan.mcp_servers !== undefined) assert.doesNotThrow(() => assertMcpServers(plan.mcp_servers));
      } else {
        assert.throws(() => assertResolvedExecutionPlan(plan), error => error instanceof TypeError && error.message === fixture.error);
        if (fixture.name.startsWith("plan-mcp-")) assert.throws(() => assertMcpServers(plan.mcp_servers), error => error instanceof TypeError && error.message === fixture.error);
      }
    });
    continue;
  }
  test(`shared Context fixture: ${fixture.name}`, () => {
    assert.equal(validateContextSchema(fixture.context), fixture.valid, JSON.stringify(validateContextSchema.errors));
    if (fixture.valid) assert.doesNotThrow(() => assertContextEnvelope(fixture.context));
    else assert.throws(() => assertContextEnvelope(fixture.context), error => error instanceof TypeError && error.message === fixture.error);
    if (fixture.expected_canonical !== undefined) assert.equal(canonicalContext(fixture.context), fixture.expected_canonical);
    if (fixture.expected_hash !== undefined) assert.equal(contextHash(fixture.context), fixture.expected_hash);
  });
}

test("Context schema constants and registered handlers stay aligned", () => {
  assert.equal(schema.definitions.ContextEnvelope.properties.items.maxItems, CONTEXT_MAX_ITEMS);
  assert.equal(schema.definitions.ContextEnvelope["x-octo-max-json-bytes"], CONTEXT_MAX_BYTES);
  assert.equal(schema.definitions.ContextEnvelope["x-octo-max-json-depth"], 32);
  assert.equal(schema["x-octo-unicode-scalar-strings"], true);
  assert.equal(schema.definitions.ContextEnvelope["x-octo-unicode-scalar-strings"], true);
  assert.deepEqual(schema.definitions.ApprovalMode.enum, APPROVAL_MODES);
  const registered = schema.definitions.ContextItem.oneOf.flatMap(branch =>
    (branch.properties.namespace.enum ?? [branch.properties.namespace.const]).map(namespace => JSON.stringify([namespace, branch.properties.name.const])));
  const covered = new Set(fixtures.filter(fixture => fixture.valid && fixture.context).flatMap(fixture => fixture.context.items.map(item => JSON.stringify([item.namespace, item.name]))));
  assert.deepEqual([...covered].sort(), registered.sort());
});

test("Shared Unicode and number fixtures preserve ECMAScript canonical bytes", () => {
  const zero = fixtures.find(fixture => fixture.name === "canonical-negative-zero");
  assert.equal(Object.is(zero.context.items[0].payload.entries[0].source.negative_zero, -0), true);
  assert.equal(zero.expected_canonical.includes('"negative_zero":0'), true);
  assert.equal(zero.expected_canonical.includes(":-0"), false);
  const exponents = fixtures.find(fixture => fixture.name === "canonical-exponent-numbers");
  for (const number of [":1000", ":1e-7", ":0.000001", ":100000000000000000000", ":1e+21", ":333333333.3333333", ":9007199254740992"]) assert.equal(exponents.expected_canonical.includes(number), true, number);
  const separators = fixtures.find(fixture => fixture.name === "unicode-line-separators");
  assert.equal(separators.expected_canonical.includes("\u2028"), true);
  assert.equal(separators.expected_canonical.includes("\u2029"), true);
  assert.equal(separators.expected_canonical.includes("\\u2028"), false);
  const astral = fixtures.find(fixture => fixture.name === "unicode-astral-object-keys");
  assert.equal(astral.expected_canonical.indexOf('"𐀀"') < astral.expected_canonical.indexOf('"😀"'), true);
  assert.equal(astral.expected_canonical.indexOf('"😀"') < astral.expected_canonical.indexOf('"\uE000"'), true);
  assert.equal(astral.expected_canonical.indexOf('"2"') < astral.expected_canonical.indexOf('"10"'), true);
});

test("Resolved plans reject malformed Unicode strings and nested property names", () => {
  const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "/tmp", approval_mode: "ask", provider_compatibility: { label: "😀\u2028\u2029" } };
  assert.equal(validateDefinition("ResolvedExecutionPlan", plan), true);
  assert.doesNotThrow(() => assertResolvedExecutionPlan(plan));
  for (const compatibility of [{ label: "\uD800" }, { ["\uDC00"]: "value" }, { nested: [{ label: "\uDFFF" }] }]) {
    const invalid = { ...plan, provider_compatibility: compatibility };
    assert.equal(validateDefinition("ResolvedExecutionPlan", invalid), false);
    assert.throws(() => assertResolvedExecutionPlan(invalid), /CONTEXT_SCHEMA_INVALID/);
  }
});

test("Context and host watchdog limit schemas share bounds and enums", () => {
  const limits = schema.definitions.ContextLimitsPayload.properties;
  const host = schema.definitions.RuntimeLimits.properties;
  for (const [key, value] of Object.entries(limits)) {
    const hostKey = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (key.endsWith("_ms")) assert.deepEqual(value, host[hostKey]);
    else assert.deepEqual([...value.enum].sort(), [...host[hostKey].enum].sort());
  }
});

test("Resolved plan limits use the same Context payload acceptance set", () => {
  for (const fixture of fixtures.filter(fixture => fixture.context?.items?.some(item => item.namespace === "octo.execution" && item.name === "limits"))) {
    const runtime_limits = fixture.context.items.find(item => item.name === "limits").payload;
    const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "/tmp", approval_mode: "ask", runtime_limits };
    assert.equal(validateDefinition("ResolvedExecutionPlan", plan), fixture.valid, fixture.name);
    if (fixture.valid) assert.doesNotThrow(() => assertResolvedExecutionPlan(plan));
    else assert.throws(() => assertResolvedExecutionPlan(plan), /CONTEXT_SCHEMA_INVALID/);
  }
});

test("Context budgets reject excessive UTF-8 bytes, item counts and nesting in both validators", () => {
  const base = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.content", name: "selections", payload: { entries: [{ text: "" }] } }] };
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  base.items[0].payload.entries[0].text = "x".repeat(CONTEXT_MAX_BYTES - overhead);
  assert.equal(validateContextSchema(base), true);
  assert.doesNotThrow(() => assertContextEnvelope(base));
  const oversized = structuredClone(base);
  oversized.items[0].payload.entries[0].text += "界";
  assert.equal(validateContextSchema(oversized), false);
  assert.throws(() => assertContextEnvelope(oversized), /CONTEXT_BUDGET_EXCEEDED/);
  const many = { ...base, items: Array.from({ length: CONTEXT_MAX_ITEMS + 1 }, () => base.items[0]) };
  assert.equal(validateContextSchema(many), false);
  assert.throws(() => assertContextEnvelope(many), /CONTEXT_BUDGET_EXCEEDED/);
  const nested = structuredClone(base);
  nested.items[0].payload.entries[0] = { text: "Text", source: {} };
  let current = nested.items[0].payload.entries[0].source;
  for (let depth = 6; depth < 32; depth++) { current.child = {}; current = current.child; }
  assert.equal(validateContextSchema(nested), true);
  assert.doesNotThrow(() => assertContextEnvelope(nested));
  current.child = "too deep";
  assert.equal(validateContextSchema(nested), false);
  assert.throws(() => assertContextEnvelope(nested), /CONTEXT_SCHEMA_INVALID/);
});

test("AgentConfig only retains adapter-internal model options and rejects removed legacy fields", () => {
  const config = { model: "resolved-model", effort: "high", workdir: "/tmp", providerOptions: { localOption: true } };
  assert.equal(validateDefinition("AgentConfig", config), true);
  for (const key of ["permissionMode", "autoApprove", "dangerouslyBypassPermissions", "thinking"]) {
    assert.equal(Object.hasOwn(schema.definitions.AgentConfig.properties, key), false);
    assert.equal(validateDefinition("AgentConfig", { ...config, [key]: true }), false, key);
  }
});

test("Approval requests share the supported zero-permission profile and display allowlist", () => {
  const request = {
    schema: "octo.approval-request/v1", policy: { mode: "ask", hash: `sha256:${"a".repeat(64)}` },
    operation: { kind: "command_execution", summary: "Run tests", toolCallId: "tool-1", details: { command: "pnpm test" } },
    requestedPermissions: [],
    allowedOutcomes: ["accepted", "declined", "cancelled"], grantScope: "request", providerDetails: { provider: "codex" }
  };
  assert.equal(validateDefinition("ApprovalRequest", request), true);
  assert.doesNotThrow(() => assertApprovalRequest(request));
  for (const mutate of [
    value => { value.operation.kind = "arbitrary"; }, value => { value.operation.summary = ""; },
    value => { value.requestedPermissions = ["all"]; }, value => { value.requestedPermissions = [{ kind: "network", target: "service", access: "connect" }]; },
    value => { value.policy.hash = "invalid"; }, value => { value.allowedOutcomes = ["answered"]; },
    value => { value.allowedOutcomes = ["accepted", "accepted"]; }, value => { value.allowedOutcomes = []; },
    value => { value.grantScope = "session"; }, value => { value.autoApprove = true; },
    value => { value.providerDetails = { token: "fixture-not-a-secret" }; }, value => { value.operation.details = { env: {} }; },
    value => { value.operation.summary = "x".repeat(8193); }, value => { value.operation.summary = "😀".repeat(4097); }
  ]) {
    const invalid = structuredClone(request); mutate(invalid);
    assert.equal(validateDefinition("ApprovalRequest", invalid), false);
    assert.throws(() => assertApprovalRequest(invalid));
  }
  const nonEmptyPermissions = { ...request, requestedPermissions: [{}] };
  assert.throws(() => assertApprovalRequest(nonEmptyPermissions), /APPROVAL_PERMISSION_UNSUPPORTED/);
  const oversized = { ...request, providerDetails: { description: "x".repeat(65536) } };
  assert.equal(validateDefinition("ApprovalRequest", oversized), false);
  assert.throws(() => assertApprovalRequest(oversized), /INVALID_APPROVAL_REQUEST/);
  for (const kind of ["approval", "question", "elicitation"]) {
    const payload = { interactionId: "interaction-1", executionInstanceId: "invoke-1", expiresAt: "2026-10-06T12:10:00+08:00", kind, request: kind === "approval" ? request : { prompt: "Question" } };
    assert.equal(validateDefinition("InteractionRequestedPayload", payload), true, kind);
    for (const field of ["executionInstanceId", "expiresAt"]) {
      const missing = { ...payload }; delete missing[field];
      assert.equal(validateDefinition("InteractionRequestedPayload", missing), false, `${kind}/${field}`);
    }
    assert.equal(validateDefinition("InteractionRequestedPayload", { ...payload, expiresAt: "not-a-date" }), false);
    for (const character of ["x", "😀"]) {
      assert.equal(validateDefinition("InteractionRequestedPayload", { ...payload, executionInstanceId: character.repeat(191) }), true);
      assert.equal(validateDefinition("InteractionRequestedPayload", { ...payload, executionInstanceId: character.repeat(192) }), false);
    }
    if (kind === "approval") assert.equal(validateDefinition("InteractionRequestedPayload", { ...payload, request: {} }), false);
  }
});

test("Resolved interactions distinguish successful outcomes from expiry and invalidation", () => {
  const identity = { interactionId: "interaction-1", executionInstanceId: "invoke-1" };
  for (const character of ["x", "😀"]) {
    assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, executionInstanceId: character.repeat(191), status: "resolved", outcome: "accepted" }), true);
    assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, executionInstanceId: character.repeat(192), status: "resolved", outcome: "accepted" }), false);
  }
  for (const outcome of ["accepted", "declined", "cancelled", "answered"]) assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, status: "resolved", outcome }), true);
  for (const status of ["expired", "invalidated"]) {
    assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, status, reasonCode: "execution_lost" }), true);
    assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, status, outcome: "accepted" }), false);
  }
  assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, status: "resolved" }), false);
  assert.equal(validateDefinition("InteractionResolvedPayload", { ...identity, status: "failed", reasonCode: "failed" }), false);
  assert.equal(validateDefinition("InteractionResolvedPayload", { interactionId: "interaction-1", status: "resolved", outcome: "accepted" }), false);
});

test("Context item ordering and object property ordering do not change canonical hash", () => {
  const original = fixtures.find(fixture => fixture.name === "execution-selection").context;
  const reordered = { items: [...original.items].reverse().map(item => ({ payload: item.payload, name: item.name, namespace: item.namespace })), schema: original.schema };
  assert.equal(canonicalContext(original), canonicalContext(reordered));
  assert.equal(contextHash(original), contextHash(reordered));
});

test("Context payload arrays preserve order and affect the hash", () => {
  const original = fixtures.find(fixture => fixture.name === "multivalue-content").context;
  const reordered = structuredClone(original);
  reordered.items[0].payload.entries.reverse();
  assert.notEqual(contextHash(original), contextHash(reordered));
});

test("Context merge replaces the complete payload and does not mutate defaults", () => {
  const defaults = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.execution", name: "model", payload: { id: "a" } }] };
  const overrides = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.execution", name: "model", payload: { use_provider_default: true } }] };
  const merged = mergeContext(defaults, overrides);
  assert.deepEqual(merged.items[0].payload, { use_provider_default: true });
  assert.deepEqual(defaults.items[0].payload, { id: "a" });
});

test("Context rejects oversized payloads and non-JSON values", () => {
  const context = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.content", name: "selections", payload: { entries: [{ text: "x".repeat(65_536) }] } }] };
  assert.throws(() => assertContextEnvelope(context), /CONTEXT_BUDGET_EXCEEDED/);
  context.items[0].payload.entries = [{ value: NaN }];
  assert.throws(() => assertContextEnvelope(context), /CONTEXT_SCHEMA_INVALID/);
});

test("InvokeRequest rejects legacy execution contracts before provider dispatch", () => {
  const request = { protocolVersion: 2, invocationId: "invoke-1", agentSessionId: "session-1", runId: "run-1", prompt: "hello", workdir: "/tmp", modelInput: "hello", controlInstructions: "", context: { schema: "octo.context-envelope/v1", items: [] }, approvalMode: "ask", agentSource: "provisioned", agentConfig: {} };
  assert.doesNotThrow(() => assertInvokeRequest(request));
  assert.throws(() => assertInvokeRequest({ ...request, appendInstructions: "legacy" }), /LEGACY_RUN_CONTRACT_REJECTED/);
  assert.throws(() => assertInvokeRequest({ ...request, context: {} }), /CONTEXT_SCHEMA_INVALID/);
  assert.throws(() => assertInvokeRequest({ ...request, agentSource: "provisioned", agentConfig: { autoApprove: true } }), /LEGACY_PERMISSION_CONFIG_REJECTED/);
});
