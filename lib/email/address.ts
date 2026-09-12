export const AUTHORIZED_SENDER = "saevitzonoverstock@gmail.com";
export const DENIED_SENDER = "saefamoverstock@gmail.com";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

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
  if (email === DENIED_SENDER) return { ok: false, reason: "denied mailbox" };
  if (email === AUTHORIZED_SENDER) return { ok: false, reason: "cannot send to our own mailbox as a buyer" };
  return { ok: true, email };
}

export function parseFromHeader(raw: string): string {
  const parsed = parseRecipient(raw);
  return parsed.ok ? parsed.email : raw.trim().toLowerCase();
}

export function assertAuthorizedSender(address: string): { ok: true } | { ok: false; reason: string } {
  const v = address.trim().toLowerCase();
  if (v === DENIED_SENDER) return { ok: false, reason: `${address} is banned from automation` };
  if (v !== AUTHORIZED_SENDER) return { ok: false, reason: `From must be ${AUTHORIZED_SENDER}` };
  return { ok: true };
}
