import { audit, db } from "./db";
import type { ReplyAnalysisT } from "./classify";

export function createEscalation(input: {
  buyerId: number;
  conversationId: number | null;
  reason: string;
  phone: string | null;
  analysis: ReplyAnalysisT;
}): number {
  let convoId = input.conversationId;
  if (!convoId) {
    const row = db().prepare("SELECT id FROM conversations WHERE buyer_id=?").get(input.buyerId) as { id: number } | undefined;
    if (row) convoId = row.id;
    else {
      const created = db().prepare("INSERT INTO conversations(buyer_id,state) VALUES(?,'escalated')").run(input.buyerId);
      convoId = Number(created.lastInsertRowid);
    }
  }
  const lots = db().prepare("SELECT lot_id FROM conversation_lots WHERE conversation_id=?").all(convoId) as { lot_id: number }[];
  const buyer = db().prepare("SELECT company, domain FROM buyers WHERE id=?").get(input.buyerId) as { company: string; domain: string };
  const packet = [
    `OLIVER HANDOFF — do not auto-message Oliver`,
    `Buyer: ${buyer.company} (${buyer.domain})`,
    `Reason: ${input.reason}`,
    `Phone: ${input.phone ?? "NOT YET CAPTURED — primary next action"}`,
    `Interest: ${input.analysis.interestLevel} / ${input.analysis.classification}`,
    `Qty asked: ${input.analysis.targetQuantity ?? "n/a"}`,
    `Price asked: ${input.analysis.targetPrice ?? "n/a"}`,
    `Lots: ${lots.map((l) => l.lot_id).join(", ") || "see conversation"}`,
    `Objections: ${input.analysis.objections.join("; ") || "none extracted"}`,
  ].join("\n");

  const info = db().prepare(
    `INSERT INTO escalations(conversation_id,buyer_id,lot_ids,reason,phone,packet,state) VALUES(?,?,?,?,?,?,'open')`
  ).run(convoId, input.buyerId, JSON.stringify(lots.map((l) => l.lot_id)), input.reason, input.phone, packet);
  db().prepare("UPDATE conversations SET state='escalated', next_action='oliver_handoff', updated_at=datetime('now') WHERE id=?").run(convoId);
  audit("escalation", "created", { entityType: "escalations", entityId: Number(info.lastInsertRowid), detail: { reason: input.reason } });
  return Number(info.lastInsertRowid);
}

export function openHandoffs(): { id: number; packet: string; created_at: string }[] {
  return db().prepare("SELECT id, packet, created_at FROM escalations WHERE state='open' ORDER BY id DESC").all() as { id: number; packet: string; created_at: string }[];
}
