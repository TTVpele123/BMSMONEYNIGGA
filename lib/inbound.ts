import { audit, db } from "./db";
import { classifyReply, isHotLead, type ReplyAnalysisT } from "./classify";
import { emit } from "./events";
import { createEscalation } from "./escalate";
import { recordOutcome } from "./learning";
import { markReplied } from "./ledger";
import { writeBounce, writeUnsubscribe } from "./suppression";

export function processInbound(input: {
  from: string;
  text: string;
  providerMessageId?: string;
  bounced?: boolean;
}): { ok: true; classification: string; conversationId: number | null; escalated: boolean } {
  const existing = input.providerMessageId
    ? db().prepare("SELECT id FROM inbound_events WHERE provider_message_id=?").get(input.providerMessageId)
    : null;
  if (existing) {
    return { ok: true, classification: "duplicate", conversationId: null, escalated: false };
  }

  const analysis = classifyReply(input.text, { bounced: input.bounced });
  const buyer = db().prepare(
    `SELECT b.id, c.id AS conversation_id FROM buyers b
     LEFT JOIN conversations c ON c.buyer_id=b.id
     LEFT JOIN buyer_contacts bc ON bc.buyer_id=b.id
     WHERE lower(bc.email)=lower(?) OR lower(b.domain)=lower(?)
     LIMIT 1`
  ).get(input.from, input.from.split("@")[1] ?? "") as { id: number; conversation_id: number | null } | undefined;

  const info = db().prepare(
    `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,provider_message_id,classification,interest_level,phone,quantity,price,raw_text)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    buyer?.conversation_id ?? null,
    buyer?.id ?? null,
    input.from,
    input.providerMessageId ?? null,
    analysis.classification,
    analysis.interestLevel,
    analysis.phone,
    analysis.targetQuantity,
    analysis.targetPrice,
    input.text,
  );

  if (analysis.classification === "unsubscribe") writeUnsubscribe(input.from);
  if (analysis.classification === "bounce") writeBounce(input.from);
  if (buyer && !["bounce", "out_of_office"].includes(analysis.classification)) {
    markReplied(input.from, buyer.id);
    db().prepare("UPDATE conversations SET state='replied', last_inbound_at=datetime('now'), updated_at=datetime('now') WHERE buyer_id=?").run(buyer.id);
    db().prepare(
      "UPDATE opportunities SET stage='response_captured', updated_at=datetime('now') WHERE buyer_id=? AND stage IN ('dry_run','executed','deferred','prepared','channel_selected')"
    ).run(buyer.id);
  }

  applyLearning(buyer?.id, analysis);

  let escalated = false;
  if (buyer && isHotLead(analysis)) {
    createEscalation({
      buyerId: buyer.id,
      conversationId: buyer.conversation_id,
      reason: analysis.phone ? "phone captured" : analysis.classification,
      phone: analysis.phone,
      analysis,
    });
    escalated = true;
  }

  emit("inbound.received", { inboundId: Number(info.lastInsertRowid), classification: analysis.classification }, input.providerMessageId ? `inbound:${input.providerMessageId}` : undefined);
  audit("inbound", "classified", { entityType: "inbound_events", entityId: Number(info.lastInsertRowid), detail: { classification: analysis.classification, escalated } });
  return { ok: true, classification: analysis.classification, conversationId: buyer?.conversation_id ?? null, escalated };
}

function applyLearning(buyerId: number | undefined, analysis: ReplyAnalysisT): void {
  if (!buyerId) return;
  if (analysis.classification === "not_interested" || analysis.classification === "unsubscribe") {
    recordOutcome(buyerId, "reject");
  } else if (analysis.interestLevel === "high") {
    recordOutcome(buyerId, "reply");
  } else if (analysis.classification === "unknown") {
    recordOutcome(buyerId, "ignore");
  }
}
