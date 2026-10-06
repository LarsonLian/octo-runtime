import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";

/**
 * Qoder CLI ACP adapter. Launches `qodercli --yolo --acp` and speaks the Agent
 * Client Protocol through the shared ACP adapter, which reconstructs model
 * steps, streams the prompt turn and normalizes `session/update` notifications
 * into canonical events.
 *
 * `--yolo` selects Qoder's ACP "bypass permissions" mode so headless tool runs
 * do not block on interactive approval. Qoder advertises session loading, so a
 * stored provider session resumes through `session/load` without a fresh
 * fallback. Per-session model selection follows the standard ACP path when the
 * runtime configures a model that Qoder advertises.
 */
export const qoderCliAdapter = createAcpAdapter({
  type: "qodercli",
  provider: "qodercli",
  command: "qodercli",
  args: request => request.approvalMode === "full_access" ? ["--yolo", "--acp"] : ["--acp"]
});

export default qoderCliAdapter;
