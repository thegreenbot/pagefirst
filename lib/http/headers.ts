/**
 * Security headers for the app. No Node-only imports: middleware and
 * next.config both use this file.
 */

/** Sent on every response (see next.config.ts). */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/**
 * CSP for app pages. Scripts need this request's nonce, which Next.js adds to
 * its own scripts when it sees the policy on the request. Styles allow inline
 * because React renders `style` attributes; scripts never do.
 */
export function appContentSecurityPolicy(nonce: string, { dev = false } = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  // React's dev overlay and fast refresh evaluate code; production never does.
  if (dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A random nonce from the Web Crypto API (available in middleware and Node). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
