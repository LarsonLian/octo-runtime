import { createHash } from "node:crypto";
import type { ContextEnvelope } from "./generated/protocol-types.js";
import { canonicalContext } from "./context.js";

export function contextHash(context: ContextEnvelope): string {
  return `sha256:${createHash("sha256").update(canonicalContext(context)).digest("hex")}`;
}
