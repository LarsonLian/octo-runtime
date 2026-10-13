/** Provider progress used by the host watchdog to enforce execution deadlines. */
export interface ProviderActivity {
  kind: "turn_started" | "turn_progress" | "transport_response" | "retry_notice";
  method: "turn_start" | "text_delta" | "tool_delta" | "item_lifecycle" | "usage" | "rpc_response" | "retry";
  toolCallId?: string;
}

export interface AdapterInvocationContext {
  reportActivity?(activity: ProviderActivity): void;
}
