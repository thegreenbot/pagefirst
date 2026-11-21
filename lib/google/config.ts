/** True only when both Google OAuth credentials are present. Never log them. */
export function googleConfigured(): boolean {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return typeof id === "string" && id.length > 0 && typeof secret === "string" && secret.length > 0;
}
