import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { databaseConfigured } from "@/lib/db/client";
import { sameOrigin } from "@/lib/http/csrf";
import { parseScopes, validChallenge } from "@/lib/oauth/protocol";
import { getClient, issueCode, type OAuthClient } from "@/lib/oauth/store";
import { getSessionSub } from "@/lib/session";
import type { Scope } from "@/lib/service/context";

export const dynamic = "force-dynamic";

/** Consent screens never run script and cannot be framed. */
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const SCOPE_TEXT: Record<Scope, string> = {
  "pages:read": "Read your pages and preview them",
  "pages:commit": "Create pages and edit them",
  "pages:import": "Import changes made directly in your Google Docs",
  "pages:publish": "Publish pages to the public web",
};

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.4rem}ul{padding-left:1.2rem}button,a.btn{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}button.ghost{background:#fff;color:#1a1a1a}form{display:inline}.warn{color:#8a3b00}</style></head><body>${body}</body></html>`;
  return new NextResponse(html, { status, headers: PAGE_HEADERS });
}

const errorPage = (message: string, status = 400) => page("Cannot authorize", `<h1>Cannot authorize</h1><p>${esc(message)}</p>`, status);

type Params = {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  scopes: Scope[];
  state: string | null;
  fields: Record<string, string>;
};

/** Validates the request. Until the client and redirect URI check out, errors are shown here, never redirected. */
async function parse(input: URLSearchParams): Promise<Params | NextResponse> {
  if (!databaseConfigured()) return errorPage("Sign-in for MCP clients is not available on this instance.", 503);
  const client = await getClient(input.get("client_id") ?? "");
  const redirectUri = input.get("redirect_uri") ?? "";
  if (!client || !client.redirectUris.includes(redirectUri)) return errorPage("This application is not registered, or its redirect address does not match.");
  const state = input.get("state");
  const back = (error: string, description: string) => redirectPage(redirectUri, { error, error_description: description, ...(state ? { state } : {}) });
  if (input.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = input.get("code_challenge");
  if (!validChallenge(challenge) || input.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required.");
  const scopes = parseScopes(input.get("scope"));
  if (!scopes) return back("invalid_scope", "Unknown scope requested.");
  const fields: Record<string, string> = {
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: scopes.join(" "),
  };
  if (state) fields.state = state;
  return { client, redirectUri, codeChallenge: challenge, scopes, state, fields };
}

/**
 * Sends the browser back to the client. A 200 page with a refresh, not a 302
 * from the form POST: Chrome applies `form-action 'self'` to redirects after a form.
 */
function redirectPage(redirectUri: string, params: Record<string, string>): NextResponse {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const target = url.toString();
  const headers = { ...PAGE_HEADERS };
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${esc(target)}"><title>Returning to the app</title></head><body style="font:16px system-ui;margin:12vh auto;max-width:30rem"><p>Returning to the app… <a href="${esc(target)}">Continue</a></p></body></html>`,
    { status: 200, headers },
  );
}

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = await parse(url.searchParams);
  if (parsed instanceof NextResponse) return parsed;

  const sub = await getSessionSub();
  if (!sub) {
    const back = `/oauth/authorize${url.search}`;
    return page(
      "Sign in to continue",
      `<h1>Sign in to continue</h1><p><strong>${esc(parsed.client.name)}</strong> wants to use your Pagefirst account. Sign in with Google first.</p><p><a class="btn" href="/api/auth/google?return=${encodeURIComponent(back)}">Sign in with Google</a></p>`,
    );
  }

  const list = parsed.scopes.map((scope) => `<li>${esc(SCOPE_TEXT[scope])}</li>`).join("");
  const publish = parsed.scopes.includes("pages:publish") ? `<p class="warn">This lets the app make pages public.</p>` : "";
  return page(
    "Allow access",
    `<h1>Allow ${esc(parsed.client.name)}?</h1><p>This app will be able to act as you in Pagefirst and:</p><ul>${list}</ul>${publish}<p>You can revoke access at any time. Only approve apps you trust.</p>
<form method="post" action="/oauth/authorize">${hidden(parsed.fields)}<button name="decision" value="approve">Allow</button></form>
<form method="post" action="/oauth/authorize">${hidden(parsed.fields)}<button class="ghost" name="decision" value="deny">Deny</button></form>`,
  );
}

export async function POST(request: Request) {
  // This route reads the session cookie, so it gets the same cross-site check as /api.
  if (!sameOrigin(request)) return errorPage("Cross-site request refused.", 403);
  const form = new URLSearchParams(await request.text());
  const parsed = await parse(form);
  if (parsed instanceof NextResponse) return parsed;
  const sub = await getSessionSub();
  if (!sub) return errorPage("Sign in first.", 401);

  const stateParam: Record<string, string> = parsed.state ? { state: parsed.state } : {};
  if (form.get("decision") !== "approve") {
    await auditRequest(request, { event: "request.denied", outcome: "denied", status: 200, errorCode: "oauth:consent_denied", actorKey: parsed.client.clientId });
    return redirectPage(parsed.redirectUri, { error: "access_denied", ...stateParam });
  }
  const code = await issueCode({ clientId: parsed.client.clientId, sub, scopes: parsed.scopes, codeChallenge: parsed.codeChallenge, redirectUri: parsed.redirectUri });
  await auditRequest(request, { event: "oauth.authorized", outcome: "ok", status: 200, client: "mcp", actorKey: parsed.client.clientId });
  return redirectPage(parsed.redirectUri, { code, ...stateParam });
}

