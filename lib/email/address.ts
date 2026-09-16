export const AUTHORIZED_SENDERS = [
  "saevitzonoverstock@gmail.com",
  "saefamoverstock@gmail.com",
] as const;

export type AuthorizedSender = (typeof AUTHORIZED_SENDERS)[number];

/** Default / published contact. Pool members are AUTHORIZED_SENDERS. */
export const AUTHORIZED_SENDER: AuthorizedSender = AUTHORIZED_SENDERS[0];
export const PREVIOUS_SENDER: AuthorizedSender = AUTHORIZED_SENDERS[1];
export const DENIED_SENDER = "bailey@berkeley.edu";

const OUR_MAILBOXES = new Set<string>(AUTHORIZED_SENDERS);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function isAuthorizedSender(address: string): address is AuthorizedSender {
  return OUR_MAILBOXES.has(address.trim().toLowerCase());
}

export function isOurMailbox(address: string): boolean {
  return OUR_MAILBOXES.has(address.trim().toLowerCase());
}

export function isDeniedSender(address: string): boolean {
  const v = address.trim().toLowerCase();
  return v === DENIED_SENDER || v.endsWith("@berkeley.edu");
}

export function parseRecipient(raw: string): { ok: true; email: string } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty recipient" };
  if (/https?:\/\//i.test(text)) return { ok: false, reason: "recipient handle contains a URL" };
  if (/[;|]/.test(text)) return { ok: false, reason: "recipient handle is a blob" };
  const matches = text.match(EMAIL_RE) ?? [];
  const unique = [...new Set(matches.map((e) => e.toLowerCase()))];
  if (unique.length === 0) return { ok: false, reason: "no email address in handle" };
  if (unique.length > 1) return { ok: false, reason: "multiple emails in handle" };
  const email = unique[0];
  const leftover = text.replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  if ((leftover.match(/\d/g) ?? []).length >= 7) return { ok: false, reason: "recipient handle contains a phone number" };
  if (isDeniedSender(email)) return { ok: false, reason: "denied mailbox" };
  if (isOurMailbox(email)) return { ok: false, reason: "cannot send to our own mailbox as a buyer" };
  return { ok: true, email };
}

/** Pull the single evidenced mailbox out of research notes. Never guesses when two addresses are present. */
export function extractBuyerEmail(raw: string): { ok: true; email: string } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty recipient" };
  const matches = text.match(EMAIL_RE) ?? [];
  const unique = [...new Set(matches.map((e) => e.toLowerCase()))];
  if (unique.length === 0) return { ok: false, reason: "no email address in handle" };
  if (unique.length > 1) return { ok: false, reason: "multiple emails in handle" };
  const email = unique[0];
  if (isDeniedSender(email)) return { ok: false, reason: "denied mailbox" };
  if (isOurMailbox(email)) return { ok: false, reason: "cannot send to our own mailbox as a buyer" };
  return { ok: true, email };
}

export function parseFromHeader(raw: string): string {
  const parsed = parseRecipient(raw);
  return parsed.ok ? parsed.email : raw.trim().toLowerCase();
}

export function assertAuthorizedSender(address: string): { ok: true } | { ok: false; reason: string } {
  const v = address.trim().toLowerCase();
  if (isDeniedSender(v)) return { ok: false, reason: `${address} is banned from automation` };
  if (!isAuthorizedSender(v)) return { ok: false, reason: `From must be an authorized business sender` };
  return { ok: true };
}
