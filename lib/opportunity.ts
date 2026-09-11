import { audit, db } from "./db";
import { getOperator } from "./channels/registry";
import { selectChannel } from "./channels/select";
import type { ChannelEndpoint, LotBrief, OpportunityStage } from "./channels/types";

export function createOpportunity(input: {
  buyerId: number;
  conversationId: number;
  lotIds: number[];
}): number {
  const existing = db().prepare(
    "SELECT id FROM opportunities WHERE buyer_id=? AND conversation_id=? AND lot_ids=?"
  ).get(input.buyerId, input.conversationId, JSON.stringify(input.lotIds)) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db().prepare(
    "INSERT INTO opportunities(buyer_id,conversation_id,lot_ids,stage) VALUES(?,?,?,'qualified')"
  ).run(input.buyerId, input.conversationId, JSON.stringify(input.lotIds));
  return Number(info.lastInsertRowid);
}

function setStage(id: number, stage: OpportunityStage, reason?: string, channel?: string, handle?: string): void {
  db().prepare(
    "UPDATE opportunities SET stage=?, reason=?, selected_channel=COALESCE(?,selected_channel), selected_handle=COALESCE(?,selected_handle), updated_at=datetime('now') WHERE id=?"
  ).run(stage, reason ?? null, channel ?? null, handle ?? null, id);
}

export function dispatchOpportunity(input: {
  opportunityId: number;
  conversationId: number;
  buyerId: number;
  company: string;
  domain: string;
  lots: LotBrief[];
}): { channel: string | null; status: string; reason: string } {
  const selected = selectChannel(input.buyerId);
  if (!selected) {
    setStage(input.opportunityId, "blocked", "no legitimate channel endpoint");
    audit("opportunity", "blocked_no_channel", { entityType: "opportunities", entityId: input.opportunityId, ok: false });
    return { channel: null, status: "blocked", reason: "no legitimate channel endpoint" };
  }

  const endpoint: ChannelEndpoint = selected.endpoint;
  setStage(input.opportunityId, "channel_selected", selected.reason, endpoint.channel, endpoint.handle);

  const operator = getOperator(endpoint.channel);
  const ctx = {
    opportunityId: input.opportunityId,
    conversationId: input.conversationId,
    buyerId: input.buyerId,
    company: input.company,
    domain: input.domain,
    lots: input.lots,
    endpoint,
    idempotencyKey: `opp:${input.opportunityId}:${endpoint.channel}:${input.lots.map((l) => l.id).sort().join(",")}`,
  };
  const composed = operator.compose(ctx);
  const prepared = { channel: endpoint.channel, handle: endpoint.handle, subject: composed.subject, body: composed.body, mediaHashes: [] as string[] };
  setStage(input.opportunityId, "prepared", "composed");

  const result = operator.execute(ctx, prepared);

  if (result.status === "dry_run") setStage(input.opportunityId, "dry_run", result.reason);
  else if (result.status === "sent") setStage(input.opportunityId, "executed", result.reason);
  else if (result.status === "deferred") setStage(input.opportunityId, "deferred", result.reason);
  else if (result.status === "blocked" || result.status === "failed") setStage(input.opportunityId, "blocked", result.reason);
  else if (result.status === "duplicate") setStage(input.opportunityId, "dry_run", result.reason);

  audit("opportunity", `dispatch_${result.status}`, {
    entityType: "opportunities",
    entityId: input.opportunityId,
    ok: result.ok,
    detail: { channel: endpoint.channel, reason: result.reason },
  });

  return { channel: endpoint.channel, status: result.status, reason: result.reason };
}
