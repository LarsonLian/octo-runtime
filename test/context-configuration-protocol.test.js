import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTEXT_TYPE_CATALOG,
  assertContextConfiguration,
  assertContextEnvelope,
  canonicalContext,
  contextTypeDefinition,
  resolveContextConfiguration
} from "../packages/octo-runtime-protocol/dist/index.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../packages/octo-runtime-protocol/schema/protocol.schema.json", import.meta.url),
    "utf8"
  )
);
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../packages/octo-runtime-protocol/schema/context-configuration-fixtures.json",
      import.meta.url
    ),
    "utf8"
  )
);
for (const fixture of fixtures) {
  test(`configuration contract: ${fixture.name}`, () => {
    const original = structuredClone(fixture);
    if (fixture.error) {
      assert.throws(
        () => resolveContextConfiguration(fixture.configuration, fixture.request),
        (error) => error.message.startsWith(fixture.error)
      );
    } else {
      assert.doesNotThrow(() => assertContextConfiguration(fixture.configuration));
      const result = resolveContextConfiguration(fixture.configuration, fixture.request);
      assert.equal(canonicalContext(result), canonicalContext(fixture.expected));
      const reordered = structuredClone(fixture);
      reordered.request.items.reverse();
      reordered.configuration.defaults.items.reverse();
      reordered.configuration.mandatory.items.reverse();
      assert.equal(
        canonicalContext(resolveContextConfiguration(reordered.configuration, reordered.request)),
        canonicalContext(result)
      );
    }
    assert.deepEqual(fixture, original);
  });
}

test("catalog covers every schema branch, including grouped capability namespaces", () => {
  const keys = schema.definitions.ContextItem.allOf
    .filter((branch) => branch.if.properties.name)
    .flatMap((branch) =>
      (branch.if.properties.namespace.enum ?? [branch.if.properties.namespace.const]).map(
        (namespace) => `${namespace}/${branch.if.properties.name.const}`
      )
    );
  assert.deepEqual(
    CONTEXT_TYPE_CATALOG.map((item) => `${item.namespace}/${item.name}`).sort(),
    keys.sort()
  );
  for (const item of CONTEXT_TYPE_CATALOG) {
    assert.ok(schema.definitions[item.schemaRef.split("/").at(-1)]);
    assert.ok(Object.isFrozen(item));
  }
  assert.throws(() => contextTypeDefinition("unknown", "selection"), /CONTEXT_TYPE_UNSUPPORTED/);
});

test("business material types cannot become persistent execution defaults", () => {
  assert.equal(contextTypeDefinition("octo.content", "inline").persistent, false);
  assert.equal(contextTypeDefinition("octo.content", "references").persistent, false);
  assert.equal(contextTypeDefinition("octo.runtime", "selection").persistent, true);
});

test("configuration rejects unknown fields and default-layer trusted controls", () => {
  const empty = { schema: "octo.context-envelope/v3", items: [] };
  for (const invalid of [
    null,
    [],
    {},
    { defaults: empty, mandatory: empty, source: "admin" },
    {
      mandatory: empty,
      defaults: {
        ...empty,
        items: [{ namespace: "octo.control", name: "instructions", payload: { entries: [] } }]
      }
    }
  ]) {
    assert.throws(() => assertContextConfiguration(invalid));
  }
});

test("removed resource configuration cannot enter any Agent layer", () => {
  const defaults = {
    schema: "octo.context-envelope/v3",
    items: ["agent_plugins", "skills", "connectors"].map((name) => ({
      namespace: "octo.resources",
      name,
      payload: { include: [{ resource_id: "ae67cb3e-0d16-4bb2-9a4e-bb563cb707af" }], exclude: [] }
    }))
  };
  assert.throws(
    () =>
      resolveContextConfiguration(
        { defaults, mandatory: { ...defaults, items: [] } },
        { ...defaults, items: [] }
      ),
    /CONTEXT_TYPE_REMOVED/
  );
});
