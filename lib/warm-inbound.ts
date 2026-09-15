import type { ReplyAnalysisT } from "./classify";
import { looksLikeAutoAck } from "./classify";
import { db, outboundMode } from "./db";
import { enqueueGrokJob } from "./research";
import { recordQualityOutcome, sourceForEmail } from "./targeting";

export function queueOliverHandoff(input: { escalationId: number; packet: string; phone: string }): void {
  const instruction = `oliver_handoff:${input.escalationId}`;
  const existing = db().prepare(
    "SELECT id FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND instruction=?"
  ).get(instruction);
  if (existing) return;
  enqueueGrokJob("INBOUND_ANALYST", instruction, {
    escalationId: input.escalationId,
    phone: input.phone,
    packet: input.packet,
  });
  const esc = db().prepare(
    `SELECT o.selected_handle AS handle, c.contact_email AS email
       FROM escalations e
       LEFT JOIN opportunities o ON o.buyer_id=e.buyer_id
       LEFT JOIN conversations c ON c.buyer_id=e.buyer_id
      WHERE e.id=?
      ORDER BY o.id DESC LIMIT 1`
  ).get(input.escalationId) as { handle: string | null; email: string | null } | undefined;
  const target = esc?.handle || esc?.email;
  if (target) recordQualityOutcome(target, "oliver_handoff", { source: sourceForEmail(target) });
}

export function shouldSendWarmReply(analysis: ReplyAnalysisT, text: string): boolean {
  if (analysis.phone) return false;
  if (["bounce", "unsubscribe", "not_interested", "suspicious"].includes(analysis.classification)) return false;
  if (looksLikeAutoAck(text)) return false;
  return analysis.interestLevel === "high" || analysis.interestLevel === "medium" || analysis.classification === "information_request";
}

export async function sendWarmReply(input: {
  inboundId: number;
  conversationId: number;
  buyerId: number;
  email: string;
  company: string;
  domain: string;
  question: string;
  alreadyHasPhone: boolean;
}): Promise<{ sent: boolean; reason: string }> {
  if (input.alreadyHasPhone) return { sent: false, reason: "phone already captured — no ask" };
  if (outboundMode() !== "live") return { sent: false, reason: "dry_run — not sent" };
  return { sent: false, reason: "warm reply deferred to live guardedOutreach" };
}
