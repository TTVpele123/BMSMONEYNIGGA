import { listEndpoints } from "./channels/select";
import { db, killSwitchOn, outboundMode } from "./db";
import { northStar } from "./orchestrator";
import { isSuppressed } from "./suppression";
import { bestEmailForBuyer, isWeakEmailQuality, listWeakEmailBuyers, qualityFunnel } from "./targeting";

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
    live_sends: q("SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''"),
    responses: q("SELECT COUNT(*) AS n FROM inbound_events"),
    positive_responses: q("SELECT COUNT(*) AS n FROM inbound_events WHERE interest_level IN ('high','medium')"),
    phones_captured: q("SELECT COUNT(*) AS n FROM inbound_events WHERE phone IS NOT NULL AND phone!=''"),
    oliver_handoffs: q("SELECT COUNT(*) AS n FROM escalations"),
    open_handoffs: q("SELECT COUNT(*) AS n FROM escalations WHERE state='open'"),
    deals: q("SELECT COUNT(*) AS n FROM escalations WHERE state='handed_to_oliver'"),
    revenue: null as number | null,
    contact_quality: qualityFunnel(),
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

/** Compact skip-list so BUYER_RESEARCHER expands the pool instead of re-finding known domains. */
export function researchCoverage() {
  const q = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
  return {
    mode: outboundMode(),
    kill: killSwitchOn(),
    known_domains: (db().prepare("SELECT domain FROM buyers ORDER BY domain").all() as { domain: string }[]).map((r) => r.domain),
    suppressed: db().prepare("SELECT address_or_domain AS value, reason FROM suppressions").all(),
    buyer_counts: {
      total: q("SELECT COUNT(*) AS n FROM buyers"),
      qualified: q("SELECT COUNT(*) AS n FROM buyers WHERE disqualified_reason IS NULL AND verification_status NOT IN ('mismatch_rejected','REJECTED')"),
      with_email: q("SELECT COUNT(DISTINCT buyer_id) AS n FROM buyer_contacts WHERE email IS NOT NULL AND email!=''"),
      no_email: q("SELECT COUNT(*) AS n FROM buyers b WHERE NOT EXISTS (SELECT 1 FROM buyer_contacts c WHERE c.buyer_id=b.id AND c.email IS NOT NULL AND c.email!='')"),
    },
    upgrade_targets: listWeakEmailBuyers(25),
    contact_quality: qualityFunnel(),
    lots: db().prepare(
      `SELECT l.id, l.title, l.category, l.brand, l.quantity, l.unit_price, l.state, l.availability,
              (SELECT COUNT(*) FROM lot_media m WHERE m.lot_id=l.id AND m.outreach_safe=1) AS safe_media,
              (SELECT COUNT(*) FROM match_scores ms WHERE ms.lot_id=l.id AND ms.score>=0.45 AND ms.hard_disqualified IS NULL) AS qualified_matches
         FROM lots l
        WHERE l.availability='active'
          AND l.project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
          AND l.state IN ('matchable','outreach_active','media_ready')
          AND EXISTS (
            SELECT 1 FROM lot_media m
             WHERE m.lot_id=l.id AND m.outreach_safe=1 AND m.association_certain=1
               AND m.classification NOT IN ('screenshot_chat_capture','invalid','duplicate')
          )
        ORDER BY l.id DESC`
    ).all(),
  };
}

type OppRow = {
  id: number;
  buyer_id: number;
  lot_ids: string;
  selected_channel: string | null;
  selected_handle: string | null;
  stage: string;
  reason: string | null;
  company: string;
  domain: string;
  website: string | null;
  categories: string;
  verification_status: string;
};

function lotBriefs(lotIdsJson: string) {
  let ids: number[] = [];
  try { ids = JSON.parse(lotIdsJson) as number[]; } catch { ids = []; }
  if (!ids.length) return [];
  const rows = db().prepare(
    `SELECT id, title, category, brand, quantity, unit_price FROM lots WHERE id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as Array<{ id: number; title: string; category: string; brand: string | null; quantity: number | null; unit_price: number | null }>;
  return rows;
}

function buyerPack(buyerId: number, company: string, domain: string, website: string | null, categories: string, verification: string) {
  return {
    id: buyerId,
    company,
    domain,
    website,
    categories,
    verification,
    endpoints: listEndpoints(buyerId),
    suppressed: isSuppressed(domain).suppressed,
  };
}

/** Rank-ready pairs with company/domain/endpoints. Snapshot buyer_id alone is not usable by Grok. */
export function opportunityWorklist(limit = 25) {
  const opps = db().prepare(
    `SELECT o.id, o.buyer_id, o.lot_ids, o.selected_channel, o.selected_handle, o.stage, o.reason,
            b.company, b.domain, b.website, b.categories, b.verification_status
       FROM opportunities o
       JOIN buyers b ON b.id=o.buyer_id
      ORDER BY CASE o.stage
        WHEN 'blocked' THEN 0 WHEN 'deferred' THEN 1 WHEN 'qualified' THEN 2 WHEN 'dry_run' THEN 3 ELSE 4 END,
        o.id DESC
      LIMIT ?`
  ).all(limit) as OppRow[];

  const unmatched = db().prepare(
    `SELECT b.id, b.company, b.domain, b.website, b.categories, b.verification_status
       FROM buyers b
      WHERE b.disqualified_reason IS NULL
        AND b.verification_status NOT IN ('mismatch_rejected','REJECTED')
        AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.buyer_id=b.id)
      ORDER BY b.id DESC
      LIMIT 20`
  ).all() as Array<{ id: number; company: string; domain: string; website: string | null; categories: string; verification_status: string }>;

  const pairs = opps.map((o) => {
    const handle = o.selected_handle ?? bestEmailForBuyer(o.buyer_id)?.email ?? null;
    const quality = handle ? (bestEmailForBuyer(o.buyer_id)?.quality ?? null) : null;
    return {
      opportunity_id: o.id,
      stage: o.stage,
      selected_channel: o.selected_channel,
      selected_handle: o.selected_handle,
      contact_quality: quality,
      needs_upgrade: quality ? isWeakEmailQuality(quality) : true,
      reason: o.reason,
      lots: lotBriefs(o.lot_ids),
      buyer: buyerPack(o.buyer_id, o.company, o.domain, o.website, o.categories, o.verification_status),
    };
  }).sort((a, b) => {
    if (a.stage === "blocked" && b.stage !== "blocked") return -1;
    if (b.stage === "blocked" && a.stage !== "blocked") return 1;
    return Number(b.needs_upgrade) - Number(a.needs_upgrade);
  });

  return {
    mode: outboundMode(),
    kill: killSwitchOn(),
    pairs,
    unmatched_buyers: unmatched.map((b) => {
      const best = bestEmailForBuyer(b.id);
      return {
        opportunity_id: null,
        stage: "unmatched",
        contact_quality: best?.quality ?? null,
        needs_upgrade: best ? isWeakEmailQuality(best.quality) : true,
        lots: [],
        buyer: buyerPack(b.id, b.company, b.domain, b.website, b.categories, b.verification_status),
      };
    }),
    upgrade_targets: listWeakEmailBuyers(25),
  };
}
