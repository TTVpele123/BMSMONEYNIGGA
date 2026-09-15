import { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSentToday, liveSentToDomainToday } from "./caps";
import { parseRecipient } from "./email/address";
import { selectSendableLots } from "./email/attachments";
import { composePlain, composeRichHtml } from "./email/template";
import { sendAuthorizedEmail } from "./email/provider";
import type { ChannelResult } from "./channels/types";
import { audit, db, killSwitchOn, outboundMode } from "./db";
import { assertEligible, recordSend, reserveQueued } from "./ledger";
import { recordOutcome } from "./learning";
import { isCapacityReason } from "./repairs";
import { recordQualityOutcome, sourceForEmail } from "./targeting";

export { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSendCapacity, liveSentToday, liveSentToDomainToday } from "./caps";

export function composeMessage(input: {
  company: string;
  lots: { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }[];
}): { subject: string; body: string; html?: string } {
  const plain = composePlain(input);
  return { subject: plain.subject, body: plain.body };
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
  composed?: { subject?: string; body: string; html?: string };
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
  if (existing?.status === "blocked" && !isCapacityReason(existing.reason)) {
    return { ok: false, status: "duplicate", reason: `already ${existing.status}`, attemptId: existing.id };
  }

  const persistCapacity = (
    reason: string,
    mediaHashes: string[],
    lotIds: number[],
    row: { id: number; status: string } | undefined,
  ): ChannelResult => {
    if (row?.status === "dry_run") {
      return { ok: false, status: "deferred", reason, attemptId: row.id };
    }
    if (row) {
      db().prepare(
        `UPDATE outreach_attempts SET status='failed', reason=?, media_hashes=?, lot_ids=? WHERE id=?`
      ).run(reason, JSON.stringify(mediaHashes), JSON.stringify(lotIds), row.id);
      audit("outreach", "attempt_deferred_cap", { entityType: "outreach_attempts", entityId: row.id, ok: false, detail: { reason } });
      return { ok: false, status: "deferred", reason, attemptId: row.id };
    }
    const info = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,?,?,?,?,'failed',?,?)`
    ).run(
      input.conversationId, input.buyerId, input.channel, JSON.stringify(lotIds),
      "", "", JSON.stringify(mediaHashes), reason, input.idempotencyKey,
    );
    const id = Number(info.lastInsertRowid);
    audit("outreach", "attempt_deferred_cap", { entityType: "outreach_attempts", entityId: id, ok: false, detail: { reason } });
    return { ok: false, status: "deferred", reason, attemptId: id };
  };

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
        `UPDATE outreach_attempts SET status=?, reason=?, media_hashes=?, body=?, subject=?, lot_ids=?, provider_message_id=COALESCE(?, provider_message_id), created_at=CASE WHEN ?='sent' THEN datetime('now') ELSE created_at END
         WHERE id=?`
      ).run(status, reason, JSON.stringify(mediaHashes), body, subject, JSON.stringify(lotIds), providerMessageId ?? null, status, existing.id);
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
    if (LIVE_DAILY_CAP != null && liveSentToday() >= LIVE_DAILY_CAP) {
      return persistCapacity(`daily cap ${LIVE_DAILY_CAP}`, media.pick.hashes, lots.map((l) => l.id), existing);
    }
    if (liveSentToDomainToday(input.domain) >= LIVE_DOMAIN_CAP) {
      return persistCapacity(`domain cap ${LIVE_DOMAIN_CAP}`, media.pick.hashes, lots.map((l) => l.id), existing);
    }
  }

  const rich = composeRichHtml({
    company: input.company,
    lots,
    attachments: media.pick.attachments,
  });
  const subject = rich.subject;
  const body = rich.text;
  const html = rich.html;
  for (const lot of lots) reserveQueued(to.email, lot.id, input.buyerId);

  if (mode === "dry_run") {
    return persist("dry_run", "dry_run — not sent", media.pick.hashes, body, subject, lots.map((l) => l.id));
  }

  const sent = await sendAuthorizedEmail({
    to: to.email,
    subject,
    body,
    html,
    attachments: media.pick.attachments,
    lotIds: lots.map((l) => l.id),
    domain: input.domain,
  });
  if (!sent.ok) {
    return persist("failed", sent.error, media.pick.hashes, body, subject, lots.map((l) => l.id));
  }
  const result = persist("sent", "provider accepted", media.pick.hashes, body, subject, lots.map((l) => l.id), sent.id);
  for (const lot of lots) recordSend(to.email, lot.id, input.buyerId);
  recordOutcome(input.buyerId, "send");
  recordQualityOutcome(to.email, "delivered", { source: sourceForEmail(to.email) });
  return result;
}
