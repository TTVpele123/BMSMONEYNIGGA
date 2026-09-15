import { LIVE_DOMAIN_CAP, liveSentToDomainToday } from "./caps";
import { audit, db, outboundMode } from "./db";
import { lotHasSendableMedia } from "./email/attachments";
import { inferLotCategory, rankBuyersForLot } from "./matcher";
import { createOpportunity, dispatchOpportunity } from "./opportunity";
import { buyerHasPendingFormJob } from "./channels/form-exec";
import { hasOutreachPath, recordEndpoint, selectOutreachChannels } from "./channels/select";
import { extractBuyerEmail } from "./email/address";
import { buyerLotAlreadyTouched, untouchedLotIds } from "./ledger";
import { pauseLotsMissingOriginalMedia } from "./repairs";
import { isDeadInbox, suppressedDomainSet } from "./suppression";
import { applyBetterContact } from "./targeting";

function liveContactEmail(buyerId: number): string | null {
  const rows = db().prepare(
    "SELECT email, verification FROM buyer_contacts WHERE buyer_id=? AND email IS NOT NULL"
  ).all(buyerId) as Array<{ email: string; verification: string }>;
  for (const row of rows) {
    if (row.verification === "bounced") continue;
    const extracted = extractBuyerEmail(row.email);
    if (extracted.ok && !isDeadInbox(extracted.email)) return extracted.email;
  }
  return null;
}

export function ensureConversation(buyerId: number, channel: string, email: string | null): number {
  const existing = db().prepare("SELECT id FROM conversations WHERE buyer_id=?").get(buyerId) as { id: number } | undefined;
  if (existing) {
    if (email) applyBetterContact(buyerId, email);
    return existing.id;
  }
  const info = db().prepare(
    "INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle',?,?)"
  ).run(buyerId, channel, email);
  return Number(info.lastInsertRowid);
}

export function attachLots(conversationId: number, lotIds: number[]): void {
  db().prepare("DELETE FROM conversation_lots WHERE conversation_id=?").run(conversationId);
  lotIds.slice(0, 3).forEach((lotId, i) => {
    db().prepare("INSERT OR REPLACE INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,?)").run(conversationId, lotId, i + 1);
  });
}

