/** Resolve tenant scope through the octo-auth verify-bot contract. */
export async function verifyBotIdentity(
  apiUrl: string,
  token: string,
  signal: AbortSignal
): Promise<{ bot_uid: string; space_id: string }> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/auth/verify-bot`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bot_token: token })
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`IM_AUTH_HTTP_${response.status}`);
  }
  let data: { bot_uid?: unknown; space_id?: unknown };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error("IM_AUTH_IDENTITY_INVALID");
  }
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
