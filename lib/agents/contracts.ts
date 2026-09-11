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
  orchestrator: { permissions: ["events", "audit"], grok: false },
  lot_intake: { permissions: ["lots", "lot_media", "whatsapp_messages"], grok: false },
  whatsapp_scanner: { permissions: ["POST /api/ingest/whatsapp"], grok: true },
  matching: { permissions: ["match_scores", "conversations"], grok: false },
  outreach: { permissions: ["outreach_attempts", "ledger"], grok: false },
  inbound: { permissions: ["inbound_events", "suppressions"], grok: false },
  research: { permissions: ["buyers", "research_jobs", "mandates"], grok: "optional" },
  form_operator: { permissions: ["POST /api/grok/jobs"], grok: true },
  social_operator: { permissions: ["POST /api/grok/jobs"], grok: true },
  escalation: { permissions: ["escalations"], grok: false },
  learning: { permissions: ["buyer_category_stats"], grok: false },
} as const;
