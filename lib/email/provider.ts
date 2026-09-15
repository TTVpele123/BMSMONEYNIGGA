import { db } from "../db";
import { assertLiveOutbound } from "../outbound-gate";
import { AUTHORIZED_SENDER, assertAuthorizedSender, isOurMailbox, parseFromHeader } from "./address";
import { inboxBounceFlags } from "./bounce";
import { buildRawMessage, type MimeAttachment } from "./mime";
import {
  legacyTokensPresent,
  loadLegacyTokens,
  loadTokens,
  oauthClientConfigured,
  refreshAccess,
  refreshLegacyAccess,
  saveLegacyTokens,
  saveTokens,
  tokensPresent,
} from "./tokens";

const GMAIL_RETRY_AFTER = /Retry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

/** Honor Gmail's last 429 Retry-After. Do not call send again until that instant. */
export function gmailSendCooldownUntil(): Date | null {
  const row = db().prepare(
    `SELECT reason FROM outreach_attempts
      WHERE status='failed' AND reason LIKE '%Retry after%'
      ORDER BY id DESC LIMIT 1`
  ).get() as { reason: string } | undefined;
  const hit = row?.reason.match(GMAIL_RETRY_AFTER);
  if (!hit) return null;
  const until = new Date(hit[1]);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return null;
  return until;
}

export type GmailSendInput = {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments: MimeAttachment[];
  lotIds?: number[];
  domain?: string;
};

export type GmailSendResult = { ok: true; id: string } | { ok: false; error: string };

export type GmailInboxMessage = {
  providerMessageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  bounced: boolean;
  failedRecipient?: string;
};

export type GmailInboxPage = { messages: GmailInboxMessage[]; historyId: string | null };

export type GmailClient = {
  profile: () => Promise<{ emailAddress?: string } | null>;
  send: (input: GmailSendInput) => Promise<GmailSendResult>;
  listInbox: (historyId: string | null) => Promise<GmailInboxPage>;
  listLegacyInbox?: (historyId: string | null) => Promise<GmailInboxPage>;
};

let injected: GmailClient | null = null;

export function setGmailClient(client: GmailClient | null): void {
  injected = client;
}

export { AUTHORIZED_SENDER };

export function gmailConfigured(): boolean {
  return injected != null || (oauthClientConfigured() && tokensPresent());
}

export function gmailInboxConfigured(): boolean {
  return injected != null || (oauthClientConfigured() && (tokensPresent() || legacyTokensPresent()));
}

type GmailFetch = (path: string, init?: RequestInit, retry?: boolean) => Promise<Response>;

function makeGmailFetch(
  getAccess: () => Promise<string | null>,
  invalidate: () => void,
): GmailFetch {
  const fetchFn: GmailFetch = async (path, init, retry = true) => {
    const access = await getAccess();
    if (!access) throw new Error("Gmail not connected");
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${access}` },
    });
    if (r.status === 401 && retry) {
      invalidate();
      return fetchFn(path, init, false);
    }
    return r;
  };
  return fetchFn;
}

const gmailFetch = makeGmailFetch(refreshAccess, () => {
  const stored = loadTokens();
  if (stored) saveTokens({ ...stored, access_token: "", expiry: new Date(0).toISOString() });
});

const gmailFetchLegacy = makeGmailFetch(refreshLegacyAccess, () => {
  const stored = loadLegacyTokens();
  if (stored) saveLegacyTokens({ ...stored, access_token: "", expiry: new Date(0).toISOString() });
});

const liveClient: GmailClient = {
  async profile() {
    const r = await gmailFetch("profile");
    if (!r.ok) return null;
    return r.json() as Promise<{ emailAddress?: string }>;
  },
  async send(input) {
    const gate = assertLiveOutbound({ to: input.to, domain: input.domain, lotIds: input.lotIds });
    if (!gate.ok) return { ok: false, error: gate.reason };
    const raw = buildRawMessage({
      from: AUTHORIZED_SENDER,
      to: input.to,
      subject: input.subject,
      body: input.body,
      html: input.html,
      attachments: input.attachments,
    });
    const r = await gmailFetch("messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) return { ok: false, error: `gmail send ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const j = await r.json() as { id: string };
    return { ok: true, id: j.id };
  },
  async listInbox(historyId) {
    return listInboxWith(gmailFetch, historyId);
  },
};

async function listInboxWith(fetchFn: GmailFetch, historyId: string | null): Promise<GmailInboxPage> {
  const q = historyId
    ? `history?startHistoryId=${historyId}&historyTypes=messageAdded`
    : "messages?maxResults=25&q=" + encodeURIComponent("in:inbox newer_than:2d");
  const r = await fetchFn(q);
  if (r.status === 404 && historyId) return listInboxWith(fetchFn, null);
  if (!r.ok) throw new Error(`gmail list ${r.status}`);
  const j = await r.json() as {
    historyId?: string;
    history?: { messagesAdded?: { message: { id: string } }[] }[];
    messages?: { id: string }[];
  };
  const ids = historyId
    ? (j.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id))
    : (j.messages ?? []).map((m) => m.id);
  const messages: GmailInboxMessage[] = [];
  for (const id of ids.slice(0, 40)) {
    const parsed = await readGmailMessage(id, fetchFn);
    if (parsed) messages.push(parsed);
  }
  return { messages, historyId: j.historyId ?? historyId };
}

