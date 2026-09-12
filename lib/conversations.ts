import { audit, db } from "./db";
import { rankBuyersForLot } from "./matcher";
import { createOpportunity, dispatchOpportunity } from "./opportunity";
import { suppressedDomainSet } from "./suppression";

export function ensureConversation(buyerId: number, channel: string, email: string | null): number {
  const existing = db().prepare("SELECT id FROM conversations WHERE buyer_id=?").get(buyerId) as { id: number } | undefined;
  if (existing) return existing.id;
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
  const lot = db().prepare("SELECT id, category, quantity, unit_price, total_price, title, brand FROM lots WHERE id=?").get(lotId) as
    | { id: number; category: string; quantity: number | null; unit_price: number | null; total_price: number | null; title: string; brand: string | null }
    | undefined;
  if (!lot) return { matches: 0, queued: 0 };

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
  const targets = ranked.filter((m) => !m.hardDisqualified && m.score >= 0.45).slice(0, 15);
  for (const m of targets) {
    const buyer = buyers.find((b) => b.id === m.buyerId)!;
    const otherLots = db().prepare(
      `SELECT l.id FROM match_scores ms JOIN lots l ON l.id=ms.lot_id
       WHERE ms.buyer_id=? AND ms.score>=0.45 AND ms.hard_disqualified IS NULL AND l.availability='active'
       ORDER BY ms.score DESC LIMIT 3`
    ).all(buyer.id) as { id: number }[];
    const lotIds = otherLots.map((x) => x.id);
    if (!lotIds.includes(lotId)) lotIds.unshift(lotId);
    const topLots = lotIds.slice(0, 3);

    const contact = db().prepare("SELECT email FROM buyer_contacts WHERE buyer_id=? AND email IS NOT NULL LIMIT 1").get(buyer.id) as { email: string } | undefined;
    const convoId = ensureConversation(buyer.id, buyer.outreach_channel || "unknown", contact?.email ?? null);
    attachLots(convoId, topLots);

    const convo = db().prepare("SELECT state FROM conversations WHERE id=?").get(convoId) as { state: string };
    if (["replied", "qualified", "escalated", "suppressed"].includes(convo.state)) continue;

    const lotRows = db().prepare(
      `SELECT id, title, category, quantity, unit_price, brand FROM lots WHERE id IN (${topLots.map(() => "?").join(",")})`
    ).all(...topLots) as { id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }[];

    const oppId = createOpportunity({ buyerId: buyer.id, conversationId: convoId, lotIds: topLots });
    const dispatched = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: buyer.id,
      company: buyer.company,
      domain: buyer.domain,
      lots: lotRows,
    });

    if (dispatched.status === "dry_run" || dispatched.status === "sent" || dispatched.status === "deferred" || dispatched.status === "duplicate") {
      db().prepare(
        "UPDATE conversations SET state='queued', channel=?, last_outbound_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
      ).run(dispatched.channel ?? "unknown", convoId);
      queued += 1;
    }
  }
  audit("matching", "lot_matched", { entityType: "lots", entityId: lotId, detail: { matches: ranked.length, queued } });
  return { matches: ranked.length, queued };
}
