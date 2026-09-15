import { audit, db } from "./db";
import { extractBuyerEmail, parseRecipient } from "./email/address";
import { lotHasSendableMedia } from "./email/attachments";
import { emit } from "./events";
import { validateMandateEvidence } from "./matcher";
import { pauseLotsMissingOriginalMedia } from "./repairs";
import { enqueueContactUpgradeJobs } from "./targeting";

export function discoverQuery(lot: { id: number; category: string; title: string }): string {
  return `wholesale buyers ${lot.category} ${lot.title}`;
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
  const existing = db().prepare("SELECT id FROM buyers WHERE domain=?").get(domain) as { id: number } | undefined;
  if (existing) return { buyerId: existing.id, created: false };
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

export function recordContact(input: {
  buyerId: number;
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  instagram?: string | null;
  verification?: string;
}): void {
  let email: string | null = null;
  if (input.email) {
    const parsed = parseRecipient(input.email);
    if (parsed.ok) email = parsed.email;
    else {
      const extracted = extractBuyerEmail(input.email);
      if (extracted.ok) email = extracted.email;
    }
  }
  const verification = input.verification ?? "unverified";
  if (email) {
    const existing = db().prepare(
      "SELECT id FROM buyer_contacts WHERE buyer_id=? AND lower(email)=lower(?)"
    ).get(input.buyerId, email) as { id: number } | undefined;
    if (existing) {
      db().prepare(
        `UPDATE buyer_contacts
            SET name=COALESCE(?, name), title=COALESCE(?, title), phone=COALESCE(?, phone),
                linkedin=COALESCE(?, linkedin), instagram=COALESCE(?, instagram), verification=?
          WHERE id=?`
      ).run(input.name ?? null, input.title ?? null, input.phone ?? null, input.linkedin ?? null, input.instagram ?? null, verification, existing.id);
      return;
    }
    db().prepare(
      `INSERT INTO buyer_contacts(buyer_id,name,title,email,phone,linkedin,instagram,verification)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(input.buyerId, input.name ?? null, input.title ?? null, email, input.phone ?? null, input.linkedin ?? null, input.instagram ?? null, verification);
    return;
  }
  if (!input.phone && !input.linkedin && !input.instagram) return;
  db().prepare(
    `INSERT INTO buyer_contacts(buyer_id,name,title,email,phone,linkedin,instagram,verification)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(input.buyerId, input.name ?? null, input.title ?? null, null, input.phone ?? null, input.linkedin ?? null, input.instagram ?? null, verification);
}

export function researchTick(): { queued: number; seeded: number; upgrades: number } {
  pauseLotsMissingOriginalMedia();
  const activeLots = db().prepare(
    `SELECT id, category, title FROM lots
     WHERE availability='active'
       AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
       AND state IN ('matchable','outreach_active','media_ready')`
  ).all() as { id: number; category: string; title: string }[];
  expireIneligibleResearchJobs();
  const eligible = activeLots.filter((lot) => lotEligibleForResearch(lot.id));
  let queued = 0;
  for (const lot of eligible) {
    const coverage = db().prepare("SELECT COUNT(*) AS n FROM match_scores WHERE lot_id=? AND score>=0.6 AND hard_disqualified IS NULL").get(lot.id) as { n: number };
    if (coverage.n < 8) {
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

export function claimGrokJobs(agent?: string, limit = 5): { id: number; agent: string; instruction: string; input: string }[] {
  const rows = agent
    ? db().prepare("SELECT id, agent, instruction, input FROM grok_jobs WHERE state='queued' AND agent=? ORDER BY id LIMIT ?").all(agent, limit)
    : db().prepare("SELECT id, agent, instruction, input FROM grok_jobs WHERE state='queued' ORDER BY id LIMIT ?").all(limit);
  const jobs = rows as { id: number; agent: string; instruction: string; input: string }[];
  for (const j of jobs) {
    db().prepare("UPDATE grok_jobs SET state='claimed', claimed_at=datetime('now') WHERE id=? AND state='queued'").run(j.id);
  }
  return jobs;
}

export function finishGrokJob(id: number, ok: boolean, result: unknown): void {
  db().prepare("UPDATE grok_jobs SET state=?, result=?, finished_at=datetime('now') WHERE id=?").run(ok ? "done" : "failed", JSON.stringify(result), id);
}
