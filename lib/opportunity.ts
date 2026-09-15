import { audit, db } from "./db";
import { getOperator } from "./channels/registry";
import { resultToRouteState, routeSetup, upsertRoute } from "./channels/routes";
import { selectOutreachChannels } from "./channels/select";
import type { ChannelEndpoint, LotBrief, OpportunityStage } from "./channels/types";
import { buyerLotAlreadyTouched } from "./ledger";

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

export async function dispatchOpportunity(input: {
  opportunityId: number;
  conversationId: number;
  buyerId: number;
  company: string;
  domain: string;
  lots: LotBrief[];
}): Promise<{ channel: string | null; status: string; reason: string }> {
  const ranked = selectOutreachChannels(input.buyerId);
  if (!ranked.length) {
    setStage(input.opportunityId, "blocked", "no legitimate channel endpoint");
    audit("opportunity", "blocked_no_channel", { entityType: "opportunities", entityId: input.opportunityId, ok: false });
    return { channel: null, status: "blocked", reason: "no legitimate channel endpoint" };
  }

  const lotIds = input.lots.map((l) => l.id);
  const touch = buyerLotAlreadyTouched(input.buyerId, lotIds);
  if (touch.touched) {
    for (const row of ranked) {
      upsertRoute({
        buyerId: input.buyerId,
        opportunityId: input.opportunityId,
        lotIds,
        channel: row.endpoint.channel,
        handle: row.endpoint.handle,
        state: "suppressed",
        blocker: touch.reason,
        evidence: row.reason,
        idempotencyKey: `route:${input.opportunityId}:${row.endpoint.channel}:${row.endpoint.handle}:${lotIds.slice().sort().join(",")}`,
      });
    }
    setStage(input.opportunityId, "blocked", touch.reason);
    return { channel: ranked[0].endpoint.channel, status: "blocked", reason: touch.reason };
  }

  const runOne = async (selected: typeof ranked[0]) => {
    const endpoint: ChannelEndpoint = selected.endpoint;
    const operator = getOperator(endpoint.channel);
    const ctx = {
      opportunityId: input.opportunityId,
      conversationId: input.conversationId,
      buyerId: input.buyerId,
      company: input.company,
      domain: input.domain,
      lots: input.lots,
      endpoint,
      idempotencyKey: `opp:${input.opportunityId}:${endpoint.channel}:${lotIds.slice().sort().join(",")}`,
    };
    const composed = operator.compose(ctx);
    const prepared = { channel: endpoint.channel, handle: endpoint.handle, subject: composed.subject, body: composed.body, mediaHashes: [] as string[] };
    const setup = routeSetup(endpoint.channel, endpoint.handle);
    const skipExecute = !operator.liveExecution && (setup.state === "needs_human" || setup.state === "discovered" || setup.state === "suppressed");
    const result = skipExecute
      ? { ok: true, status: (setup.state === "suppressed" ? "blocked" : "deferred") as "blocked" | "deferred", reason: setup.blocker ?? setup.state }
      : await Promise.resolve(operator.execute(ctx, prepared));
    const primaryState = skipExecute ? setup.state : resultToRouteState(result.status, result.reason);
    upsertRoute({
      buyerId: input.buyerId,
      opportunityId: input.opportunityId,
      lotIds,
      channel: endpoint.channel,
      handle: endpoint.handle,
      state: primaryState,
      blocker: skipExecute
        ? setup.blocker ?? undefined
        : (result.status === "sent" || result.status === "dry_run" ? undefined : result.reason),
      evidence: selected.reason,
      preparedSubject: composed.subject,
      preparedBody: composed.body,
      idempotencyKey: `route:${input.opportunityId}:${endpoint.channel}:${endpoint.handle}:${lotIds.slice().sort().join(",")}`,
    });
    return { selected, endpoint, result, composed };
  };

  // Email is the only autonomous execute path. Form is bounce/invalid fallback.
  const emailRoute = ranked.find((r) => r.endpoint.channel === "email");
  let chosen = await runOne(emailRoute ?? ranked[0]);
  setStage(input.opportunityId, "channel_selected", chosen.selected.reason, chosen.endpoint.channel, chosen.endpoint.handle);
  setStage(input.opportunityId, "prepared", "composed");

  const emailDead = chosen.endpoint.channel === "email"
    && (chosen.result.status === "blocked" || chosen.result.status === "failed")
    && /suppress|bounce|invalid|not a valid|no recipient/i.test(chosen.result.reason);
  if (emailDead) {
    const form = ranked.find((r) => r.endpoint.channel === "form");
    if (form) chosen = await runOne(form);
  }

  const { endpoint, result, selected } = chosen;

  for (const extra of ranked) {
    if (extra.endpoint.channel === endpoint.channel && extra.endpoint.handle === endpoint.handle) continue;
    const setup = routeSetup(extra.endpoint.channel, extra.endpoint.handle);
    const extraOp = getOperator(extra.endpoint.channel);
    const extraCompose = extraOp.compose({
      opportunityId: input.opportunityId,
      conversationId: input.conversationId,
      buyerId: input.buyerId,
      company: input.company,
      domain: input.domain,
      lots: input.lots,
      endpoint: extra.endpoint,
      idempotencyKey: `opp:${input.opportunityId}:${extra.endpoint.channel}:${lotIds.slice().sort().join(",")}`,
    });
    upsertRoute({
      buyerId: input.buyerId,
      opportunityId: input.opportunityId,
      lotIds,
      channel: extra.endpoint.channel,
      handle: extra.endpoint.handle,
      state: extraOp.liveExecution ? "deferred" : setup.state,
      blocker: extraOp.liveExecution
        ? `one-touch: ${endpoint.channel} is the primary live route`
        : setup.blocker ?? extra.reason,
      evidence: extra.reason,
      preparedSubject: extraCompose.subject,
      preparedBody: extraCompose.body,
      idempotencyKey: `route:${input.opportunityId}:${extra.endpoint.channel}:${extra.endpoint.handle}:${lotIds.slice().sort().join(",")}`,
    });
  }

  if (result.status === "dry_run") setStage(input.opportunityId, "dry_run", result.reason);
  else if (result.status === "sent") setStage(input.opportunityId, "executed", result.reason);
  else if (result.status === "deferred") setStage(input.opportunityId, "deferred", result.reason);
  else if (result.status === "blocked" || result.status === "failed") setStage(input.opportunityId, "blocked", result.reason);
  else if (result.status === "duplicate" && result.reason === "already sent") setStage(input.opportunityId, "executed", result.reason);
  else if (result.status === "duplicate") setStage(input.opportunityId, "dry_run", result.reason);

  audit("opportunity", `dispatch_${result.status}`, {
    entityType: "opportunities",
    entityId: input.opportunityId,
    ok: result.ok,
    detail: { channel: endpoint.channel, reason: result.reason, routes: ranked.length },
  });

  return { channel: endpoint.channel, status: result.status, reason: result.reason };
}
