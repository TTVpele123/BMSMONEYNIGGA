import { LIVE_DOMAIN_CAP, liveSentToDomainToday } from "./caps";
import { recordEndpoint } from "./channels/select";
import { audit, db } from "./db";
import { extractBuyerEmail } from "./email/address";
import { buyerLotFormBlocked } from "./ledger";
import { isDeadInbox, purgeDeadInboxEndpoints } from "./suppression";
import { lotHasSendableMedia } from "./email/attachments";
import { emit } from "./events";
import { inferLotCategory, validateMandateEvidence } from "./matcher";
import { pauseLotsMissingOriginalMedia } from "./repairs";
import { enqueueContactUpgradeJobs } from "./targeting";

export function discoverQuery(lot: { id: number; category: string; title: string }): string {
  return `wholesale buyers ${lot.category} ${lot.title}`;
}

/** Buyers with at least one non-suppressed inbox. Bounced-only contacts do not count. */
export function emailReadyBuyerIds(): Set<number> {
  const ready = new Set<number>();
  const contacts = db().prepare(
    "SELECT buyer_id, email, verification FROM buyer_contacts WHERE email IS NOT NULL AND email!=''"
  ).all() as Array<{ buyer_id: number; email: string; verification: string }>;
  for (const row of contacts) {
    if (row.verification === "bounced") continue;
    const parsed = extractBuyerEmail(row.email);
    if (parsed.ok && !isDeadInbox(parsed.email)) ready.add(row.buyer_id);
  }
  const endpoints = db().prepare(
    "SELECT buyer_id, handle FROM buyer_channel_endpoints WHERE channel='email'"
  ).all() as Array<{ buyer_id: number; handle: string }>;
  for (const row of endpoints) {
    const parsed = extractBuyerEmail(row.handle);
    if (parsed.ok && !isDeadInbox(parsed.email)) ready.add(row.buyer_id);
  }
  return ready;
}

export function lotEligibleForResearch(lotId: number): boolean {
  const lot = db().prepare("SELECT id, state, availability, project_gate FROM lots WHERE id=?").get(lotId) as
    | { id: number; state: string; availability: string; project_gate: string }
    | undefined;
  if (!lot) return false;
  if (lot.state === "paused" || lot.state === "sold" || lot.state === "archived") return false;
  if (lot.availability === "paused" || lot.availability === "sold") return false;
  if (lot.project_gate === "DO_NOT_MARKET" || lot.project_gate === "ARCHIVED") return false;
  return lotHasSendableMedia(lotId);
}

/** One pending/running discover job per media-eligible lot. Lot-less discover jobs are not created. */
export function enqueueResearch(kind: string, query: string, lotId?: number): number {
  if (kind === "discover") {
    if (lotId == null || !lotEligibleForResearch(lotId)) return 0;
    const dup = db().prepare(
      "SELECT id FROM research_jobs WHERE kind='discover' AND lot_id=? AND state IN ('pending','running') ORDER BY id LIMIT 1"
    ).get(lotId) as { id: number } | undefined;
    if (dup) return dup.id;
    const info = db().prepare(
      "INSERT INTO research_jobs(kind,query,lot_id,state) VALUES('discover',?,?,'pending')"
    ).run(query, lotId);
    return Number(info.lastInsertRowid);
  }
  const dup = db().prepare("SELECT id FROM research_jobs WHERE kind=? AND query=? AND state IN ('pending','running')").get(kind, query) as { id: number } | undefined;
  if (dup) return dup.id;
  const info = db().prepare("INSERT INTO research_jobs(kind,query,lot_id) VALUES(?,?,?)").run(kind, query, lotId ?? null);
  return Number(info.lastInsertRowid);
}

export type ExpiredResearchJob = {
  id: number;
  lotId: number | null;
  query: string;
  state: "cancelled" | "expired";
  reason: string;
};

