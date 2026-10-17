import { connectionFetch, connectionJson, httpConnectionFailure } from "./connection-error.js";

/** Resolve tenant scope through the octo-auth verify-bot contract. */
export async function verifyBotIdentity(
  apiUrl: string,
  token: string,
  signal: AbortSignal
): Promise<{ bot_uid: string; space_id: string }> {
  const response = await connectionFetch(
    `${apiUrl.replace(/\/+$/, "")}/v1/auth/verify-bot`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token: token })
    },
    "AUTH"
  );
  if (!response.ok) {
    throw await httpConnectionFailure(response, "AUTH");
  }
  const data = (await connectionJson(response, "AUTH", "IM_AUTH_IDENTITY_INVALID")) as {
    bot_uid?: unknown;
    space_id?: unknown;
  };
  if (
    !data ||
    typeof data.bot_uid !== "string" ||
    !data.bot_uid ||
    typeof data.space_id !== "string" ||
    !data.space_id
  )
    throw new Error("IM_AUTH_IDENTITY_INVALID");
  return { bot_uid: data.bot_uid, space_id: data.space_id };
}
