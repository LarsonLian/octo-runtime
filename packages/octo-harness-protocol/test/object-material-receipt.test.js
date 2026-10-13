import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const schema = JSON.parse(
  readFileSync(new URL("../schema/protocol.schema.json", import.meta.url), "utf8")
);
const Ajv = createRequire(new URL("../../octo-harness-daemon/package.json", import.meta.url))(
  "ajv"
).default;
const ajv = new Ajv({ strict: false, logger: false });
ajv.addSchema(schema);
const validate = ajv.compile({ $ref: `${schema.$id}#/definitions/PublicObjectMaterial` });
const fact = {
  resource_ref: "selection-node",
  object_type: "task",
  object_id: "task-1",
  origin: "mention",
  byte_size: 81,
  digest: "sha256:" + "a".repeat(64),
  revision: "7",
  selector: { mode: "history", start: 2, end: 2 }
};
test("frozen fact receipts contain finite source metadata and no local handles or contents", () => {
  assert.equal(validate(fact), true, JSON.stringify(validate.errors));
  const { object_id, ...local } = { ...fact, object_type: "local_file" };
  assert.equal(validate(local), true, JSON.stringify(validate.errors));
  for (const value of [
    { ...local, object_id: "opaque-handle" },
    { ...fact, text: "contents" },
    { ...fact, object_id: "/private/task" },
    { ...fact, byte_size: 32769 },
    { ...fact, selector: { mode: "history", start: -1 } }
  ])
    assert.equal(validate(value), false);
});
