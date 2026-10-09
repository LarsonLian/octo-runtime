import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTEXT_TYPE_CATALOG, CONTEXT_CATALOG_VERSION, assertContextConfiguration,
  assertContextEnvelope, assertContextProcessorCoverage, canonicalContext,
  contextTypeDefinition, resolveContextConfiguration
} from "../packages/octo-harness-protocol/dist/index.js";

const schema = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/protocol.schema.json", import.meta.url), "utf8"));
const fixtures = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/context-configuration-fixtures.json", import.meta.url), "utf8"));
for (const fixture of fixtures) {
  test(`configuration contract: ${fixture.name}`, () => {
    const original = structuredClone(fixture);
    if (fixture.error) {
      assert.throws(() => resolveContextConfiguration(fixture.configuration, fixture.request), error => error.message.startsWith(fixture.error));
    } else {
      assert.doesNotThrow(() => assertContextConfiguration(fixture.configuration));
      const result = resolveContextConfiguration(fixture.configuration, fixture.request);
      assert.equal(canonicalContext(result), canonicalContext(fixture.expected));
      const reordered = structuredClone(fixture);
      reordered.request.items.reverse();
      reordered.configuration.defaults.items.reverse();
      reordered.configuration.mandatory.items.reverse();
      assert.equal(canonicalContext(resolveContextConfiguration(reordered.configuration, reordered.request)), canonicalContext(result));
    }
    assert.deepEqual(fixture, original);
  });
}

test("catalog covers every schema branch, including grouped capability namespaces", () => {
  const keys = schema.definitions.ContextItem.oneOf.flatMap(branch =>
    (branch.properties.namespace.enum ?? [branch.properties.namespace.const]).map(namespace => `${namespace}/${branch.properties.name.const}`));
  assert.deepEqual(CONTEXT_TYPE_CATALOG.map(item => `${item.namespace}/${item.name}`).sort(), keys.sort());
  for (const item of CONTEXT_TYPE_CATALOG) {
    assert.ok(schema.definitions[item.schemaRef.split("/").at(-1)]);
    assert.ok(Object.isFrozen(item.stages));
    assert.ok(Object.isFrozen(item));
  }
  assert.equal(CONTEXT_CATALOG_VERSION, "octo.context-catalog/v2");
  assert.throws(() => contextTypeDefinition("unknown", "selection"), /CONTEXT_TYPE_UNSUPPORTED/);
});

test("processor coverage enforces aggregate execution and materials", () => {
  const context = { schema: "octo.context-envelope/v2", items: [
    {namespace:"octo.content", name:"materials", payload:{entries:[{type:"inline",text:"material"}]}},
    {namespace:"octo.execution", name:"config", payload:{runtime:{mode:"explicit",runtime_id:"device"}}}
  ] };
  assert.doesNotThrow(() => assertContextProcessorCoverage(context, "compile", new Set(["octo.content/materials", "octo.execution/config"])));
  assert.throws(() => assertContextProcessorCoverage(context, "dispatch", new Set()), /CONTEXT_PROCESSOR_UNAVAILABLE: dispatch: octo.execution\/config/);
  assert.throws(() => assertContextProcessorCoverage(context, "compile", new Set()), /CONTEXT_PROCESSOR_UNAVAILABLE: compile/);
});

test("configuration rejects unknown fields and persistent trusted controls", () => {
  const empty = {schema:"octo.context-envelope/v2",items:[]};
  for (const invalid of [null, [], {}, {defaults:empty,mandatory:empty,source:"admin"},
    {defaults:empty,mandatory:{...empty,items:[{namespace:"octo.control",name:"instructions",payload:{entries:[]}}]}}]) {
    assert.throws(() => assertContextConfiguration(invalid));
  }
});

test("resource kinds with the same UUID are independent identities", () => {
  const include = ["agent_plugin", "skill", "connector"].map(kind => ({ kind, resource_id: "ae67cb3e-0d16-4bb2-9a4e-bb563cb707af" }));
  const defaults = { schema: "octo.context-envelope/v2", items: [{namespace:"octo.resources",name:"selection",payload:{include,exclude:[]}}] };
  const result = resolveContextConfiguration({defaults,mandatory:{...defaults,items:[]}}, {...defaults,items:[]});
  assert.equal(result.items[0].payload.include.length, 3);
});
