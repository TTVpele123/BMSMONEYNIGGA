import type { ChannelResult } from "./channels/types";
import { audit, db, killSwitchOn, outboundMode } from "./db";
import { assertEligible, recordSend, reserveQueued } from "./ledger";
import { selectOutreachMedia } from "./media";
import { isSuppressed } from "./suppression";

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

function sentToday(): number {
  const row = db().prepare(
    "SELECT COUNT(*) AS n FROM outreach_attempts WHERE status IN ('sent','dry_run') AND created_at >= datetime('now','-1 day')"
  ).get() as { n: number };
  return row.n;
}

function sentToDomainToday(domain: string): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM outreach_attempts oa
     JOIN buyers b ON b.id=oa.buyer_id
     WHERE b.domain=? AND oa.status IN ('sent','dry_run') AND oa.created_at >= datetime('now','-1 day')`
  ).get(domain) as { n: number };
  return row.n;
}

export function guardedOutreach(input: {
  conversationId: number;
  buyerId: number;
  email: string;
  domain: string;
  company: string;
  lots: { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }[];
  channel: string;
  idempotencyKey: string;
  composed?: { subject?: string; body: string };
}): ChannelResult {
  const existing = db().prepare("SELECT id, status, reason FROM outreach_attempts WHERE idempotency_key=?").get(input.idempotencyKey) as
    | { id: number; status: string; reason: string } | undefined;
  if (existing) return { ok: existing.status !== "failed" && existing.status !== "blocked", status: "duplicate", reason: `already ${existing.status}`, attemptId: existing.id };

  const logAttempt = (status: "logged" | "dry_run" | "sent" | "blocked" | "failed", reason: string, mediaHashes: string[], body: string, subject: string) => {
    const info = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(
      input.conversationId, input.buyerId, input.channel, JSON.stringify(input.lots.map((l) => l.id)),
      subject, body, JSON.stringify(mediaHashes), status, reason, input.idempotencyKey,
    );
    audit("outreach", `attempt_${status}`, { entityType: "outreach_attempts", entityId: Number(info.lastInsertRowid), ok: status !== "blocked" && status !== "failed", detail: { reason } });
    return Number(info.lastInsertRowid);
  };

  if (killSwitchOn()) {
    const id = logAttempt("blocked", "kill switch", [], "", "");
    return { ok: false, status: "blocked", reason: "kill switch", attemptId: id };
  }
  const sup = isSuppressed(input.email);
  if (sup.suppressed) {
    const id = logAttempt("blocked", `suppressed ${sup.matched}`, [], "", "");
    return { ok: false, status: "blocked", reason: `suppressed (${sup.matched})`, attemptId: id };
  }
  if (input.lots.length < 1 || input.lots.length > 3) {
    const id = logAttempt("blocked", "lot cap 1-3", [], "", "");
    return { ok: false, status: "blocked", reason: "must attach 1-3 lots", attemptId: id };
  }
  if (sentToday() >= DAILY_CAP) {
    const id = logAttempt("blocked", "daily cap", [], "", "");
    return { ok: false, status: "blocked", reason: `daily cap ${DAILY_CAP}`, attemptId: id };
  }
  if (sentToDomainToday(input.domain) >= DOMAIN_CAP) {
    const id = logAttempt("blocked", "domain cap", [], "", "");
    return { ok: false, status: "blocked", reason: `domain cap ${DOMAIN_CAP}`, attemptId: id };
  }

  const mediaHashes: string[] = [];
  for (const lot of input.lots) {
    const gate = assertEligible(input.email, lot.id);
    if (!gate.eligible) {
      const id = logAttempt("blocked", gate.reason, [], "", "");
      return { ok: false, status: "blocked", reason: gate.reason, attemptId: id };
    }
    const media = db().prepare(
      "SELECT lot_id, sha256, path, classification, outreach_safe, association_certain FROM lot_media WHERE lot_id=?"
    ).all(lot.id) as { lot_id: number; sha256: string; path: string; classification: string; outreach_safe: number; association_certain: number }[];
    const safe = selectOutreachMedia(media.map((m) => ({ ...m, lot_id: m.lot_id })), lot.id);
    const certain = safe.filter((m) => media.find((x) => x.sha256 === m.sha256)?.association_certain === 1);
    if (certain.length === 0) {
      const id = logAttempt("blocked", `no verified Oliver media for lot ${lot.id}`, [], "", "");
      return { ok: false, status: "blocked", reason: `no verified Oliver media for lot ${lot.id}`, attemptId: id };
    }
    for (const m of certain) {
      if (m.classification === "screenshot_chat_capture") {
        const id = logAttempt("blocked", "chat screenshot rejected", [], "", "");
        return { ok: false, status: "blocked", reason: "WhatsApp screenshots cannot be sent", attemptId: id };
      }
      mediaHashes.push(m.sha256);
    }
  }

  const composed = input.composed ?? composeMessage({ company: input.company, lots: input.lots });
  const subject = composed.subject ?? "";
  const body = composed.body;
  for (const lot of input.lots) reserveQueued(input.email, lot.id, input.buyerId);

  const mode = outboundMode();
  if (mode === "dry_run") {
    const id = logAttempt("dry_run", "dry_run — not sent", mediaHashes, body, subject);
    return { ok: true, status: "dry_run", reason: "dry_run", attemptId: id };
  }

  // Live send is a provider boundary. Without a connected mailbox this is a failure, not a silent success.
  const id = logAttempt("failed", "live mode requires connected Gmail provider", mediaHashes, body, subject);
  return { ok: false, status: "failed", reason: "live mode requires connected Gmail provider — tokens not configured", attemptId: id };
}

export function markLiveSent(attemptId: number, email: string, lotIds: number[], buyerId: number, providerMessageId: string): void {
  db().prepare("UPDATE outreach_attempts SET status='sent', provider_message_id=?, reason='provider accepted' WHERE id=?").run(providerMessageId, attemptId);
  for (const lotId of lotIds) recordSend(email, lotId, buyerId);
}
