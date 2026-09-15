export const CHANNEL_IDS = [
  "email",
  "form",
  "instagram",
  "linkedin",
  "marketplace",
  "application",
  "phone",
  "other",
] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export type OpportunityStage =
  | "discovered"
  | "qualified"
  | "channel_selected"
  | "prepared"
  | "dry_run"
  | "executed"
  | "response_captured"
  | "handed_off"
  | "blocked"
  | "deferred";

export interface ChannelEndpoint {
  channel: ChannelId;
  handle: string;
  confidence: number;
  verified: boolean;
  source: string;
  name?: string;
  title?: string;
}

export interface LotBrief {
  id: number;
  title: string;
  category: string;
  quantity: number | null;
  unit_price: number | null;
  brand: string | null;
  /** Optional supplier description — used only to derive buyer-facing titles. */
  raw_text?: string | null;
}

export interface OpportunityContext {
  opportunityId?: number;
  conversationId: number;
  buyerId: number;
  company: string;
  domain: string;
  lots: LotBrief[];
  endpoint: ChannelEndpoint;
  idempotencyKey: string;
}

export interface PreparedOutreach {
  channel: ChannelId;
  handle: string;
  subject?: string;
  body: string;
  html?: string;
  mediaHashes: string[];
}

export interface ChannelResult {
  ok: boolean;
  status: "dry_run" | "sent" | "blocked" | "failed" | "deferred" | "duplicate";
  reason: string;
  attemptId?: number;
}

/** One operator per channel. Matching/research/deals never import a specific adapter. */
export interface ChannelOperator {
  id: ChannelId;
  /** Only email is live tonight. Others prepare + defer. */
  liveExecution: boolean;
  requiresHumanApproval: boolean;
  compose(ctx: OpportunityContext): { subject?: string; body: string };
  execute(ctx: OpportunityContext, prepared: PreparedOutreach): ChannelResult | Promise<ChannelResult>;
}
