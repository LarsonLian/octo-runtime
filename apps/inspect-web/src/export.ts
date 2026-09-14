import { strToU8, zipSync } from "fflate";
import type { InspectRecord } from "./domain";

export function createInspectBundle(
  events: readonly InspectRecord[],
  diagnostics: Record<string, unknown>
): Uint8Array {
  const generatedAt = new Date().toISOString();
  const eventsJsonl = events
    .slice()
    .reverse()
    .map(event => JSON.stringify(event.value))
    .join("\n");
  return zipSync({
    "events.jsonl": strToU8(eventsJsonl),
    "diagnostics.json": strToU8(JSON.stringify({ generated_at: generatedAt, ...diagnostics }, null, 2)),
    "schema-manifest.json": strToU8(JSON.stringify({
      schema: "octo-harness.inspect-export/v1",
      generated_at: generatedAt,
      event_schema: "octo-harness.live-event/v1",
      order: "oldest_to_newest"
    }, null, 2))
  }, { level: 6 });
}

export function downloadInspectBundle(
  events: readonly InspectRecord[],
  diagnostics: Record<string, unknown>
): void {
  const bytes = createInspectBundle(events, diagnostics);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `octo-inspect-${new Date().toISOString().replaceAll(":", "-")}.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
