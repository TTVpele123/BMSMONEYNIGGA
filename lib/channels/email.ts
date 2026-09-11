import { composeMessage, guardedOutreach } from "../outreach";
import type { ChannelOperator, ChannelResult, OpportunityContext, PreparedOutreach } from "./types";

export const emailOperator: ChannelOperator = {
  id: "email",
  liveExecution: true,
  requiresHumanApproval: false,
  compose(ctx) {
    return composeMessage({ company: ctx.company, lots: ctx.lots });
  },
  execute(ctx, prepared): ChannelResult {
    return guardedOutreach({
      conversationId: ctx.conversationId,
      buyerId: ctx.buyerId,
      email: ctx.endpoint.handle,
      domain: ctx.domain,
      company: ctx.company,
      lots: ctx.lots,
      channel: "email",
      idempotencyKey: ctx.idempotencyKey,
      composed: prepared,
    });
  },
};
