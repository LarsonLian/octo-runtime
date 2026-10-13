export { NodeEmbeddedHarness } from "./embedded-harness.js";
export { EmbeddedHarnessError } from "./errors.js";
export { EMBEDDED_HARNESS_VERSION } from "./version.js";
export { accountKeyFor, embeddedHomePaths, profileNameFor, resolveEmbeddedHome } from "./home.js";
export type {
  AccountSubject,
  AuthorizedTenant,
  EmbeddedDistribution,
  EmbeddedHarness,
  EmbeddedHarnessOptions,
  EmbeddedHealth,
  EmbeddedPhase,
  EmbeddedProblem,
  ProfileHealth,
  StartAccountOptions
} from "./types.js";

import { NodeEmbeddedHarness } from "./embedded-harness.js";
import type { EmbeddedHarness, EmbeddedHarnessOptions } from "./types.js";

export function createEmbeddedHarness(options: EmbeddedHarnessOptions): EmbeddedHarness {
  return new NodeEmbeddedHarness(options);
}
