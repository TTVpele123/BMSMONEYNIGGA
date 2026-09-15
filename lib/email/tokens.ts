import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../paths";
import { AUTHORIZED_SENDER, PREVIOUS_SENDER } from "./address";
import { decryptJson, encryptJson } from "./crypto";

export function gmailRedirectUri(): string {
  return process.env.GMAIL_REDIRECT_URI?.trim()
    || `http://localhost:${process.env.BMSM_PORT || "3222"}/api/gmail/oauth/callback`;
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export const GMAIL_LEGACY_INBOUND_SCOPES = [
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

export type GmailOAuthMailbox = "send" | "legacy_inbound";

function tokenDir(): string {
  const dir = path.join(dataRoot(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tokenPath(): string {
  return path.join(tokenDir(), "gmail-oauth.enc");
}

export function legacyTokenPath(): string {
  return path.join(tokenDir(), "gmail-oauth-legacy.enc");
}

function readTokenFile(file: string): GmailTokenFile | null {
  if (!fs.existsSync(file)) return null;
  try {
    return decryptJson<GmailTokenFile>(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeTokenFile(file: string, tokens: Omit<GmailTokenFile, "updated_at">): GmailTokenFile {
  const payload: GmailTokenFile = { ...tokens, updated_at: new Date().toISOString() };
  fs.writeFileSync(file, encryptJson(payload), { mode: 0o600 });
  return payload;
}

export function loadTokens(): GmailTokenFile | null {
  return readTokenFile(tokenPath());
}

export function loadLegacyTokens(): GmailTokenFile | null {
  const t = readTokenFile(legacyTokenPath());
  if (!t || t.address !== PREVIOUS_SENDER) return null;
  return t;
}

export function saveTokens(tokens: Omit<GmailTokenFile, "updated_at">): void {
  if (tokens.address !== AUTHORIZED_SENDER) {
    throw new Error(`refusing to store send tokens for ${tokens.address}`);
  }
  writeTokenFile(tokenPath(), tokens);
}

export function saveLegacyTokens(tokens: Omit<GmailTokenFile, "updated_at">): void {
  if (tokens.address !== PREVIOUS_SENDER) {
    throw new Error(`legacy inbound tokens must be ${PREVIOUS_SENDER}`);
  }
  writeTokenFile(legacyTokenPath(), tokens);
}

export function clearTokens(): void {
  try { fs.unlinkSync(tokenPath()); } catch { /* missing is fine */ }
}

export function clearLegacyTokens(): void {
  try { fs.unlinkSync(legacyTokenPath()); } catch { /* missing is fine */ }
}

export function tokensPresent(): boolean {
  const t = loadTokens();
  return Boolean(t?.refresh_token && t.address === AUTHORIZED_SENDER);
}

export function legacyTokensPresent(): boolean {
  return Boolean(loadLegacyTokens()?.refresh_token);
}

export function oauthClientConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

async function refreshStoredAccess(
  load: () => GmailTokenFile | null,
  save: (tokens: Omit<GmailTokenFile, "updated_at">) => void,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const t = load();
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
  save({
    address: t.address,
    refresh_token: t.refresh_token,
    access_token: j.access_token,
    expiry: new Date(Date.now() + (j.expires_in ?? 3500) * 1000).toISOString(),
    scopes: t.scopes,
  });
  return j.access_token;
}

export async function refreshAccess(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return refreshStoredAccess(loadTokens, saveTokens, fetchImpl);
}

export async function refreshLegacyAccess(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return refreshStoredAccess(loadLegacyTokens, saveLegacyTokens, fetchImpl);
}

export function expectedAddressForMailbox(mailbox: GmailOAuthMailbox): string {
  return mailbox === "legacy_inbound" ? PREVIOUS_SENDER : AUTHORIZED_SENDER;
}

export async function exchangeAuthorizationCode(
  code: string,
  opts: { expected?: string; fetchImpl?: typeof fetch } = {},
): Promise<GmailTokenFile> {
  const expected = (opts.expected ?? AUTHORIZED_SENDER).trim().toLowerCase();
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (expected !== AUTHORIZED_SENDER && expected !== PREVIOUS_SENDER) {
    throw new Error(`mailbox ${expected} is not allowed`);
  }
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
  if (address !== expected) {
    throw new Error(`authenticated as ${address || "unknown"}, expected ${expected}`);
  }
  const defaultScopes = expected === PREVIOUS_SENDER ? GMAIL_LEGACY_INBOUND_SCOPES.join(" ") : GMAIL_SCOPES.join(" ");
  const tokens: Omit<GmailTokenFile, "updated_at"> = {
    address,
    refresh_token: j.refresh_token,
    access_token: j.access_token,
    expiry: new Date(Date.now() + (j.expires_in ?? 3500) * 1000).toISOString(),
    scopes: (j.scope ?? defaultScopes).split(/\s+/).filter(Boolean),
  };
  if (expected === AUTHORIZED_SENDER) saveTokens(tokens);
  else saveLegacyTokens(tokens);
  return { ...tokens, updated_at: new Date().toISOString() };
}
