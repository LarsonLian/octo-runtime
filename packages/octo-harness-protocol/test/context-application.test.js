import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertContextApplicationEvidence, assertCanonicalEvent } from "../dist/index.js";

const fixture = JSON.parse(readFileSync(new URL("../schema/context-application.fixtures.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schema/protocol.schema.json", import.meta.url), "utf8"));
const Ajv = createRequire(new URL("../../octo-harness-daemon/package.json", import.meta.url))("ajv").default;
const ajv = new Ajv({ strict: false, logger: false });
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/definitions/ContextApplicationEvidence` });
for (const entry of fixture.cases) test(entry.name, () => {
  const input = { ...fixture.base, ...entry.patch };
  if (entry.remove) delete input[entry.remove];
  assert.equal(validate(input), entry.valid, JSON.stringify(validate.errors));
  if (entry.valid) {
    assertContextApplicationEvidence(input);
    assertCanonicalEvent({ protocolVersion: 2, type: "context.applied", payload: input });
  } else assert.throws(() => assertContextApplicationEvidence(input), /CONTEXT_APPLICATION_INVALID/);
});
