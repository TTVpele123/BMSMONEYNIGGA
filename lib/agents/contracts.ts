import { z } from "zod";

export const AgentEnvelope = z.object({
  agent: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  ok: z.boolean(),
  error: z.string().nullable(),
  permissions: z.array(z.string()),
  fabricated: z.literal(false),
});
export type AgentEnvelopeT = z.infer<typeof AgentEnvelope>;

export const AGENTS = {
  orchestrator: { permissions: ["events", "audit"], grok: false, phase: "1" },
  lot_intake: { permissions: ["lots", "lot_media", "whatsapp_messages"], grok: false, phase: "1" },
  WHATSAPP_SCANNER: { permissions: ["GET /api/health", "GET /api/ops/snapshot", "POST /api/ingest/whatsapp"], grok: true, phase: "1", createTomorrow: true },
  matching: { permissions: ["match_scores", "conversations", "opportunities"], grok: false, phase: "1" },
  email_operator: { permissions: ["channel:email", "outreach_attempts", "ledger"], grok: false, live: true, phase: "1" },
  BUYER_RESEARCHER: { permissions: ["GET /api/ops/snapshot", "GET /api/metrics", "POST /api/research/findings"], grok: true, phase: "1", createTomorrow: "after_scanner" },
  OPPORTUNITY_RESEARCHER: { permissions: ["GET /api/research/opportunities", "GET /api/research/coverage", "POST /api/research/findings"], grok: true, phase: "1", createTomorrow: "after_matching" },
  INBOUND_ANALYST: { permissions: ["inbound_events", "escalations"], grok: true, phase: "1", createTomorrow: false },
  FORM_OPERATOR: { permissions: ["channel:form", "GET /api/grok/jobs", "POST /api/grok/jobs", "POST /api/channels/form/result"], grok: true, live: true, phase: "2", createTomorrow: true },
  INSTAGRAM_OPERATOR: { permissions: ["channel:instagram"], grok: true, live: false, phase: "3", createTomorrow: false },
  LINKEDIN_OPERATOR: { permissions: ["channel:linkedin"], grok: true, live: false, phase: "3", createTomorrow: false },
  MARKETPLACE_OPERATOR: { permissions: ["channel:marketplace"], grok: true, live: false, phase: "3", createTomorrow: false },
  outreach: { permissions: ["outreach_attempts", "ledger"], grok: false, phase: "1" },
  inbound: { permissions: ["inbound_events", "suppressions"], grok: false, phase: "1" },
  research: { permissions: ["buyers", "research_jobs", "mandates"], grok: false, phase: "1" },
  escalation: { permissions: ["escalations"], grok: false, phase: "1" },
  learning: { permissions: ["buyer_category_stats"], grok: false, phase: "1" },
} as const;
