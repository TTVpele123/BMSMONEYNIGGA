/** Live Gmail provider is intentionally not wired until OAuth tokens for saevitzonoverstock@gmail.com are present. */
export const AUTHORIZED_SENDER = "saevitzonoverstock@gmail.com";

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