function matchJobToLot(query: string): { id: number; category: string; title: string; state: string; availability: string; project_gate: string } | null {
  const lots = db().prepare("SELECT id, category, title, state, availability, project_gate FROM lots").all() as Array<{
    id: number; category: string; title: string; state: string; availability: string; project_gate: string;
  }>;
  return lots.find((lot) => query === discoverQuery(lot)) ?? null;
}

/** Cancel/expire pending jobs that target media-less, paused, or unattached pre-gate queries. Never deletes. */
export function expireIneligibleResearchJobs(): { cancelled: number; expired: number; kept: number; jobs: ExpiredResearchJob[] } {
  const pending = db().prepare(
    "SELECT id, kind, query, lot_id, state FROM research_jobs WHERE state IN ('pending','running')"
  ).all() as Array<{ id: number; kind: string; query: string; lot_id: number | null; state: string }>;
  const jobs: ExpiredResearchJob[] = [];
  let kept = 0;
  const pendingByLot = new Map<number, number>();
  for (const row of pending) {
    const matched = row.lot_id
      ? db().prepare("SELECT id, category, title, state, availability, project_gate FROM lots WHERE id=?").get(row.lot_id) as
        | { id: number; category: string; title: string; state: string; availability: string; project_gate: string }
        | undefined
      : matchJobToLot(row.query);
    if (matched && lotEligibleForResearch(matched.id)) {
      const existing = pendingByLot.get(matched.id);
      if (existing != null) {
        const reason = `duplicate pending discover for lot ${matched.id}`;
        db().prepare(
          `UPDATE research_jobs SET state='cancelled', lot_id=?, last_error=?, result=?, updated_at=datetime('now') WHERE id=?`
        ).run(matched.id, reason, JSON.stringify({ reason, lotId: matched.id }), row.id);
        jobs.push({ id: row.id, lotId: matched.id, query: row.query, state: "cancelled", reason });
        continue;
      }
      pendingByLot.set(matched.id, row.id);
      if (row.lot_id !== matched.id) {
        db().prepare("UPDATE research_jobs SET lot_id=?, updated_at=datetime('now') WHERE id=?").run(matched.id, row.id);
      }
      kept += 1;
      continue;
    }
    if (matched) {
      const reason = `lot ${matched.id} is media-less or paused/DO_NOT_MARKET`;
      db().prepare(
        `UPDATE research_jobs SET state='cancelled', lot_id=?, last_error=?, result=?, updated_at=datetime('now') WHERE id=?`
      ).run(matched.id, reason, JSON.stringify({ reason, lotId: matched.id }), row.id);
      jobs.push({ id: row.id, lotId: matched.id, query: row.query, state: "cancelled", reason });
      continue;
    }
    const reason = "pre-media-gate job not tied to a media-eligible lot";
    db().prepare(
      `UPDATE research_jobs SET state='expired', last_error=?, result=?, updated_at=datetime('now') WHERE id=?`
    ).run(reason, JSON.stringify({ reason }), row.id);
    jobs.push({ id: row.id, lotId: null, query: row.query, state: "expired", reason });
  }
  if (jobs.length) {
    audit("research", "expired_ineligible_jobs", {
      detail: { cancelled: jobs.filter((j) => j.state === "cancelled").length, expired: jobs.filter((j) => j.state === "expired").length, kept },
    });
  }
  return {
    cancelled: jobs.filter((j) => j.state === "cancelled").length,
    expired: jobs.filter((j) => j.state === "expired").length,
    kept,
    jobs,
  };
}

export function pendingDiscoverQueue(): { jobId: number; lotId: number | null; query: string }[] {
  return db().prepare(
    "SELECT id AS jobId, lot_id AS lotId, query FROM research_jobs WHERE kind='discover' AND state IN ('pending','running') ORDER BY lot_id, id"
  ).all() as { jobId: number; lotId: number | null; query: string }[];
}

const CHANNELS = new Set(["email", "form", "linkedin", "instagram", "phone", "manual", "unknown"]);

