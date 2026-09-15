import { db, getSetting, setSetting } from "../db";
import { assertLiveOutbound } from "../outbound-gate";
import {
  AUTHORIZED_SENDER,
  AUTHORIZED_SENDERS,
  PREVIOUS_SENDER,
  assertAuthorizedSender,
  isAuthorizedSender,
  isOurMailbox,
  parseFromHeader,
  type AuthorizedSender,
} from "./address";
import { inboxBounceFlags } from "./bounce";
import { buildRawMessage, type MimeAttachment } from "./mime";
import {
  hasSendScope,
  legacyTokensPresent,
  loadLegacyTokens,
  loadSenderTokens,
  loadTokens,
  oauthClientConfigured,
  refreshAccess,
  refreshLegacyAccess,
  saveLegacyTokens,
  saveTokens,
  senderHasSendTokens,
  tokensPresent,
} from "./tokens";

const GMAIL_RETRY_AFTER = /Retry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;
const SENDER_IN_REASON = /sender=([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const COOLDOWN_MAP_KEY = "gmail_sender_cooldowns";
const LEGACY_LIMIT_KEY = "gmail_sender_limit_until";
const ACTIVE_SENDER_KEY = "active_sender";
const HARD_STOP = /account.?disabled|suspended|policy|abuse|unauthorized_client|access.?denied/i;

function laterCooldown(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function parseFuture(iso: string | undefined): Date | null {
  if (!iso) return null;
  const until = new Date(iso);
  if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return null;
  return until;
}

function readCooldownMap(): Record<string, string> {
  let map: Record<string, string> = {};
  try { map = JSON.parse(getSetting(COOLDOWN_MAP_KEY, "{}")); } catch { map = {}; }
  const legacy = getSetting(LEGACY_LIMIT_KEY, "");
  if (legacy && !map[AUTHORIZED_SENDER]) map[AUTHORIZED_SENDER] = legacy;
  return map;
}

function retryAfterFor(address: string): Date | null {
  const rows = db().prepare(
    `SELECT reason FROM outreach_attempts
      WHERE status='failed' AND reason LIKE '%Retry after%'
      ORDER BY id DESC LIMIT 8`,
  ).all() as Array<{ reason: string }>;
  let latest: Date | null = null;
  for (const row of rows) {
    const hit = row.reason.match(GMAIL_RETRY_AFTER);
    if (!hit) continue;
    const until = parseFuture(hit[1]);
    if (!until) continue;
    const tagged = row.reason.match(SENDER_IN_REASON)?.[1]?.toLowerCase();
    const applies = tagged ? tagged === address : address === AUTHORIZED_SENDER;
    if (applies) latest = laterCooldown(latest, until);
  }
  return latest;
}

export function senderCooldownUntil(address: string): Date | null {
  const v = address.trim().toLowerCase();
  return laterCooldown(parseFuture(readCooldownMap()[v]), retryAfterFor(v));
}

export type SenderPoolRow = {
  address: AuthorizedSender;
  connected: boolean;
  send: boolean;
  cooldownUntil: string | null;
  status: "available" | "cooling" | "inbox_only" | "disconnected";
};

export function senderPool(): SenderPoolRow[] {
  return AUTHORIZED_SENDERS.map((address) => {
    const tokens = loadSenderTokens(address);
    const connected = Boolean(tokens?.refresh_token);
    const send = senderHasSendTokens(address);
    const cooldown = senderCooldownUntil(address);
    let status: SenderPoolRow["status"] = "disconnected";
    if (send && cooldown) status = "cooling";
    else if (send) status = "available";
    else if (connected) status = "inbox_only";
    return {
      address,
      connected,
      send,
      cooldownUntil: cooldown?.toISOString() ?? null,
      status,
    };
  });
}

export function pickAvailableSender(injectedAddress?: string | null): AuthorizedSender | null {
  const hint = injectedAddress?.trim().toLowerCase();
  for (const address of AUTHORIZED_SENDERS) {
    if (senderCooldownUntil(address)) continue;
    if (hint) {
      if (address === hint && isAuthorizedSender(address)) return address;
      continue;
    }
    if (senderHasSendTokens(address)) return address;
  }
  return null;
}

/** Null if any authorized send-capable mailbox is free. Otherwise the soonest recovery instant. */
export function gmailSendCooldownUntil(): Date | null {
  const sendable = AUTHORIZED_SENDERS.filter((a) => senderHasSendTokens(a));
  if (sendable.some((a) => !senderCooldownUntil(a))) return null;
  if (sendable.length === 0) return senderCooldownUntil(AUTHORIZED_SENDER);
  let soonest: Date | null = null;
  for (const a of sendable) {
    const until = senderCooldownUntil(a);
    if (until && (!soonest || until.getTime() < soonest.getTime())) soonest = until;
  }
  return soonest;
}

/** Gmail told us this mailbox did not send. Pause that sender only. */
export function noteGmailSenderLimit(minutes = 45, address: string = AUTHORIZED_SENDER): Date {
  const v = address.trim().toLowerCase();
  const target = isAuthorizedSender(v) ? v : AUTHORIZED_SENDER;
  const existing = senderCooldownUntil(target);
  const next = new Date(Date.now() + minutes * 60_000);
  const until = existing && existing.getTime() > next.getTime() ? existing : next;
  const map = readCooldownMap();
  map[target] = until.toISOString();
  setSetting(COOLDOWN_MAP_KEY, JSON.stringify(map));
  if (target === AUTHORIZED_SENDER) setSetting(LEGACY_LIMIT_KEY, until.toISOString());
  return until;
}

export function activeSender(): AuthorizedSender {
  const stored = getSetting(ACTIVE_SENDER_KEY, "").trim().toLowerCase();
  if (isAuthorizedSender(stored)) return stored;
  return pickAvailableSender() ?? AUTHORIZED_SENDER;
}

function isCapacityLimitError(error: string): boolean {
  if (HARD_STOP.test(error)) return false;
  return /429|retry after|mail sending|sending limit|user-rate-limit|quota/i.test(error);
}

export type GmailSendInput = {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments: MimeAttachment[];
  lotIds?: number[];
  domain?: string;
  from?: string;
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
  return injected != null || (oauthClientConfigured() && AUTHORIZED_SENDERS.some((a) => senderHasSendTokens(a)));
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
    const from = (input.from ?? AUTHORIZED_SENDER).trim().toLowerCase();
    const allowed = assertAuthorizedSender(from);
    if (!allowed.ok) return { ok: false, error: allowed.reason };
    const gate = assertLiveOutbound({ to: input.to, domain: input.domain, lotIds: input.lotIds });
    if (!gate.ok) return { ok: false, error: gate.reason };
    const raw = buildRawMessage({
      from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      html: input.html,
      attachments: input.attachments,
    });
    const fetchFn = from === PREVIOUS_SENDER ? gmailFetchLegacy : gmailFetch;
    const r = await fetchFn("messages/send", {
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

function asHistoryId(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

async function profileHistoryId(fetchFn: GmailFetch): Promise<string | null> {
  const r = await fetchFn("profile");
  if (!r.ok) return null;
  const j = await r.json() as { historyId?: string | number };
  return asHistoryId(j.historyId);
}

async function listInboxWith(fetchFn: GmailFetch, historyId: string | null): Promise<GmailInboxPage> {
  const q = historyId
    ? `history?startHistoryId=${historyId}&historyTypes=messageAdded`
    : "messages?maxResults=50&q=" + encodeURIComponent("in:inbox newer_than:2d -from:mailer-daemon -from:postmaster");
  const r = await fetchFn(q);
  if (r.status === 404 && historyId) return listInboxWith(fetchFn, null);
  if (!r.ok) throw new Error(`gmail list ${r.status}`);
  const j = await r.json() as {
    historyId?: string | number;
    history?: { messagesAdded?: { message: { id: string } }[] }[];
    messages?: { id: string }[];
  };
  const ids = historyId
    ? (j.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message.id))
    : (j.messages ?? []).map((m) => m.id);
  const messages: GmailInboxMessage[] = [];
  for (const id of ids.slice(0, 50)) {
    const parsed = await readGmailMessage(id, fetchFn);
    if (parsed) messages.push(parsed);
  }
  const listed = asHistoryId(j.historyId) ?? historyId;
  return { messages, historyId: listed ?? await profileHistoryId(fetchFn) };
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

/** Saefam inbox (and send, when that mailbox has send scope). */
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

export async function assertGmailIdentity(sender: string = AUTHORIZED_SENDER): Promise<{ ok: true } | { ok: false; reason: string }> {
  const from = assertAuthorizedSender(sender);
  if (!from.ok) return from;
  const wanted = sender.trim().toLowerCase();
  if (injected) {
    const profile = await injected.profile();
    const actual = profile?.emailAddress?.trim().toLowerCase();
    if (!actual || !isAuthorizedSender(actual)) {
      return { ok: false, reason: `authenticated Gmail identity ${actual ?? "unknown"} is not authorized` };
    }
    if (actual !== wanted) return { ok: false, reason: `authenticated Gmail identity ${actual} is not ${wanted}` };
    return { ok: true };
  }
  if (!senderHasSendTokens(wanted) && !(wanted === AUTHORIZED_SENDER && tokensPresent() && hasSendScope(loadTokens()))) {
    return { ok: false, reason: `Gmail send tokens not configured for ${wanted}` };
  }
  const stored = loadSenderTokens(wanted);
  if (!stored || stored.address !== wanted) return { ok: false, reason: "stored Gmail identity is not authorized" };
  const fetchFn = wanted === PREVIOUS_SENDER ? gmailFetchLegacy : gmailFetch;
  const r = await fetchFn("profile");
  if (!r.ok) return { ok: false, reason: `Gmail profile ${r.status}` };
  const profile = await r.json() as { emailAddress?: string };
  const actual = profile.emailAddress?.trim().toLowerCase();
  if (actual !== wanted) return { ok: false, reason: `authenticated Gmail identity ${actual ?? "unknown"} is not authorized` };
  return { ok: true };
}

export async function sendAuthorizedEmail(input: GmailSendInput): Promise<GmailSendResult> {
  if (injected) {
    const profile = await injected.profile();
    const chosen = pickAvailableSender(profile?.emailAddress);
    if (!chosen) {
      const until = senderCooldownUntil(profile?.emailAddress ?? AUTHORIZED_SENDER) ?? gmailSendCooldownUntil();
      return { ok: false, error: until ? `gmail 429 cooldown until ${until.toISOString()}` : "no authorized sender with capacity" };
    }
    const identity = await assertGmailIdentity(chosen);
    if (!identity.ok) return { ok: false, error: identity.reason };
    return getGmailClient().send({ ...input, from: chosen });
  }

  const tried: string[] = [];
  let last: GmailSendResult = { ok: false, error: "no authorized sender with capacity" };
  for (const sender of AUTHORIZED_SENDERS) {
    if (senderCooldownUntil(sender) || !senderHasSendTokens(sender)) continue;
    tried.push(sender);
    const identity = await assertGmailIdentity(sender);
    if (!identity.ok) {
      last = { ok: false, error: identity.reason };
      continue;
    }
    const sent = await getGmailClient().send({ ...input, from: sender });
    if (sent.ok) {
      setSetting(ACTIVE_SENDER_KEY, sender);
      return sent;
    }
    last = sent;
    if (isCapacityLimitError(sent.error)) {
      noteGmailSenderLimit(45, sender);
      continue;
    }
    return sent;
  }
  const until = gmailSendCooldownUntil();
  if (until && /429|limit|cooldown|quota/i.test(last.error)) {
    return { ok: false, error: `gmail 429 cooldown until ${until.toISOString()}` };
  }
  return last;
}
