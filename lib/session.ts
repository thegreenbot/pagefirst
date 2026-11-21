import { cookies, headers } from "next/headers";

const ACCESS_COOKIE = "pf_access";
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
  const proto = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: proto === "https",
  };
}

export async function getAccessToken(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  return token ? token : null;
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
