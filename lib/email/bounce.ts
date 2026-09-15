import { extractBuyerEmail, isOurMailbox } from "./address";

const IGNORE = /mailer-daemon|postmaster@|noreply@google/i;
const LABELED = /(?:final-recipient|original-recipient|x-failed-recipients|failed[- ]recipients?)\s*:\s*(?:rfc822;\s*)?<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i;
const PHRASE = /(?:wasn'?t delivered to|not delivered to|could(?: not|n'?t) be delivered to|address not found(?: for)?:?|unknown user:?|user unknown:?|recipient rejected:?|no such user:?|mailbox (?:not found|unavailable):?)\s*<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?/i;

function usable(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e || IGNORE.test(e) || isOurMailbox(e)) return null;
  const parsed = extractBuyerEmail(e);
  return parsed.ok ? parsed.email : null;
}

/** Best-effort failed recipient from a DSN header and/or body. Never returns our mailbox. */
export function extractFailedRecipient(text: string, headerOrFrom?: string): string | null {
  const fromHeader = usable(headerOrFrom ?? "");
  if (fromHeader && !IGNORE.test(headerOrFrom ?? "")) return fromHeader;
  const blob = text ?? "";
  const labeled = blob.match(LABELED);
  if (labeled) return usable(labeled[1]);
  const phrase = blob.match(PHRASE);
  if (phrase) return usable(phrase[1]);
  const mailto = blob.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\s*<mailto:/i);
  if (mailto) return usable(mailto[1]);
  const all = blob.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  for (const e of all) {
    const u = usable(e);
    if (u) return u;
  }
  return null;
}

/** Gmail rejected OUR send (quota), not the buyer inbox. Never treat as a recipient bounce. */
export function looksLikeSenderLimit(text: string, subject?: string): boolean {
  const t = `${subject ?? ""} ${text ?? ""}`.toLowerCase();
  if (/address not found|user unknown|unknown user|mailbox (not found|unavailable)|550\s*5\.1\./.test(t)) return false;
  return /reached a limit for sending mail/.test(t)
    || /you have reached a limit for sending/.test(t)
    || /your message was not sent/.test(t);
}

export function looksLikeHardBounce(text: string, from?: string, subject?: string): boolean {
  if (looksLikeSenderLimit(text, subject)) return false;
  const t = `${from ?? ""} ${subject ?? ""} ${text ?? ""}`.toLowerCase();
  return /delivery status notification|undeliverable|delivery (failure|failed)|returned to sender/.test(t)
    || /address not found|user unknown|unknown user|recipient rejected|mailbox (not found|unavailable)|no such user|message blocked/.test(t)
    || /\b550\b|\b5\.1\.\d\b|\b5\.4\.1\b|\b5\.2\.\d\b/.test(t);
}

/**
 * A normal buyer reply is not a bounce just because the thread contains an email.
 * Only an X-Failed-Recipients header or DSN language may mark a message bounced.
 */
export function inboxBounceFlags(input: {
  text: string;
  from?: string;
  subject?: string;
  failedHeader?: string;
}): { bounced: boolean; failedRecipient?: string } {
  if (looksLikeSenderLimit(input.text, input.subject)) {
    return { bounced: false };
  }
  const header = (input.failedHeader ?? "").trim();
  const fromHeader = header ? extractFailedRecipient("", header) : null;
  if (!fromHeader && !looksLikeHardBounce(input.text, input.from, input.subject)) {
    return { bounced: false };
  }
  return {
    bounced: true,
    failedRecipient: fromHeader || extractFailedRecipient(input.text, input.from) || undefined,
  };
}
