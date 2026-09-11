import { audit, db } from "./db";
import { emit } from "./events";
import { validateMandateEvidence } from "./matcher";

export function enqueueResearch(kind: string, query: string): number {
  const dup = db().prepare("SELECT id FROM research_jobs WHERE kind=? AND query=? AND state IN ('pending','running')").get(kind, query) as { id: number } | undefined;
  if (dup) return dup.id;
  const info = db().prepare("INSERT INTO research_jobs(kind,query) VALUES(?,?)").run(kind, query);
  return Number(info.lastInsertRowid);
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

export function researchTick(): { queued: number; seeded: number } {
  const activeLots = db().prepare("SELECT id, category, title FROM lots WHERE availability='active' AND state IN ('matchable','outreach_active','structured','media_ready')").all() as { id: number; category: string; title: string }[];
  let queued = 0;
  for (const lot of activeLots) {
    const coverage = db().prepare("SELECT COUNT(*) AS n FROM match_scores WHERE lot_id=? AND score>=0.6 AND hard_disqualified IS NULL").get(lot.id) as { n: number };
    if (coverage.n < 8) {
      enqueueResearch("discover", `wholesale buyers ${lot.category} ${lot.title}`);
      queued += 1;
    }
  }
  enqueueResearch("discover", "licensed apparel closeout wholesale buyers");
  enqueueResearch("discover", "footwear closeout wholesale buyers");
  enqueueResearch("discover", "health beauty closeout buyers");
  queued += 3;
  emit("research.tick", { queued }, `research.tick:${new Date().toISOString().slice(0, 13)}`);
  audit("research", "tick", { detail: { queued, lots: activeLots.length } });
  return { queued, seeded: activeLots.length };
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
