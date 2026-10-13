// The public entry point exports only the stable domain API; the internal file layout should not become a caller dependency.
export { MemoryStore, SqliteStore } from "./store.js";
export { openWalDatabase } from "./sqlite.js";
export { HarnessEngine } from "./engine.js";
export { composeContext, renderPortableInstructions } from "./prompt.js";
export type {
  Agent,
  AgentRun,
  AgentRunStatus,
  AgentRunTrigger,
  AgentSession,
  Store
} from "./store.js";
export type {
  HarnessHost,
  RegisterAgentInput,
  ReplaceDefaultContextInput,
  SubmitAgentRunInput,
  SubmitAgentRunResult
} from "./engine.js";
export type { LocalAgentConfig } from "./context.js";
