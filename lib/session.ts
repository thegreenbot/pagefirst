import { cookies, headers } from "next/headers";
import { ABSOLUTE_TIMEOUT_MS, accessTokenFor, readSession } from "@/lib/auth/server-sessions";
import { encryptionConfigured } from "@/lib/crypto/secretbox";
import { databaseConfigured } from "@/lib/db/client";
import { googleConfigured } from "@/lib/google/config";
import { oauthOriginFromHeaders } from "@/lib/google/origin";

/** Legacy: the raw Google access token. Only used when server sessions are not configured. */
const ACCESS_COOKIE = "pf_access";
/** Server sessions: an opaque id. `__Host-` needs https, so plain http (local dev) drops the prefix. */
const SESSION_COOKIE_SECURE = "__Host-pf_session";
const SESSION_COOKIE_PLAIN = "pf_session";
const VERIFIER_COOKIE = "pf_verifier";
const STATE_COOKIE = "pf_state";

async function cookieOptions(maxAge: number): Promise<{
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
}> {
  const headerList = await headers();
  const origin = oauthOriginFromHeaders(headerList);
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    // Host-only: no Domain. A Domain copied from the *.vercel.app request host
    // is rejected by a browser on the public https app, so the session would not stick.
    secure: origin.startsWith("https://"),
  };
}

/** True when Postgres, the encryption key and Google are all configured (#16). */
export function serverSessionsEnabled(): boolean {
  return databaseConfigured() && encryptionConfigured() && googleConfigured();
}

async function sessionCookieName(): Promise<string> {
  return (await cookieOptions(0)).secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

export async function getSessionId(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(SESSION_COOKIE_SECURE)?.value || jar.get(SESSION_COOKIE_PLAIN)?.value;
  return value ? value : null;
}

/** The signed-in Google account id for this request's session, when server sessions are on. */
export async function getSessionSub(): Promise<string | null> {
  if (!serverSessionsEnabled()) return null;
  const id = await getSessionId();
  if (!id) return null;
  return (await readSession(id))?.sub ?? null;
}

export async function getAccessToken(): Promise<string | null> {
  if (serverSessionsEnabled()) {
    const sub = await getSessionSub();
    if (sub) return accessTokenFor(sub);
  }
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  return token ? token : null;
}

export async function getLegacyAccessToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCESS_COOKIE)?.value || null;
}

export async function setSessionCookie(id: string): Promise<void> {
  const jar = await cookies();
  jar.set(await sessionCookieName(), id, await cookieOptions(Math.floor(ABSOLUTE_TIMEOUT_MS / 1000)));
  // A session replaces any legacy token cookie.
  jar.set(ACCESS_COOKIE, "", await cookieOptions(0));
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  const expired = await cookieOptions(0);
  jar.set(SESSION_COOKIE_PLAIN, "", expired);
  if (expired.secure) jar.set(SESSION_COOKIE_SECURE, "", expired);
  jar.set(ACCESS_COOKIE, "", expired);
}

export async function setAccessToken(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, token, await cookieOptions(3600));
}

export async function clearAccessToken(): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, "", await cookieOptions(0));
}

export async function setPkce(verifier: string, state: string): Promise<void> {
  const jar = await cookies();
  const options = await cookieOptions(600);
  jar.set(VERIFIER_COOKIE, verifier, options);
  jar.set(STATE_COOKIE, state, options);
}

export async function getPkce(): Promise<{ verifier: string | null; state: string | null }> {
  const jar = await cookies();
  return {
    verifier: jar.get(VERIFIER_COOKIE)?.value ?? null,
    state: jar.get(STATE_COOKIE)?.value ?? null,
  };
}

export async function clearPkce(): Promise<void> {
  const jar = await cookies();
  const options = await cookieOptions(0);
  jar.set(VERIFIER_COOKIE, "", options);
  jar.set(STATE_COOKIE, "", options);
}

const RETURN_COOKIE = "pf_return";
/** Only the consent screen may be returned to after sign-in, never an arbitrary URL. */
const RETURN_PATTERN = /^\/oauth\/authorize\?[A-Za-z0-9%&=._~:/+*!'(),-]{1,2000}$/;

export function safeReturnPath(value: string | null | undefined): string | null {
  return value && RETURN_PATTERN.test(value) ? value : null;
}

export async function setReturnTo(path: string): Promise<void> {
  const jar = await cookies();
  jar.set(RETURN_COOKIE, path, await cookieOptions(600));
}

/** Reads and clears the post-sign-in destination. */
export async function takeReturnTo(): Promise<string | null> {
  const jar = await cookies();
  const value = safeReturnPath(jar.get(RETURN_COOKIE)?.value);
  if (jar.get(RETURN_COOKIE)) jar.set(RETURN_COOKIE, "", await cookieOptions(0));
  return value;
}
