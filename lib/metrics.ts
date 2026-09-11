import { db } from "./db";
import { northStar } from "./orchestrator";

/** North-star is conversations/deals per lot. Everything else is a diagnostic. */
export function funnel() {
  const q = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  return {
    north_star: northStar(),
    lots_received: q("SELECT COUNT(*) AS n FROM lots"),
    qualified_buyers: q("SELECT COUNT(*) AS n FROM buyers WHERE disqualified_reason IS NULL AND verification_status NOT IN ('mismatch_rejected','REJECTED')"),
    qualified_matches: q("SELECT COUNT(*) AS n FROM match_scores WHERE score>=0.45 AND hard_disqualified IS NULL"),
    opportunities_created: q("SELECT COUNT(*) AS n FROM opportunities"),
    opportunities_by_channel: db().prepare(
      "SELECT COALESCE(selected_channel,'none') AS channel, COUNT(*) AS n FROM opportunities GROUP BY selected_channel"
    ).all(),
    outreach_attempts: q("SELECT COUNT(*) AS n FROM outreach_attempts"),
    dry_runs: q("SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='dry_run'"),
    live_sends: q("SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent'"),
    responses: q("SELECT COUNT(*) AS n FROM inbound_events"),
    positive_responses: q("SELECT COUNT(*) AS n FROM inbound_events WHERE interest_level IN ('high','medium')"),
    phones_captured: q("SELECT COUNT(*) AS n FROM inbound_events WHERE phone IS NOT NULL AND phone!=''"),
    oliver_handoffs: q("SELECT COUNT(*) AS n FROM escalations"),
    open_handoffs: q("SELECT COUNT(*) AS n FROM escalations WHERE state='open'"),
    deals: q("SELECT COUNT(*) AS n FROM escalations WHERE state='handed_to_oliver'"),
    revenue: null as number | null,
  };
}

export function opsSnapshot() {
  return {
    lots: db().prepare(
      "SELECT id, title, category, brand, quantity, unit_price, state, availability FROM lots ORDER BY id DESC LIMIT 30"
    ).all(),
    opportunities: db().prepare(
      "SELECT id, buyer_id, selected_channel, selected_handle, stage, reason, lot_ids FROM opportunities ORDER BY id DESC LIMIT 40"
    ).all(),
    recent_whatsapp: db().prepare(
      "SELECT message_id, sent_at, substr(text,1,160) AS text, lot_id, processed FROM whatsapp_messages ORDER BY id DESC LIMIT 20"
    ).all(),
    pending_grok_jobs: db().prepare(
      "SELECT id, agent, substr(instruction,1,120) AS instruction, state FROM grok_jobs WHERE state IN ('queued','claimed') ORDER BY id LIMIT 20"
    ).all(),
    pending_research: db().prepare(
      "SELECT id, kind, query, state FROM research_jobs WHERE state IN ('pending','running') ORDER BY id LIMIT 20"
    ).all(),
  };
}