export async function runMatching(lotId: number): Promise<{ matches: number; queued: number }> {
  const lot = db().prepare("SELECT id, category, quantity, unit_price, total_price, title, brand, raw_text FROM lots WHERE id=?").get(lotId) as
    | { id: number; category: string; quantity: number | null; unit_price: number | null; total_price: number | null; title: string; brand: string | null; raw_text: string | null }
    | undefined;
  if (!lot) return { matches: 0, queued: 0 };
  const inferred = inferLotCategory(lot.title, `${lot.raw_text ?? ""} ${lot.category}`);
  if (inferred !== lot.category) {
    db().prepare("UPDATE lots SET category=?, category_normalized=?, updated_at=datetime('now') WHERE id=?").run(inferred, inferred, lot.id);
    lot.category = inferred;
  }
  if (!lotHasSendableMedia(lotId)) {
    pauseLotsMissingOriginalMedia();
    audit("matching", "skipped_no_original_media", { entityType: "lots", entityId: lotId, ok: false });
    return { matches: 0, queued: 0 };
  }

  const buyers = db().prepare("SELECT * FROM buyers").all() as Array<{
    id: number; company: string; domain: string; channel: string; categories: string;
    txn_capacity_usd: number | null; geography: string; verification_status: string;
    source_evidence: string | null; confidence: number | null; disqualified_reason: string | null;
    outreach_channel: string;
  }>;
  const mandates = db().prepare("SELECT * FROM buyer_mandates WHERE superseded_by IS NULL").all() as Array<{
    id: number; buyer_id: number; category: string; stance: "accepts" | "rejects" | "unknown";
    min_units: number | null; max_units: number | null; superseded_by: number | null; confidence: number;
  }>;
  const stats = db().prepare("SELECT * FROM buyer_category_stats").all() as Array<{
    buyer_id: number; category: string; sends: number; replies: number; offers: number; closes: number; ignores: number; rejects: number;
  }>;
  const ranked = rankBuyersForLot(lot, buyers, { mandates, stats, suppressedDomains: suppressedDomainSet() });

  const upsert = db().prepare(
    `INSERT INTO match_scores(lot_id,buyer_id,score,bucket,capacity_score,product_fit_score,geography_score,history_score,contact_score,rationale,hard_disqualified)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(lot_id,buyer_id) DO UPDATE SET score=excluded.score, bucket=excluded.bucket, rationale=excluded.rationale, hard_disqualified=excluded.hard_disqualified`
  );
  for (const m of ranked) {
    upsert.run(lotId, m.buyerId, m.score, m.bucket, m.capacityScore, m.productFitScore, m.geographyScore, m.historyScore, m.contactScore, m.rationale, m.hardDisqualified);
  }

  db().prepare("UPDATE lots SET state='outreach_active', updated_at=datetime('now') WHERE id=? AND state IN ('structured','media_ready','matchable')").run(lotId);

  let queued = 0;
  // Walk ranked buyers until we queue up to 20 still-eligible (unsent) targets — do not
  // burn the matching window on one-touch / already-sent buyers after the daily cap was removed.
  const rankedEligible = ranked.filter((m) => !m.hardDisqualified && m.score >= 0.45);
  const sentBuyer = new Set(
    (db().prepare(
      "SELECT DISTINCT buyer_id FROM outreach_attempts WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''"
    ).all() as { buyer_id: number }[]).map((r) => r.buyer_id),
  );
  rankedEligible.sort((a, b) => {
    const aSent = sentBuyer.has(a.buyerId) ? 1 : 0;
    const bSent = sentBuyer.has(b.buyerId) ? 1 : 0;
    if (aSent !== bSent) return aSent - bSent;
    if (b.score !== a.score) return b.score - a.score;
    return b.buyerId - a.buyerId;
  });
  for (const m of rankedEligible) {
    if (queued >= 20) break;
    const buyer = buyers.find((b) => b.id === m.buyerId)!;
    const otherLots = db().prepare(
      `SELECT l.id FROM match_scores ms JOIN lots l ON l.id=ms.lot_id
       WHERE ms.buyer_id=? AND ms.score>=0.45 AND ms.hard_disqualified IS NULL AND l.availability='active'
         AND l.state NOT IN ('paused','sold','archived')
         AND l.project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
       ORDER BY ms.score DESC LIMIT 8`
    ).all(buyer.id) as { id: number }[];
    const lotIds = otherLots.map((x) => x.id).filter((id) => lotHasSendableMedia(id));
    if (!lotIds.includes(lotId)) lotIds.unshift(lotId);
    const topLots = untouchedLotIds(buyer.id, lotIds).filter((id) => lotHasSendableMedia(id)).slice(0, 3);
    if (!topLots.includes(lotId) || !topLots.length) continue;

    if (outboundMode() === "live" && liveSentToDomainToday(buyer.domain) >= LIVE_DOMAIN_CAP) continue;

    const contactEmail = liveContactEmail(buyer.id);
    if (contactEmail) {
      recordEndpoint({ buyerId: buyer.id, channel: "email", handle: contactEmail, source: "contact_extract" });
    }
    if (buyerLotAlreadyTouched(buyer.id, topLots).touched) continue;
    if (!hasOutreachPath(buyer.id)) continue;
    const routes = selectOutreachChannels(buyer.id);
    const hasEmail = routes.some((r) => r.endpoint.channel === "email");
    if (!hasEmail && buyerHasPendingFormJob(buyer.id)) continue;
    const rankedEmail = routes.find((r) => r.endpoint.channel === "email")?.endpoint.handle ?? contactEmail;
    const convoId = ensureConversation(buyer.id, buyer.outreach_channel || "unknown", rankedEmail);
    attachLots(convoId, topLots);

    const convo = db().prepare("SELECT state FROM conversations WHERE id=?").get(convoId) as { state: string };
    if (["replied", "qualified", "escalated", "suppressed"].includes(convo.state)) continue;

    const lotRows = db().prepare(
      `SELECT id, title, category, quantity, unit_price, brand, raw_text FROM lots WHERE id IN (${topLots.map(() => "?").join(",")})`
    ).all(...topLots) as { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null; raw_text: string | null }[];

    const oppId = createOpportunity({ buyerId: buyer.id, conversationId: convoId, lotIds: topLots });
    const dispatched = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: buyer.id,
      company: buyer.company,
      domain: buyer.domain,
      lots: lotRows,
    });

    if (dispatched.status === "dry_run" || dispatched.status === "sent") {
      db().prepare(
        "UPDATE conversations SET state='queued', channel=?, last_outbound_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
      ).run(dispatched.channel ?? "unknown", convoId);
      queued += 1;
    } else if (dispatched.status === "deferred" || dispatched.status === "duplicate") {
      // Form/Grok packets and already-attempted rows are not live-send progress.
      // Do not consume the matching window or the next email-capable buyer is skipped forever.
      db().prepare(
        "UPDATE conversations SET channel=?, updated_at=datetime('now') WHERE id=?"
      ).run(dispatched.channel ?? "unknown", convoId);
    }
  }
  audit("matching", "lot_matched", { entityType: "lots", entityId: lotId, detail: { matches: ranked.length, queued } });
  return { matches: ranked.length, queued };
}
