import { createHash, randomBytes } from "node:crypto";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export function createPkce(): { verifier: string; state: string } {
  return {
    verifier: randomBytes(32).toString("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthUrl({
  origin,
  state,
  verifier,
}: {
  origin: string;
  state: string;
  verifier: string;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode({
  origin,
  code,
  verifier,
}: {
  origin: string;
  code: string;
  verifier: string;
}): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: `${origin}/api/auth/callback`,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(String(res.status));
  }
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("No access token");
  }
  return { accessToken: json.access_token };
}
