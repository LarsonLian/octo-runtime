import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { RUNTIME_RUN_CONTRACT, RUNTIME_SELECTION_SCHEMA, assertResolvedRuntimeSelection } from "../packages/octo-harness-protocol/dist/index.js";
import { resolvedRuntimeSelection } from "./agent-work-runtime-fixture.js";

const fixtures = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/runtime-selection-fixtures.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/protocol.schema.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.resolve("eslint"));
const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, logger: false });
ajv.addKeyword("x-octo-unicode-scalar-strings", {
  validate: (enabled, value) => !enabled || scalarStrings(value)
});
ajv.addKeyword("x-octo-runtime-selection-invariants", {
  type: "object",
  validate: (enabled, value) => {
    if (!enabled || !Array.isArray(value.authorized_candidates)) return true;
    const runtimeIds = value.authorized_candidates.map(candidate => candidate?.runtime_id);
    const priorities = value.authorized_candidates.map(candidate => candidate?.priority);
    return new Set(runtimeIds).size === runtimeIds.length
      && new Set(priorities).size === priorities.length
      && (value.selection_mode !== "explicit" || (runtimeIds.length === 1 && runtimeIds[0] === value.explicit_runtime_id));
  }
});
ajv.addSchema(schema);
const validateSelectionSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/ResolvedRuntimeSelection` });

test("registration advertises schema 3 without changing Context or approval schemas", () => {
  assert.deepEqual(RUNTIME_RUN_CONTRACT, {
    schema_version: 3,
    routing_schema: RUNTIME_SELECTION_SCHEMA,
    context_schema: "octo.context-envelope/v1",
    approval_schema: "octo.approval-request/v1"
  });
  assert.equal(Object.isFrozen(RUNTIME_RUN_CONTRACT), true);
});

for (const fixture of fixtures) {
  test(`shared runtime selection fixture: ${fixture.name}`, () => {
    const original = structuredClone(fixture.selection);
    if (fixture.valid) assert.doesNotThrow(() => assertResolvedRuntimeSelection(fixture.selection));
    else assert.throws(() => assertResolvedRuntimeSelection(fixture.selection), TypeError);
    assert.equal(validateSelectionSchema(fixture.selection), fixture.valid, JSON.stringify(validateSelectionSchema.errors));
    assert.deepEqual(fixture.selection, original);
  });
}

test("runtime selection rejects non-JSON values without coercing or defaulting", () => {
  for (const selection of [undefined, null, [], false, 3, "selection"]) {
    assert.throws(() => assertResolvedRuntimeSelection(selection), /RESOLVED_RUNTIME_SELECTION_REQUIRED/);
  }
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol("runtime")]) {
    assert.throws(() => assertResolvedRuntimeSelection({ ...resolvedRuntimeSelection(), routing_policy_version: value }), TypeError);
  }
  const selection = resolvedRuntimeSelection();
  selection.binding_ref = undefined;
  assert.throws(() => assertResolvedRuntimeSelection(selection), TypeError);
});

function scalarStrings(value) {
  if (typeof value === "string") return !/[\uD800-\uDFFF]/u.test(value);
  if (Array.isArray(value)) return value.every(scalarStrings);
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) => scalarStrings(key) && scalarStrings(item));
  return true;
}