function normalizeChannel(raw?: string): string {
  const v = (raw ?? "unknown").toLowerCase();
  if (CHANNELS.has(v)) return v;
  if (/form|intake/.test(v)) return "form";
  if (/linkedin/.test(v)) return "linkedin";
  if (/instagram/.test(v)) return "instagram";
  if (/phone|call/.test(v)) return "phone";
  if (/email|gmail/.test(v)) return "email";
  return "unknown";
}

function mergeCsv(a?: string | null, b?: string | null): string {
  return [...new Set(`${a ?? ""},${b ?? ""}`.split(",").map((s) => s.trim()).filter(Boolean))].join(",");
}

export function enrollBuyer(input: {
  company: string;
  domain: string;
  website?: string;
  categories?: string;
  channel?: string;
  outreach_channel?: string;
  source_evidence?: string;
  verification_status?: string;
}): { buyerId: number; created: boolean } {
  const domain = input.domain.toLowerCase().replace(/^www\./, "");
  const existing = db().prepare(
    "SELECT id, website, categories, source_evidence, verification_status FROM buyers WHERE domain=?"
  ).get(domain) as {
    id: number;
    website: string | null;
    categories: string;
    source_evidence: string | null;
    verification_status: string;
  } | undefined;
  if (existing) {
    const evidence = input.source_evidence && !existing.source_evidence?.includes(input.source_evidence)
      ? [existing.source_evidence, input.source_evidence].filter(Boolean).join(" | ").slice(0, 4000)
      : existing.source_evidence;
    db().prepare(
      `UPDATE buyers SET
         website=COALESCE(NULLIF(?, ''), website),
         categories=?,
         source_evidence=?,
         verification_status=CASE WHEN verification_status IN ('unverified','') AND ? != '' THEN ? ELSE verification_status END,
         updated_at=datetime('now')
       WHERE id=?`
    ).run(
      input.website ?? "",
      mergeCsv(existing.categories, input.categories),
      evidence,
      input.verification_status ?? "",
      input.verification_status ?? "unverified",
      existing.id,
    );
    return { buyerId: existing.id, created: false };
  }
  const info = db().prepare(
    `INSERT INTO buyers(company,domain,website,categories,channel,outreach_channel,source_evidence,verification_status)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    input.company, domain, input.website ?? null, input.categories ?? "",
    input.channel ?? "unknown", normalizeChannel(input.outreach_channel),
    input.source_evidence ?? null, input.verification_status ?? "unverified",
  );
  audit("research", "buyer_enrolled", { entityType: "buyers", entityId: Number(info.lastInsertRowid), detail: { domain } });
  return { buyerId: Number(info.lastInsertRowid), created: true };
}

/** Persist a decision-maker on the existing buyer. Never creates a second company. */
export function recordContact(input: {
  buyerId: number;
  name?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  instagram?: string;
  verification?: string;
}): void {
  const parsed = input.email?.trim() ? extractBuyerEmail(input.email) : { ok: false as const };
  let email = parsed.ok ? parsed.email : null;
  if (email && isDeadInbox(email)) email = null;
  const name = input.name?.trim() || null;
  const title = input.title?.trim() || null;
  const phone = input.phone?.trim() || null;
  const linkedin = input.linkedin?.trim() || null;
  const instagram = input.instagram?.trim() || null;
  const verification = input.verification ?? "unverified";
  if (!email && !name && !phone && !linkedin && !instagram) return;
  if (email) {
    db().prepare(
      `INSERT INTO buyer_contacts(buyer_id,name,title,email,phone,linkedin,instagram,verification)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(buyer_id, email) DO UPDATE SET
         name=COALESCE(excluded.name, buyer_contacts.name),
         title=COALESCE(excluded.title, buyer_contacts.title),
         phone=COALESCE(excluded.phone, buyer_contacts.phone),
         linkedin=COALESCE(excluded.linkedin, buyer_contacts.linkedin),
         instagram=COALESCE(excluded.instagram, buyer_contacts.instagram),
         verification=CASE WHEN excluded.verification='verified' THEN excluded.verification ELSE buyer_contacts.verification END`
    ).run(input.buyerId, name, title, email, phone, linkedin, instagram, verification);
    recordEndpoint({ buyerId: input.buyerId, channel: "email", handle: email, confidence: 0.85, verified: verification === "verified", source: "buyer_contacts" });
  } else {
    db().prepare(
      `INSERT INTO buyer_contacts(buyer_id,name,title,email,phone,linkedin,instagram,verification)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(input.buyerId, name, title, null, phone, linkedin, instagram, verification);
  }
  if (phone) recordEndpoint({ buyerId: input.buyerId, channel: "phone", handle: phone, confidence: 0.7, source: "buyer_contacts" });
  if (linkedin) recordEndpoint({ buyerId: input.buyerId, channel: "linkedin", handle: linkedin, confidence: 0.65, source: "buyer_contacts" });
  if (instagram) recordEndpoint({ buyerId: input.buyerId, channel: "instagram", handle: instagram, confidence: 0.6, source: "buyer_contacts" });
}

