const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** `hd` is the Google Workspace domain, present only for Workspace-managed accounts. */
export type GoogleIdentity = { sub: string; email: string | null; hd: string | null };

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
    | { sub?: unknown; email?: unknown; email_verified?: unknown; hd?: unknown }
    | null;
  if (!body || typeof body.sub !== "string" || !body.sub) return null;
  const email =
    typeof body.email === "string" && body.email_verified === true ? body.email.trim().toLowerCase() : null;
  const hd = typeof body.hd === "string" && body.hd.trim() ? body.hd.trim().toLowerCase() : null;
  return { sub: body.sub, email, hd };
}
