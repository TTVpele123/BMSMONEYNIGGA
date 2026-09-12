import { parseRecipient } from "./email/address";
import { selectSendableLots } from "./email/attachments";
import { sendAuthorizedEmail } from "./email/provider";
import type { ChannelResult } from "./channels/types";
import { audit, db, killSwitchOn, outboundMode } from "./db";
import { assertEligible, recordSend, reserveQueued } from "./ledger";

const DAILY_CAP = 20;
const DOMAIN_CAP = 2;

export function composeMessage(input: {
  company: string;
  lots: { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }[];
}): { subject: string; body: string } {
  const titles = input.lots.map((l) => l.title).join(" / ");
  const subject = `Wholesale availability — ${titles}`.slice(0, 140);
  const lines = [
    `Hi ${input.company} team,`,
    "",
    "We have current closeout inventory that looks like a fit based on what you buy. Details from the supplier (not estimates):",
    "",
    ...input.lots.map((l) => {
      const qty = l.quantity != null ? `${l.quantity} units` : "qty on request";
      const price = l.unit_price != null ? `$${l.unit_price}/unit` : "price on request";
      const brand = l.brand ? ` · ${l.brand}` : "";
      return `• ${l.title}${brand} — ${l.category} — ${qty} — ${price}`;
    }),
    "",
    "Photos attached are the supplier's original lot photos — not stock imagery.",
    "",
    "If this is relevant, reply with the quantity and any constraints (sizes, price, timing). If not a fit, a one-line pass is enough and we will not follow up on this lot.",
    "",
    "Bailey Saevitzon",
    "Saefam Overstock",
    "818-406-8612",
    "saevitzonoverstock@gmail.com",
  ];
  return { subject, body: lines.join("\n") };
}

function liveSentToday(): number {
  const row = db().prepare(
    "SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent' AND created_at >= datetime('now','-1 day')"
  ).get() as { n: number };
  return row.n;
}

function liveSentToDomainToday(domain: string): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM outreach_attempts oa
     JOIN buyers b ON b.id=oa.buyer_id
     WHERE b.domain=? AND oa.status='sent' AND oa.created_at >= datetime('now','-1 day')`
  ).get(domain) as { n: number };
  return row.n;
}

export async function guardedOutreach(input: {
  conversationId: number;
  buyerId: number;
  email: string;
  domain: string;
  company: string;
  lots: { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }[];
  channel: string;
  idempotencyKey: string;
  composed?: { subject?: string; body: string };
}): Promise<ChannelResult> {
  const existing = db().prepare("SELECT id, status, reason FROM outreach_attempts WHERE idempotency_key=?").get(input.idempotencyKey) as
    | { id: number; status: string; reason: string } | undefined;
  const mode = outboundMode();

  if (existing?.status === "sent") {
    return { ok: true, status: "duplicate", reason: "already sent", attemptId: existing.id };
  }
  if (existing?.status === "dry_run" && mode === "dry_run") {
    return { ok: true, status: "duplicate", reason: "already dry_run", attemptId: existing.id };
  }
  if (existing?.status === "blocked") {
    return { ok: false, status: "duplicate", reason: `already ${existing.status}`, attemptId: existing.id };
  }

  const persist = (
    status: "dry_run" | "sent" | "blocked" | "failed",
    reason: string,
    mediaHashes: string[],
    body: string,
    subject: string,
    lotIds: number[],
    providerMessageId?: string,
  ): ChannelResult => {
    if (existing?.status === "dry_run" && status !== "sent") {
      return { ok: false, status, reason, attemptId: existing.id };
    }
    if (existing) {
      db().prepare(
        `UPDATE outreach_attempts SET status=?, reason=?, media_hashes=?, body=?, subject=?, lot_ids=?, provider_message_id=COALESCE(?, provider_message_id)
         WHERE id=?`
      ).run(status, reason, JSON.stringify(mediaHashes), body, subject, JSON.stringify(lotIds), providerMessageId ?? null, existing.id);
      audit("outreach", `attempt_${status}`, {
        entityType: "outreach_attempts",
        entityId: existing.id,
        ok: status !== "blocked" && status !== "failed",
        detail: { reason, promoted: existing.status === "dry_run" },
      });
      return { ok: status === "dry_run" || status === "sent", status, reason, attemptId: existing.id };
    }
    const info = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      input.conversationId, input.buyerId, input.channel, JSON.stringify(lotIds),
      subject, body, JSON.stringify(mediaHashes), status, reason, input.idempotencyKey, providerMessageId ?? null,
    );
    const id = Number(info.lastInsertRowid);
    audit("outreach", `attempt_${status}`, { entityType: "outreach_attempts", entityId: id, ok: status !== "blocked" && status !== "failed", detail: { reason } });
    return { ok: status === "dry_run" || status === "sent", status, reason, attemptId: id };
  };

  const to = parseRecipient(input.email);
  if (!to.ok) return persist("blocked", to.reason, [], "", "", input.lots.map((l) => l.id));
  if (killSwitchOn()) return persist("blocked", "kill switch", [], "", "", input.lots.map((l) => l.id));
  if (input.lots.length < 1 || input.lots.length > 3) return persist("blocked", "must attach 1-3 lots", [], "", "", input.lots.map((l) => l.id));

  const media = selectSendableLots(input.lots);
  if (!media.ok) return persist("blocked", media.reason, [], "", "", input.lots.map((l) => l.id));
  const lots = media.pick.lots;

  for (const lot of lots) {
    const gate = assertEligible(to.email, lot.id);
    if (!gate.eligible) return persist("blocked", gate.reason, [], "", "", lots.map((l) => l.id));
  }

  if (mode === "live") {
    if (liveSentToday() >= DAILY_CAP) return persist("blocked", `daily cap ${DAILY_CAP}`, media.pick.hashes, "", "", lots.map((l) => l.id));
    if (liveSentToDomainToday(input.domain) >= DOMAIN_CAP) return persist("blocked", `domain cap ${DOMAIN_CAP}`, media.pick.hashes, "", "", lots.map((l) => l.id));
  }

  const composed = input.composed && media.pick.lots.length === input.lots.length
    ? input.composed
    : composeMessage({ company: input.company, lots });
  const subject = composed.subject ?? "";
  const body = composed.body;
  for (const lot of lots) reserveQueued(to.email, lot.id, input.buyerId);

  if (mode === "dry_run") {
    return persist("dry_run", "dry_run — not sent", media.pick.hashes, body, subject, lots.map((l) => l.id));
  }

  const sent = await sendAuthorizedEmail({
    to: to.email,
    subject,
    body,
    attachments: media.pick.attachments,
  });
  if (!sent.ok) {
    return persist("failed", sent.error, media.pick.hashes, body, subject, lots.map((l) => l.id));
  }
  const result = persist("sent", "provider accepted", media.pick.hashes, body, subject, lots.map((l) => l.id), sent.id);
  for (const lot of lots) recordSend(to.email, lot.id, input.buyerId);
  return result;
}
