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
  assert.equal(CONTEXT_CATALOG_VERSION, "octo.context-catalog/v1");
  assert.throws(() => contextTypeDefinition("unknown", "selection"), /CONTEXT_TYPE_UNSUPPORTED/);
});

test("processor coverage distinguishes stage consumers from routing-only items", () => {
  const context = { schema: "octo.context-envelope/v1", items: [
    {namespace:"octo.content", name:"selections", payload:{entries:[{text:"material"}]}},
    {namespace:"octo.runtime", name:"selection", payload:{mode:"explicit",runtime_id:"device"}}
  ] };
  assert.doesNotThrow(() => assertContextProcessorCoverage(context, "compile", new Set(["octo.content/selections"])));
  assert.throws(() => assertContextProcessorCoverage(context, "dispatch", new Set()), /CONTEXT_PROCESSOR_UNAVAILABLE: dispatch: octo.runtime\/selection/);
  assert.throws(() => assertContextProcessorCoverage(context, "compile", new Set()), /CONTEXT_PROCESSOR_UNAVAILABLE: compile/);
});

test("configuration rejects unknown fields and persistent trusted controls", () => {
  const empty = {schema:"octo.context-envelope/v1",items:[]};
  for (const invalid of [null, [], {}, {defaults:empty,mandatory:empty,source:"admin"},
    {defaults:empty,mandatory:{...empty,items:[{namespace:"octo.control",name:"instructions",payload:{entries:[]}}]}}]) {
    assert.throws(() => assertContextConfiguration(invalid));
  }
});

test("all resource namespaces validate and resolve independently", () => {
  const selection = namespace => ({namespace,name:"selection",payload:{include:[{resource_id:"shared",version:"1"}],exclude:[]}});
  const defaults = {schema:"octo.context-envelope/v1",items:["octo.plugins","octo.skills","octo.connectors"].map(selection)};
  const result = resolveContextConfiguration({defaults,mandatory:{...defaults,items:[]}}, {...defaults,items:[]});
  assert.equal(result.items.length, 3);
  assert.doesNotThrow(() => assertContextEnvelope(result));
});
