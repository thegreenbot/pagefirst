/**
 * Shared redaction for anything that might reach a log line or an error body.
 * Removes the given secrets plus every server secret from the environment.
 */
const SECRET_ENV = ["GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "CLOUDFLARE_API_TOKEN", "KV_REST_API_TOKEN"];

export function redact(message: string, ...secrets: (string | null | undefined)[]): string {
  const all = [...secrets, ...SECRET_ENV.map((name) => process.env[name])]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 6);
  let text = all.reduce((out, secret) => out.split(secret).join("[redacted]"), message);
  // Google OAuth tokens have recognisable prefixes even when we don't hold the value.
  text = text.replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]").replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted]");
  return text;
}
