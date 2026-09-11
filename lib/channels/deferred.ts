import { audit, db } from "../db";
import type { ChannelId, ChannelOperator, ChannelResult, OpportunityContext, PreparedOutreach } from "./types";

function stub(id: ChannelId, label: string): ChannelOperator {
  return {
    id,
    liveExecution: false,
    requiresHumanApproval: true,
    compose(ctx) {
      const lots = ctx.lots.map((l) => l.title).join(" / ");
      return {
        subject: `${label} outreach (deferred)`,
        body: `Phase 2 ${label} draft for ${ctx.company}: ${lots}. Not executed. Platform rules + rate limits + opt-out required before live.`,
      };
    },
    execute(ctx, prepared): ChannelResult {
      const info = db().prepare(
        `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
         VALUES(?,?,?,?,?,?,?,'logged',?,?)
         ON CONFLICT(idempotency_key) DO NOTHING`
      ).run(
        ctx.conversationId,
        ctx.buyerId,
        id,
        JSON.stringify(ctx.lots.map((l) => l.id)),
        prepared.subject ?? null,
        prepared.body,
        "[]",
        `${id} operator not live — Phase 2/3`,
        ctx.idempotencyKey,
      );
      audit("channel", "deferred", { entityType: "outreach_attempts", entityId: Number(info.lastInsertRowid), detail: { channel: id } });
      return { ok: true, status: "deferred", reason: `${id} registered but not implemented (Phase 2/3)`, attemptId: Number(info.lastInsertRowid) || undefined };
    },
  };
}

export const formOperator = stub("form", "Wholesale form");
export const instagramOperator = stub("instagram", "Instagram");
export const linkedinOperator = stub("linkedin", "LinkedIn");
export const marketplaceOperator = stub("marketplace", "Marketplace portal");
export const applicationOperator = stub("application", "Vendor application");
export const phoneOperator = stub("phone", "Phone");
export const otherOperator = stub("other", "Other");
