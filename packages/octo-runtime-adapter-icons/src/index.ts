export type { AdapterIcon } from "./types.js";
export * from "./generated.js";

import type { AdapterIcon } from "./types.js";
import { adapterIcons } from "./generated.js";

/**
 * Look up an adapter's brand icon by its `type` (e.g. `"codex"`). Returns
 * `undefined` when no icon ships for that type, so consumers can fall back to a
 * generic glyph.
 */
export function getAdapterIcon(type: string): AdapterIcon | undefined {
  return adapterIcons.get(type === "zcode" ? "zcode-gui" : type);
}
