import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adapterIcons, getAdapterIcon } from "@mininglamp-oss/octo-runtime-adapter-icons";

test("every registered adapter type ships an icon from the independent project", async () => {
  const config = JSON.parse(await readFile(new URL("../config/adapters.json", import.meta.url), "utf8"));
  const types = config.adapters.map((adapter) => adapter.type);
  assert.deepEqual(types.filter((type) => getAdapterIcon(type) === undefined), []);
  assert.equal(adapterIcons.size, types.length);
});
