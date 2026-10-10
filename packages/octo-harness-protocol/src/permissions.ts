import type { ApprovalMode } from "./generated/protocol-types.js";

/** Permission support is advertised per adapter, never inferred from its name. */
export function adapterApprovalModes(features: readonly string[]): ApprovalMode[] {
  return (["ask", "assisted", "full_access"] as ApprovalMode[])
    .filter(mode => features.includes(`approval.${mode}`));
}
