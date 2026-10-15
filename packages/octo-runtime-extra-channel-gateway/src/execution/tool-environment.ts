import type { ContextEnvsPayload } from "@mininglamp-oss/octo-runtime-protocol";

/** Both values belong to the same configured channel, never the inbound message. */
export function octoCliEnvironment(apiUrl: string, token: string): ContextEnvsPayload {
  if (!/^bf_[A-Za-z0-9_-]+$/.test(token)) throw new Error("IM_BOT_TOKEN_INVALID");
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error("IM_API_URL_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("IM_API_URL_INVALID");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return {
    env_variables: [
      { key: "OCTO_BOT_TOKEN", value: token },
      { key: "OCTO_API_BASE_URL", value: url.href.replace(/\/+$/, "") }
    ]
  };
}