export function recordMandate(input: {
  buyerId: number;
  category: string;
  stance: "accepts" | "rejects" | "unknown";
  origin?: string;
  sourceUrl?: string | null;
  sourceQuote?: string | null;
  minUnits?: number | null;
  maxUnits?: number | null;
}): number {
  validateMandateEvidence(input);
  const live = db().prepare(
    "SELECT id FROM buyer_mandates WHERE buyer_id=? AND category=? AND superseded_by IS NULL"
  ).get(input.buyerId, input.category) as { id: number } | undefined;
  const info = db().prepare(
    `INSERT INTO buyer_mandates(buyer_id,category,stance,min_units,max_units,source_url,source_quote,origin)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    input.buyerId, input.category, input.stance,
    input.minUnits ?? null, input.maxUnits ?? null,
    input.sourceUrl ?? null, input.sourceQuote ?? null,
    input.origin ?? "research",
  );
  const id = Number(info.lastInsertRowid);
  if (live) db().prepare("UPDATE buyer_mandates SET superseded_by=? WHERE id=?").run(id, live.id);
  return id;
}

function remainingEmailReadyBuyerIds(lotId: number, emailReady = emailReadyBuyerIds()): number[] {
  const remainingRows = db().prepare(
    `SELECT b.id AS buyer_id FROM match_scores ms
      JOIN buyers b ON b.id=ms.buyer_id
      WHERE ms.lot_id=? AND ms.score>=0.6 AND ms.hard_disqualified IS NULL
        AND b.disqualified_reason IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM outreach_ledger ol
          WHERE ol.buyer_id=b.id AND ol.lot_id=ms.lot_id
            AND ol.status IN ('sent_once','replied_manual_only','opted_out','suppressed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM outreach_attempts oa
          WHERE oa.buyer_id=b.id AND oa.status='sent'
            AND EXISTS (SELECT 1 FROM json_each(oa.lot_ids) j WHERE j.value=ms.lot_id)
        )`
  ).all(lotId) as Array<{ buyer_id: number }>;
  return remainingRows.filter((r) => emailReady.has(r.buyer_id)).map((r) => r.buyer_id);
}

/** High scores that already sent, or that have no live inbox, are not live coverage. */
export function remainingEmailReadyForLot(lotId: number, emailReady = emailReadyBuyerIds()): number {
  return remainingEmailReadyBuyerIds(lotId, emailReady).length;
}

/** Remaining email-ready matches whose domain is still under the rolling domain cap. */
export function remainingSendableTodayForLot(lotId: number, emailReady = emailReadyBuyerIds()): number {
  let n = 0;
  for (const buyerId of remainingEmailReadyBuyerIds(lotId, emailReady)) {
    const row = db().prepare("SELECT domain FROM buyers WHERE id=?").get(buyerId) as { domain: string } | undefined;
    if (row && liveSentToDomainToday(row.domain) < LIVE_DOMAIN_CAP) n += 1;
  }
  return n;
}

/** Domains whose only inboxes hard-bounced. Researcher should find a replacement mailbox. */
export function bouncedOnlyDomains(emailReady = emailReadyBuyerIds()): string[] {
  const rows = db().prepare(
    `SELECT b.id, b.domain FROM buyers b
      WHERE EXISTS (
        SELECT 1 FROM buyer_contacts bc
         WHERE bc.buyer_id=b.id AND bc.verification='bounced'
      )
      ORDER BY b.domain`
  ).all() as Array<{ id: number; domain: string }>;
  return rows.filter((r) => !emailReady.has(r.id)).map((r) => r.domain);
}

/** Rewrite stored lot category from title when ingest caption leaked the wrong class. */
export function repairLotCategories(): number {
  const lots = db().prepare(
    `SELECT id, title, category, raw_text FROM lots
      WHERE availability='active'
        AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
        AND state IN ('structured','matchable','outreach_active','media_ready')`
  ).all() as Array<{ id: number; title: string; category: string; raw_text: string | null }>;
  let n = 0;
  for (const lot of lots) {
    const next = inferLotCategory(lot.title, `${lot.raw_text ?? ""} ${lot.category}`);
    if (next === lot.category) continue;
    db().prepare("UPDATE lots SET category=?, category_normalized=?, updated_at=datetime('now') WHERE id=?").run(next, next, lot.id);
    db().prepare(
      "UPDATE research_jobs SET query=? WHERE kind='discover' AND lot_id=? AND state IN ('pending','running')"
    ).run(discoverQuery({ id: lot.id, category: next, title: lot.title }), lot.id);
    n += 1;
  }
  return n;
}

export function researchTick(): { queued: number; seeded: number; upgrades: number } {
  pauseLotsMissingOriginalMedia();
  purgeDeadInboxEndpoints();
  repairLotCategories();
  const activeLots = db().prepare(
    `SELECT id, category, title FROM lots
     WHERE availability='active'
       AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
       AND state IN ('matchable','outreach_active','media_ready')`
  ).all() as { id: number; category: string; title: string }[];
  expireIneligibleResearchJobs();
  const eligible = activeLots.filter((lot) => lotEligibleForResearch(lot.id));
  const emailReady = emailReadyBuyerIds();
  let queued = 0;
  for (const lot of eligible) {
    const scored = db().prepare("SELECT COUNT(*) AS n FROM match_scores WHERE lot_id=?").get(lot.id) as { n: number };
    const remaining = remainingEmailReadyForLot(lot.id, emailReady);
    const sendableToday = remainingSendableTodayForLot(lot.id, emailReady);
    const coverage = scored.n === 0 ? 0 : remaining;
    if (coverage < 8 || sendableToday < 8) {
      const had = db().prepare(
        "SELECT id FROM research_jobs WHERE kind='discover' AND lot_id=? AND state IN ('pending','running')"
      ).get(lot.id);
      const id = enqueueResearch("discover", discoverQuery(lot), lot.id);
      if (id && !had) queued += 1;
    }
  }
  const upgrades = enqueueContactUpgradeJobs();
  emit("research.tick", { queued, upgrades }, `research.tick:${new Date().toISOString().slice(0, 13)}`);
  audit("research", "tick", { detail: { queued, upgrades, lots: eligible.length } });
  return { queued, seeded: eligible.length, upgrades };
}

export function enqueueGrokJob(agent: string, instruction: string, input: unknown): number {
  const info = db().prepare("INSERT INTO grok_jobs(agent,instruction,input) VALUES(?,?,?)").run(agent, instruction, JSON.stringify(input));
  return Number(info.lastInsertRowid);
}

function formJobLotIds(packet: { lots?: Array<{ id?: number }>; idempotencyKey?: string }): number[] {
  const fromLots = (packet.lots ?? []).map((l) => l.id).filter((id): id is number => typeof id === "number");
  if (fromLots.length) return fromLots;
  const key = packet.idempotencyKey ?? "";
  const tail = key.split(":").pop() ?? "";
  return tail.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** Drop pending form jobs only after a confirmed form send or a reply/opt-out. Email one-touch is not a form close. */
export function expireTouchedFormJobs(): number {
  const rows = db().prepare(
    "SELECT id, input FROM grok_jobs WHERE agent='FORM_OPERATOR' AND state IN ('queued','claimed')"
  ).all() as Array<{ id: number; input: string }>;
  let n = 0;
  for (const row of rows) {
    let packet: { buyerId?: number; lots?: Array<{ id?: number }>; idempotencyKey?: string } = {};
    try { packet = JSON.parse(row.input) as typeof packet; } catch { continue; }
    if (packet.buyerId == null) continue;
    const lotIds = formJobLotIds(packet);
    if (!lotIds.length) continue;
    const touch = buyerLotFormBlocked(packet.buyerId, lotIds);
    if (!touch.blocked) continue;
    db().prepare(
      "UPDATE grok_jobs SET state='failed', result=?, finished_at=datetime('now') WHERE id=? AND state IN ('queued','claimed')"
    ).run(JSON.stringify({ cancelled: true, reason: touch.reason }), row.id);
    n += 1;
  }
  return n;
}

/** Checking the queue must not leave jobs stuck claimed after a narrate/hesitate pass. */
export function releaseStaleClaimedGrokJobs(minutes = 8): number {
  return db().prepare(
    `UPDATE grok_jobs SET state='queued', claimed_at=NULL
      WHERE state='claimed' AND claimed_at IS NOT NULL
        AND claimed_at <= datetime('now', ?)`
  ).run(`-${minutes} minutes`).changes;
}

function grokClaimLimit(agent: string, limit?: number): number {
  if (limit != null) return limit;
  return agent === "INBOUND_ANALYST" || agent === "FORM_OPERATOR" ? 1 : 5;
}

export function peekGrokJobs(agent?: string, limit?: number): { id: number; agent: string; instruction: string; input: string }[] {
  if (!agent) return [];
  const take = grokClaimLimit(agent, limit);
  return db().prepare(
    "SELECT id, agent, instruction, input FROM grok_jobs WHERE state IN ('queued','claimed') AND agent=? ORDER BY id LIMIT ?"
  ).all(agent, take) as { id: number; agent: string; instruction: string; input: string }[];
}

export function claimGrokJobs(agent?: string, limit?: number): { id: number; agent: string; instruction: string; input: string }[] {
  releaseStaleClaimedGrokJobs();
  if (!agent) return [];
  if (agent === "FORM_OPERATOR") expireTouchedFormJobs();
  const take = grokClaimLimit(agent, limit);
  if (agent === "FORM_OPERATOR" || agent === "INBOUND_ANALYST") {
    const open = db().prepare(
      "SELECT id, agent, instruction, input FROM grok_jobs WHERE state='claimed' AND agent=? ORDER BY id LIMIT ?"
    ).all(agent, take) as { id: number; agent: string; instruction: string; input: string }[];
    if (open.length) return open;
  }
  const rows = db().prepare("SELECT id, agent, instruction, input FROM grok_jobs WHERE state='queued' AND agent=? ORDER BY id LIMIT ?").all(agent, take);
  const jobs = rows as { id: number; agent: string; instruction: string; input: string }[];
  for (const j of jobs) {
    db().prepare("UPDATE grok_jobs SET state='claimed', claimed_at=datetime('now') WHERE id=? AND state='queued'").run(j.id);
  }
  return jobs;
}

export function finishGrokJob(id: number, ok: boolean, result: unknown): void {
  db().prepare("UPDATE grok_jobs SET state=?, result=?, finished_at=datetime('now') WHERE id=?").run(ok ? "done" : "failed", JSON.stringify(result), id);
}
