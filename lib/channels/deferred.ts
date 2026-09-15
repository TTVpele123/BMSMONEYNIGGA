import { audit, db } from "../db";
import type { ChannelId, ChannelOperator, ChannelResult } from "./types";

function stub(id: ChannelId, label: string): ChannelOperator {
  return {
    id,
    liveExecution: false,
    requiresHumanApproval: true,
    compose(ctx) {
      const facts = ctx.lots.map((l) => {
        const qty = l.quantity != null ? `${l.quantity} units` : "qty on request";
        const price = l.unit_price != null ? `$${l.unit_price}/unit` : "price on request";
        return `• ${l.title} — ${l.category} — ${qty} — ${price}`;
      }).join("\n");
      return {
        subject: `${label} packet — ${ctx.lots.map((l) => l.title).join(" / ")}`.slice(0, 140),
        body: [
          `${label} draft for ${ctx.company} (${ctx.domain}).`,
          `Route: ${ctx.endpoint.handle}`,
          "",
          "Supplier facts only:",
          facts || "• lot facts on request",
          "",
          "Original Oliver product photos would attach if this route goes live. Not executed.",
        ].join("\n"),
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
        JSON.stringify(prepared.mediaHashes ?? []),
        `${id} operator not live — packet recorded, not submitted`,
        ctx.idempotencyKey,
      );
      audit("channel", "deferred", { entityType: "outreach_attempts", entityId: Number(info.lastInsertRowid), detail: { channel: id } });
      return { ok: true, status: "deferred", reason: `${id} packet recorded — not submitted`, attemptId: Number(info.lastInsertRowid) || undefined };
    },
  };
}

export const instagramOperator = stub("instagram", "Instagram");
export const linkedinOperator = stub("linkedin", "LinkedIn");
export const marketplaceOperator = stub("marketplace", "Marketplace portal");
export const applicationOperator = stub("application", "Vendor application");
export const phoneOperator = stub("phone", "Phone");
export const otherOperator = stub("other", "Other");
