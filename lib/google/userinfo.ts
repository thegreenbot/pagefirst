const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleIdentity = { sub: string; email: string | null };

/** The signed-in Google account, from the OpenID userinfo endpoint. Null when the token is refused. */
export async function fetchGoogleIdentity(token: string): Promise<GoogleIdentity | null> {
  let response: Response;
  try {
    response = await fetch(USERINFO_URL, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return null;
  }
  const body = (await response.json().catch(() => null)) as
    | { sub?: unknown; email?: unknown; email_verified?: unknown }
    | null;
  if (!body || typeof body.sub !== "string" || !body.sub) return null;
  const email =
    typeof body.email === "string" && body.email_verified === true ? body.email.trim().toLowerCase() : null;
  return { sub: body.sub, email };
}
