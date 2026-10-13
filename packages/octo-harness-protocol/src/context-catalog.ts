export interface ContextTypeDefinition {
  readonly namespace: string;
  readonly name: string;
  readonly schemaRef: string;
  readonly persistent: boolean;
  readonly trustedOnly: boolean;
}

function entry(namespace: string, name: string, schema: string, persistent: boolean, trustedOnly = false): ContextTypeDefinition {
  return Object.freeze({ namespace, name, schemaRef: `#/definitions/${schema}`, persistent, trustedOnly });
}

/** Built-in schema and execution-configuration classification; no processing stages. */
export const CONTEXT_TYPE_CATALOG: readonly ContextTypeDefinition[] = Object.freeze([
  entry("octo.execution", "adapter", "ContextAdapterPayload", true),
  entry("octo.execution", "model", "ContextModelPayload", true),
  entry("octo.execution", "workspace", "ContextWorkspacePayload", true),
  entry("octo.execution", "envs", "ContextEnvsPayload", true),
  entry("octo.execution", "limits", "ContextLimitsPayload", true),
  entry("octo.runtime", "selection", "ContextRuntimeSelectionPayload", true),
  entry("octo.security", "approval_policy", "ContextApprovalPolicyPayload", true),
  entry("octo.content", "inline", "ContextInlinePayload", false),
  entry("octo.content", "references", "ContextReferencesPayload", false),
  entry("octo.control", "instructions", "ContextInstructionsPayload", false, true)
]);

export function contextTypeDefinition(namespace: string, name: string): ContextTypeDefinition {
  const definition = findContextTypeDefinition(namespace, name);
  if (!definition) throw new TypeError(`CONTEXT_TYPE_UNSUPPORTED: ${namespace}/${name}`);
  return definition;
}

export function findContextTypeDefinition(namespace: string, name: string): ContextTypeDefinition | undefined {
  return CONTEXT_TYPE_CATALOG.find(item => item.namespace === namespace && item.name === name);
}
