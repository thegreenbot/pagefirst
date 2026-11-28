/** True only when both Google OAuth credentials are present. Never log them. */
export function googleConfigured(): boolean {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  return typeof id === "string" && id.length > 0 && typeof secret === "string" && secret.length > 0;
}

/** The Google Picker needs a browser API key and the Cloud project number (its app id). */
export function pickerConfig(): { apiKey: string; appId: string } | null {
  const apiKey = process.env.GOOGLE_PICKER_API_KEY?.trim();
  const appId = process.env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  return apiKey && appId ? { apiKey, appId } : null;
}
