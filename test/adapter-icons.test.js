import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  adapterIcons,
  getAdapterIcon,
  codexIcon,
  claudeCodeIcon,
  qoderCliCnIcon
} from "@mininglamp-oss/octo-harness-adapter-icons";

const configUrl = new URL("../config/adapters.json", import.meta.url);

test("every adapter type in config/adapters.json ships an icon", async () => {
  const config = JSON.parse(await readFile(fileURLToPath(configUrl), "utf8"));
  const types = config.adapters.map((a) => a.type);
  const missing = types.filter((t) => getAdapterIcon(t) === undefined);
  assert.deepEqual(missing, [], `adapter types without an icon: ${missing.join(", ")}`);
  // The registry should not carry icons for types that are not registered adapters.
  assert.equal(adapterIcons.size, types.length);
});

test("each icon carries a non-empty inline SVG and a matching type/name", () => {
  for (const [type, icon] of adapterIcons) {
    assert.equal(icon.type, type, `icon.type must match its map key for ${type}`);
    assert.ok(icon.name.length > 0, `icon ${type} needs a name`);
    assert.match(icon.svg, /^<svg[\s>]/, `icon ${type} must be inline SVG markup`);
    if (icon.darkSvg !== undefined) assert.match(icon.darkSvg, /^<svg[\s>]/);
    if (icon.monochrome !== undefined) assert.equal(typeof icon.monochrome, "boolean");
  }
});

test("monochrome classification: codex is tintable, claude-code is full color", () => {
  assert.equal(codexIcon.monochrome, true);
  assert.notEqual(claudeCodeIcon.monochrome, true);
});

test("Qoder CN icon is the Qoder mark with a CN badge", () => {
  assert.equal(qoderCliCnIcon.type, "qoderclicn");
  assert.match(qoderCliCnIcon.svg, />CN</, "qoderclicn must overlay a CN badge");
});

test("getAdapterIcon returns undefined for unknown types", () => {
  assert.equal(getAdapterIcon("does-not-exist"), undefined);
});
