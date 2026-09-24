import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";

/**
 * Qoder CN CLI ACP adapter. Launches `qoderclicn --yolo --acp` and speaks the
 * Agent Client Protocol through the shared ACP adapter, which reconstructs
 * model steps, streams the prompt turn and normalizes `session/update`
 * notifications into canonical events.
 *
 * This is the China (CN) distribution of Qoder; it behaves like Qoder CLI —
 * `--yolo` selects the ACP "bypass permissions" mode and a stored provider
 * session resumes through `session/load` — but ships as a distinct `qoderclicn`
 * binary and is registered as its own adapter type so a runtime can pick the CN
 * build explicitly.
 */
export const qoderCliCnAdapter = createAcpAdapter({
  type: "qoderclicn",
  provider: "qoderclicn",
  command: "qoderclicn",
  args: ["--yolo", "--acp"]
});

export default qoderCliCnAdapter;