async function readGmailMessage(id: string, fetchFn: GmailFetch = gmailFetch): Promise<GmailInboxMessage | null> {
  const mr = await fetchFn(`messages/${id}?format=full`);
  if (!mr.ok) return null;
  const m = await mr.json() as {
    id: string;
    labelIds?: string[];
    payload?: {
      headers?: { name: string; value: string }[];
      mimeType?: string;
      body?: { data?: string };
      parts?: Array<{ mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: unknown[] }>;
    };
  };
  if ((m.labelIds ?? []).includes("SENT")) return null;
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const text = extractPlain(m.payload);
  const from = h("From");
  const flags = inboxBounceFlags({
    text,
    from,
    subject: h("Subject"),
    failedHeader: h("X-Failed-Recipients"),
  });
  if (!flags.bounced && isOurMailbox(parseFromHeader(from))) return null;
  return {
    providerMessageId: m.id,
    from,
    to: h("To"),
    subject: h("Subject"),
    text,
    bounced: flags.bounced,
    failedRecipient: flags.failedRecipient,
  };
}

async function searchBounceMessages(fetchFn: GmailFetch): Promise<GmailInboxMessage[]> {
  const q = encodeURIComponent('from:(mailer-daemon OR postmaster) OR subject:(undeliverable OR "Delivery Status Notification" OR "Address not found")');
  const r = await fetchFn(`messages?maxResults=100&q=${q}`);
  if (!r.ok) throw new Error(`gmail bounce search ${r.status}`);
  const j = await r.json() as { messages?: { id: string }[] };
  const out: GmailInboxMessage[] = [];
  for (const row of (j.messages ?? []).slice(0, 50)) {
    const parsed = await readGmailMessage(row.id, fetchFn);
    if (parsed?.bounced) out.push(parsed);
  }
  return out;
}

/** One-shot DSN pull. Ignores historyId so existing bounce mail is applied. */
export async function fetchRecentBounceMessages(): Promise<GmailInboxMessage[]> {
  if (injected) return [];
  if (!oauthClientConfigured()) return [];
  const out: GmailInboxMessage[] = [];
  const seen = new Set<string>();
  if (tokensPresent()) {
    for (const m of await searchBounceMessages(gmailFetch)) {
      if (!seen.has(m.providerMessageId)) {
        seen.add(m.providerMessageId);
        out.push(m);
      }
    }
  }
  if (legacyTokensPresent()) {
    for (const m of await searchBounceMessages(gmailFetchLegacy)) {
      if (!seen.has(m.providerMessageId)) {
        seen.add(m.providerMessageId);
        out.push(m);
      }
    }
  }
  return out;
}

/** Read-only Saefam inbox. Never used by send. */
export async function listLegacyInbox(historyId: string | null): Promise<GmailInboxPage> {
  if (injected?.listLegacyInbox) return injected.listLegacyInbox(historyId);
  if (injected || !oauthClientConfigured() || !legacyTokensPresent()) {
    return { messages: [], historyId };
  }
  return listInboxWith(gmailFetchLegacy, historyId);
}

function extractPlain(payload: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> } | undefined): string {
  if (!payload) return "";
  const dec = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  let text = "";
  const walk = (p?: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) => {
    if (!p) return;
    if (p.body?.data && (p.mimeType === "text/plain" || p.mimeType === "message/delivery-status" || p.mimeType === "text/rfc822-headers")) {
      const chunk = dec(p.body.data);
      text = text ? `${text}\n${chunk}` : chunk;
    }
    for (const c of (p.parts ?? []) as Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }>) walk(c);
  };
  walk(payload);
  return text;
}

export function getGmailClient(): GmailClient {
  const inner = injected ?? liveClient;
  return {
    profile: () => inner.profile(),
    listInbox: (historyId) => inner.listInbox(historyId),
    listLegacyInbox: inner.listLegacyInbox
      ? (historyId) => inner.listLegacyInbox!(historyId)
      : (historyId) => listLegacyInbox(historyId),
    async send(input) {
      const gate = assertLiveOutbound({ to: input.to, domain: input.domain, lotIds: input.lotIds });
      if (!gate.ok) return { ok: false, error: gate.reason };
      return inner.send(input);
    },
  };
}

export async function assertGmailIdentity(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const from = assertAuthorizedSender(AUTHORIZED_SENDER);
  if (!from.ok) return from;
  if (injected) {
    const profile = await injected.profile();
    const actual = profile?.emailAddress?.trim().toLowerCase();
    if (actual !== AUTHORIZED_SENDER) return { ok: false, reason: `authenticated Gmail identity ${actual ?? "unknown"} is not authorized` };
    return { ok: true };
  }
  if (!gmailConfigured()) return { ok: false, reason: "Gmail OAuth tokens not configured" };
  const stored = loadTokens();
  if (!stored || stored.address !== AUTHORIZED_SENDER) return { ok: false, reason: "stored Gmail identity is not authorized" };
  const profile = await liveClient.profile();
  const actual = profile?.emailAddress?.trim().toLowerCase();
  if (actual !== AUTHORIZED_SENDER) return { ok: false, reason: `authenticated Gmail identity ${actual ?? "unknown"} is not authorized` };
  return { ok: true };
}

export async function sendAuthorizedEmail(input: GmailSendInput): Promise<GmailSendResult> {
  const cooldown = gmailSendCooldownUntil();
  if (cooldown) return { ok: false, error: `gmail 429 cooldown until ${cooldown.toISOString()}` };
  const identity = await assertGmailIdentity();
  if (!identity.ok) return { ok: false, error: identity.reason };
  return getGmailClient().send(input);
}
