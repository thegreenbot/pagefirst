/**
 * Stopgap for #85: public publishing goes to one shared Cloudflare project, so
 * only accounts listed in PUBLISH_ALLOWLIST (comma- or space-separated emails)
 * may publish publicly. Unset or empty means nobody can.
 */
export function publishAllowlist(): Set<string> {
  const raw = process.env.PUBLISH_ALLOWLIST ?? "";
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.includes("@")),
  );
}

export function mayPublishPublicly(email: string | null): boolean {
  if (!email) return false;
  return publishAllowlist().has(email.trim().toLowerCase());
}
