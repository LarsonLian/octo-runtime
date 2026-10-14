import { assertContextEnvelope, contextItem } from "./context.js";
import type { ContextEnvelope } from "./generated/protocol-types.js";

/** Sources are validated by the producer's authorization boundary, not by rendering. */
export function contextControlInstructions(context: ContextEnvelope): string {
  assertContextEnvelope(context);
  const entries = contextItem(context, "octo.control", "instructions")?.payload.entries;
  return Array.isArray(entries)
    ? entries.map((entry) => (entry as { text: string }).text).join("\n\n")
    : "";
}
