import {
  assertExecutionEvidence,
  type CanonicalEvent,
  type ExecutionEvidence
} from "@mininglamp-oss/octo-runtime-protocol";
import type { AdapterOutput } from "./index.js";

/** 将原生适配事实放回同一次调用；不维护产品模式或会话状态。 */
export function actmodeEvidence(
  actmode: ExecutionEvidence["actmode"],
  protocolMode?: "canonical"
): CanonicalEvent;
export function actmodeEvidence(
  actmode: ExecutionEvidence["actmode"],
  protocolMode: "native" | "canonical" | undefined
): AdapterOutput;
export function actmodeEvidence(
  actmode: ExecutionEvidence["actmode"],
  protocolMode?: "native" | "canonical"
): AdapterOutput {
  const payload = { actmode };
  assertExecutionEvidence(payload);
  return protocolMode === "native"
    ? { kind: "control", control: { type: "evidence", name: "execution", payload } }
    : { protocolVersion: 2, type: "execution.update", payload };
}
