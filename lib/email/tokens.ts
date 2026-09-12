import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../paths";
import { AUTHORIZED_SENDER } from "./address";
import { decryptJson, encryptJson } from "./crypto";

export function gmailRedirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI?.trim()
    || `http://localhost:${process.env.BMSM_PORT || "3222"}/api/gmail/oauth/callback`;
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export type GmailTokenFile = {
  address: string;
  refresh_token: string;
  access_token: string;
  expiry: string;
  scopes: string[];
  updated_at: string;
};

export function tokenPath(): string {
  const dir = path.join(dataRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "gmail-oauth.enc");
}

export function loadTokens(): GmailTokenFile | null {
  const file = tokenPath();
  if (!fs.existsSync(file)) return null;
  try {
    return decryptJson<GmailTokenFile>(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Omit<GmailTokenFile, "updated_at">): void {
  const payload: GmailTokenFile = { ...tokens, updated_at: new Date().toISOString() };
  fs.writeFileSync(tokenPath(), encryptJson(payload), { mode: 0o600 });
}

export function clearTokens(): void {
  try { fs.unlinkSync(tokenPath()); } catch { /* missing is fine */ }
}

export function tokensPresent(): boolean {
  const t = loadTokens();
  return Boolean(t?.refresh_token && t.address === AUTHORIZED_SENDER);
}

export function oauthClientConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

export async function refreshAccess(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const t = loadTokens();
  if (!t) return null;
  if (t.access_token && Date.parse(t.expiry) - 60_000 > Date.now()) return t.access_token;
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) return null;
  const j = await r.json() as { access_token: string; expires_in?: number };
  saveTokens({
    address: t.address,
    refresh_token: t.refresh_token,
    access_token: j.access_token,
    expiry: new Date(Date.now() + (j.expires_in ?? 3500) * 1000).toISOString(),
    scopes: t.scopes,
  });
  return j.access_token;
}

export async function exchangeAuthorizationCode(code: string, fetchImpl: typeof fetch = fetch): Promise<GmailTokenFile> {
  const r = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: gmailRedirectUri(),
    }),
  });
  if (!r.ok) throw new Error(`OAuth token exchange failed (${r.status})`);
  const j = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!j.refresh_token) throw new Error("Google did not return a refresh_token — revoke access and consent again");
  const profile = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${j.access_token}` },
  });
  if (!profile.ok) throw new Error("Could not read Gmail profile");
  const ident = await profile.json() as { emailAddress?: string };
  const address = ident.emailAddress?.trim().toLowerCase() ?? "";
  if (address !== AUTHORIZED_SENDER) {
    throw new Error(`authenticated as ${address || "unknown"}, expected ${AUTHORIZED_SENDER}`);
  }
  const tokens: Omit<GmailTokenFile, "updated_at"> = {
    address,
    refresh_token: j.refresh_token,
    access_token: j.access_token,
    expiry: new Date(Date.now() + (j.expires_in ?? 3500) * 1000).toISOString(),
    scopes: (j.scope ?? GMAIL_SCOPES.join(" ")).split(/\s+/).filter(Boolean),
  };
  saveTokens(tokens);
  return { ...tokens, updated_at: new Date().toISOString() };
}
