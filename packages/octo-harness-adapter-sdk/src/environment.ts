import {
  assertContextEnvs,
  contextItem,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";

/** Read only the frozen execution context; never expose its values as model input. */
export function invocationEnvs(request: InvokeRequest): Record<string, string> {
  const envs = contextItem(request.context, "octo.execution", "envs")?.payload ?? {
    env_variables: []
  };
  assertContextEnvs(envs);
  return Object.fromEntries(envs.env_variables.map(({ key, value }) => [key, value]));
}

/** Each invocation owns its environment. Adapter transport settings take precedence. */
export function invocationEnvironment(
  request: InvokeRequest,
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...inherited, ...invocationEnvs(request), ...overrides };
}
