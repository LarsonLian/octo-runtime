import {
  assertContextEnvs,
  contextItem,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-protocol";

/** Read only the frozen execution context; never expose its values as model input. */
export function invocationEnvs(request: InvokeRequest): Record<string, string> {
  const envs = contextItem(request.context, "octo.execution", "envs")?.payload ?? {
    env_variables: []
  };
  assertContextEnvs(envs);
  const overrides = request.executionEnvOverrides ?? { env_variables: [] };
  assertContextEnvs(overrides);
  return Object.fromEntries(
    [...envs.env_variables, ...overrides.env_variables].map(({ key, value }) => [key, value])
  );
}

/** Each invocation owns its environment. Adapter transport settings take precedence. */
export function invocationEnvironment(
  request: InvokeRequest,
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...inherited, ...invocationEnvs(request), ...overrides };
}
