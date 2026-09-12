import { assertLiveOutbound } from "../outbound-gate";
import { AUTHORIZED_SENDER, assertAuthorizedSender, parseFromHeader } from "./address";
import { buildRawMessage, type MimeAttachment } from "./mime";
import { loadTokens, oauthClientConfigured, refreshAccess, saveTokens, tokensPresent } from "./tokens";

export type GmailSendInput = {
  to: string;
  subject: string;
  body: string;
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

export type GmailClient = {
  profile: () => Promise<{ emailAddress?: string } | null>;
  send: (input: GmailSendInput) => Promise<GmailSendResult>;
  listInbox: (historyId: string | null) => Promise<{ messages: GmailInboxMessage[]; historyId: string | null }>;
};

let injected: GmailClient | null = null;

export function setGmailClient(client: GmailClient | null): void {
  injected = client;
}

export { AUTHORIZED_SENDER };

export function gmailConfigured(): boolean {
  return injected != null || (oauthClientConfigured() && tokensPresent());
}

async function gmailFetch(path: string, init?: RequestInit, retry = true): Promise<Response> {
  const access = await refreshAccess();
  if (!access) throw new Error("Gmail not connected");
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${access}` },
  });
  if (r.status === 401 && retry) {
    const stored = loadTokens();
    if (stored) {
      saveTokens({ ...stored, access_token: "", expiry: new Date(0).toISOString() });
      return gmailFetch(path, init, false);
    }
  }
  return r;
}

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
    const q = historyId
      ? `history?startHistoryId=${historyId}&historyTypes=messageAdded`
      : "messages?maxResults=25&q=" + encodeURIComponent("in:inbox newer_than:2d");
    const r = await gmailFetch(q);
    if (r.status === 404 && historyId) return liveClient.listInbox(null);
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
      const mr = await gmailFetch(`messages/${id}?format=full`);
      if (!mr.ok) continue;
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
      if ((m.labelIds ?? []).includes("SENT")) continue;
      const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
      const text = extractPlain(m.payload);
      const from = h("From");
      const failedRecipient = h("X-Failed-Recipients").split(",")[0]?.trim() || undefined;
      const bounced = /mailer-daemon|postmaster@/i.test(from) || Boolean(failedRecipient) || /delivery status notification|undeliverable/i.test(h("Subject"));
      if (!bounced && parseFromHeader(from) === AUTHORIZED_SENDER) continue;
      messages.push({
        providerMessageId: m.id,
        from,
        to: h("To"),
        subject: h("Subject"),
        text,
        bounced,
        failedRecipient,
      });
    }
    return { messages, historyId: j.historyId ?? historyId };
  },
};

function extractPlain(payload: { mimeType?: string; body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> } | undefined): string {
  if (!payload) return "";
  const dec = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
  let text = "";
  const walk = (p?: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) => {
    if (!p) return;
    if (p.body?.data && p.mimeType === "text/plain" && !text) text = dec(p.body.data);
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
  const identity = await assertGmailIdentity();
  if (!identity.ok) return { ok: false, error: identity.reason };
  return getGmailClient().send(input);
}
