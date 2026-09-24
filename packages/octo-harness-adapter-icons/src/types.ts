/**
 * A provider/adapter brand icon, delivered as an inline SVG source string so
 * downstream React / Electron / vanilla consumers can bundle it directly
 * (`import { getAdapterIcon } from "@mininglamp-oss/octo-harness-adapter-icons"`)
 * instead of copying image files or resolving local paths. The shape mirrors
 * octo-web's `ProviderIcon`, but ships the SVG markup inline rather than a URL.
 */
export interface AdapterIcon {
  /** Adapter/provider type this icon identifies, e.g. `"codex"`. */
  type: string;
  /** Human-readable brand name, e.g. `"Codex"`. */
  name: string;
  /** Inline SVG source (default / light variant). */
  svg: string;
  /** Optional dark-theme SVG variant when the brand ships one (e.g. OpenCode). */
  darkSvg?: string;
  /**
   * True for single-color glyphs meant to be tinted by the consumer (via
   * `currentColor` / CSS `maskImage`) so they stay visible across themes.
   */
  monochrome?: boolean;
}
