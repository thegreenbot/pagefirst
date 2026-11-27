import { createHash, randomBytes } from "node:crypto";
import { callbackUrl } from "@/lib/google/origin";

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
  offline = false,
}: {
  origin: string;
  state: string;
  verifier: string;
  /** Ask for a refresh token, so the server can keep acting after the hour is up. */
  offline?: boolean;
}): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", callbackUrl(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (offline) {
    url.searchParams.set("access_type", "offline");
    // Google only returns a refresh token on consent, so ask again each sign-in.
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

export type GoogleGrant = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function parseGrant(json: Record<string, unknown>): GoogleGrant {
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("No access token");
  }
  const expires = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 3600,
    scope: typeof json.scope === "string" ? json.scope : "",
  };
}

async function tokenRequest(body: URLSearchParams): Promise<GoogleGrant> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Error(String(res.status));
  }
  return parseGrant((await res.json()) as Record<string, unknown>);
}

export async function exchangeCode({
  origin,
  code,
  verifier,
}: {
  origin: string;
  code: string;
  verifier: string;
}): Promise<GoogleGrant> {
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: callbackUrl(origin),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  );
}

/** Trades a refresh token for a fresh access token. Throws "400"/"401" when Google has revoked it. */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleGrant> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );
}

/** Revokes a grant at Google. Revoking a refresh token also revokes its access tokens. Best effort. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      cache: "no-store",
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}
