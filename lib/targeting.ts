/**
 * Permanent contact ranking for outbound email.
 * Rank is intra-buyer only — never drops a sendable company from the match slice.
 * Generic inboxes stay sendable so volume holds; better evidence replaces them later.
 */
import { audit, db } from "./db";
import { extractBuyerEmail, parseRecipient } from "./email/address";

export const CONTACT_QUALITIES = ["named_buyer", "purchasing", "sales_buying", "generic"] as const;
export type ContactQuality = (typeof CONTACT_QUALITIES)[number];

export const QUALITY_RANK: Record<ContactQuality, number> = {
  named_buyer: 4,
  purchasing: 3,
  sales_buying: 2,
  generic: 1,
};

export type QualityOutcome = "delivered" | "bounced" | "replied" | "phone_captured" | "oliver_handoff";

const GENERIC_LOCAL = /^(info|contact|hello|hi|office|support|admin|team|help|enquir(?:y|ies)|inquir(?:y|ies)|mail|general|webmaster|noreply|no-reply)$/i;
const SALES_BUYING_LOCAL = /^(sales|buy|buying|wholesale|vendors?|orders|deals|liquidat(?:ion|e)?|overstock|closeouts?)$/i;
const PURCHASING_LOCAL = /^(purchasing|procurement|buyers?|merchandis(?:e|ing)?|category|inventory|sourcing|vendorrelations|warehouse|receiving)$/i;
const GUESSED_ROLE_LOCAL = /^(purchasing|info|sales|hello|contact|office|support|admin|team|help)$/i;
const BUYING_TITLE = /buyer|purchas|procur|merchandis|inventor|closeout|liquidat|category|owner|general manager|\bgm\b|founder|president|principal|\bceo\b|\bcoo\b|director of (purchas|procur|merch|inventor)/i;

export function emailLocalPart(handle: string): string {
  return (handle.split("@")[0] ?? "").trim().toLowerCase();
}

export function normalizeContactSource(raw?: string | null): string {
  const v = (raw ?? "unknown").trim();
  if (!v) return "unknown";
  const head = v.split(":")[0].trim();
  if (/buyer_researcher/i.test(head)) return "BUYER_RESEARCHER";
  if (/opportunity_researcher/i.test(head)) return "OPPORTUNITY_RESEARCHER";
  if (/inbound/i.test(head)) return "inbound";
  if (/legacy/i.test(head)) return "legacy";
  if (/buyer_contacts/i.test(head)) return "buyer_contacts";
  return head.slice(0, 64) || "unknown";
}

export function looksNamedLocal(local: string): boolean {
  if (!local) return false;
  if (GENERIC_LOCAL.test(local) || SALES_BUYING_LOCAL.test(local) || PURCHASING_LOCAL.test(local)) return false;
  if (/^[a-z]+[._-][a-z]+$/i.test(local)) return true;
  if (/^[a-z]{2,20}$/i.test(local)) return true;
  return false;
}

export function classifyEmailQuality(
  handle: string,
  extras: { name?: string | null; title?: string | null; evidence?: string | null } = {},
): ContactQuality {
  const local = emailLocalPart(handle);
  const title = `${extras.title ?? ""} ${extras.name ?? ""} ${extras.evidence ?? ""}`;
  if (GENERIC_LOCAL.test(local)) return "generic";
  if (PURCHASING_LOCAL.test(local)) return "purchasing";
  if (SALES_BUYING_LOCAL.test(local)) return "sales_buying";
  if (looksNamedLocal(local)) {
    if (!extras.title || BUYING_TITLE.test(title)) return "named_buyer";
    return "named_buyer";
  }
  if (BUYING_TITLE.test(title)) return "named_buyer";
  return "sales_buying";
}

/** Guessed role mailbox with no on-page mailto. Named addresses are never skipped this way. */
export function isGuessedRoleEmail(handle: string, evidence: string): boolean {
  const local = emailLocalPart(handle);
  if (!GUESSED_ROLE_LOCAL.test(local)) return false;
  return !evidence.toLowerCase().includes("mailto");
}

export function qualityBonus(quality: ContactQuality): number {
  return (QUALITY_RANK[quality] - 1) * 2;
}

type QualityStatRow = {
  quality: string;
  source: string;
  delivered: number;
  bounced: number;
  replied: number;
  phone_captured: number;
  oliver_handoff: number;
};

function ensureQualityRow(quality: ContactQuality, source: string): void {
  db().prepare(
    `INSERT INTO contact_quality_stats(quality,source,delivered,bounced,replied,phone_captured,oliver_handoff)
     VALUES(?,?,0,0,0,0,0)
     ON CONFLICT(quality,source) DO NOTHING`
  ).run(quality, source);
}

export function recordQualityOutcome(
  handle: string,
  kind: QualityOutcome,
  extras: { source?: string | null; name?: string | null; title?: string | null } = {},
): void {
  const parsed = parseRecipient(handle);
  if (!parsed.ok) return;
  const quality = classifyEmailQuality(parsed.email, extras);
  const source = extras.source ? normalizeContactSource(extras.source) : sourceForEmail(parsed.email);
  ensureQualityRow(quality, source);
  const col = {
    delivered: "delivered",
    bounced: "bounced",
    replied: "replied",
    phone_captured: "phone_captured",
    oliver_handoff: "oliver_handoff",
  }[kind];
  db().prepare(`UPDATE contact_quality_stats SET ${col}=${col}+1 WHERE quality=? AND source=?`).run(quality, source);
  audit("targeting", `quality_${kind}`, { detail: { email: parsed.email, quality, source } });
}

export function sourceForEmail(email: string): string {
  const ep = db().prepare(
    "SELECT source FROM buyer_channel_endpoints WHERE channel='email' AND lower(handle)=lower(?) ORDER BY id DESC LIMIT 1"
  ).get(email) as { source: string | null } | undefined;
  if (ep?.source) return normalizeContactSource(ep.source);
  const contact = db().prepare(
    "SELECT verification FROM buyer_contacts WHERE email IS NOT NULL AND lower(email)=lower(?) LIMIT 1"
  ).get(email) as { verification: string | null } | undefined;
  return normalizeContactSource(contact?.verification ?? "unknown");
}

export function sourceLift(quality: ContactQuality, source: string): number {
  const row = db().prepare(
    "SELECT delivered, bounced, replied, phone_captured, oliver_handoff FROM contact_quality_stats WHERE quality=? AND source=?"
  ).get(quality, normalizeContactSource(source)) as Omit<QualityStatRow, "quality" | "source"> | undefined;
  if (!row) return 0;
  const attempts = row.delivered + row.bounced;
  if (attempts < 3) return 0;
  const value = (row.replied + row.phone_captured * 1.5 + row.oliver_handoff * 2 - row.bounced) / attempts;
  return Math.max(-1.5, Math.min(2, value));
}

export function rankEmailScore(
  handle: string,
  extras: { source?: string | null; name?: string | null; title?: string | null; evidence?: string | null } = {},
): { quality: ContactQuality; source: string; bonus: number } {
  const quality = classifyEmailQuality(handle, extras);
  const source = normalizeContactSource(extras.source);
  return { quality, source, bonus: qualityBonus(quality) + sourceLift(quality, source) };
}

export type RankedEmail = {
  email: string;
  quality: ContactQuality;
  source: string;
  name: string | null;
  title: string | null;
  score: number;
};

export function listBuyerEmails(buyerId: number): RankedEmail[] {
  const seen = new Set<string>();
  const out: RankedEmail[] = [];
  const add = (email: string, source: string | null, name: string | null, title: string | null) => {
    const parsed = parseRecipient(email);
    const extracted = parsed.ok ? parsed : extractBuyerEmail(email);
    if (!extracted.ok) return;
    const key = extracted.email;
    if (seen.has(key)) return;
    seen.add(key);
    const ranked = rankEmailScore(key, { source, name, title });
    out.push({
      email: key,
      quality: ranked.quality,
      source: ranked.source,
      name,
      title,
      score: ranked.bonus,
    });
  };

  const endpoints = db().prepare(
    "SELECT handle, source FROM buyer_channel_endpoints WHERE buyer_id=? AND channel='email'"
  ).all(buyerId) as Array<{ handle: string; source: string | null }>;
  for (const e of endpoints) add(e.handle, e.source, null, null);

  const contacts = db().prepare(
    "SELECT email, name, title, verification FROM buyer_contacts WHERE buyer_id=? AND email IS NOT NULL AND trim(email)!=''"
  ).all(buyerId) as Array<{ email: string; name: string | null; title: string | null; verification: string }>;
  for (const c of contacts) add(c.email, c.verification, c.name, c.title);

  return out.sort((a, b) => b.score - a.score || QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality]);
}

export function bestEmailForBuyer(buyerId: number): RankedEmail | null {
  return listBuyerEmails(buyerId)[0] ?? null;
}

export function isWeakEmailQuality(quality: ContactQuality): boolean {
  return quality === "generic" || quality === "sales_buying";
}

export type UpgradeTarget = {
  buyerId: number;
  company: string;
  domain: string;
  handle: string;
  quality: ContactQuality;
  source: string;
};

/** Existing buyers whose best inbox is still generic/sales. Research upgrades these; matching still sends. */
export function listWeakEmailBuyers(limit = 25): UpgradeTarget[] {
  const buyers = db().prepare(
    `SELECT id, company, domain FROM buyers
      WHERE disqualified_reason IS NULL
        AND verification_status NOT IN ('mismatch_rejected','REJECTED')
      ORDER BY id DESC`
  ).all() as Array<{ id: number; company: string; domain: string }>;
  const out: UpgradeTarget[] = [];
  for (const b of buyers) {
    const best = bestEmailForBuyer(b.id);
    if (!best || !isWeakEmailQuality(best.quality)) continue;
    out.push({
      buyerId: b.id,
      company: b.company,
      domain: b.domain,
      handle: best.email,
      quality: best.quality,
      source: best.source,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function applyBetterContact(buyerId: number, email: string): { upgraded: boolean; from: string | null; to: string } {
  const parsed = parseRecipient(email);
  if (!parsed.ok) return { upgraded: false, from: null, to: email };
  const next = parsed.email;
  const convo = db().prepare(
    "SELECT id, contact_email FROM conversations WHERE buyer_id=?"
  ).get(buyerId) as { id: number; contact_email: string | null } | undefined;
  const current = convo?.contact_email ? parseRecipient(convo.contact_email) : null;
  const currentEmail = current?.ok ? current.email : convo?.contact_email ?? null;
  if (currentEmail === next) {
    return { upgraded: false, from: currentEmail, to: next };
  }
  const nextQ = classifyEmailQuality(next);
  if (currentEmail) {
    const curQ = classifyEmailQuality(currentEmail);
    if (QUALITY_RANK[nextQ] < QUALITY_RANK[curQ]) return { upgraded: false, from: currentEmail, to: next };
    if (QUALITY_RANK[nextQ] === QUALITY_RANK[curQ] && sourceLift(nextQ, sourceForEmail(next)) <= sourceLift(curQ, sourceForEmail(currentEmail))) {
      return { upgraded: false, from: currentEmail, to: next };
    }
  }
  if (convo) {
    db().prepare("UPDATE conversations SET contact_email=?, updated_at=datetime('now') WHERE id=?").run(next, convo.id);
  }
  db().prepare(
    `UPDATE opportunities
        SET selected_handle=?, selected_channel='email', updated_at=datetime('now')
      WHERE buyer_id=?
        AND stage NOT IN ('executed','response_captured','handed_off')`
  ).run(next, buyerId);
  audit("targeting", "contact_upgraded", {
    entityType: "buyers",
    entityId: buyerId,
    detail: { from: currentEmail, to: next, quality: nextQ },
  });
  return { upgraded: true, from: currentEmail, to: next };
}

export function qualityFunnel() {
  const rows = db().prepare(
    `SELECT quality, source, delivered, bounced, replied, phone_captured, oliver_handoff
       FROM contact_quality_stats
      ORDER BY quality, source`
  ).all() as QualityStatRow[];
  const byQuality = CONTACT_QUALITIES.map((quality) => {
    const slice = rows.filter((r) => r.quality === quality);
    const sum = (k: keyof QualityStatRow) => slice.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    return {
      quality,
      delivered: sum("delivered"),
      bounced: sum("bounced"),
      replied: sum("replied"),
      phone_captured: sum("phone_captured"),
      oliver_handoff: sum("oliver_handoff"),
    };
  });
  return { by_quality: byQuality, by_source: rows };
}

export function enqueueContactUpgradeJobs(limit = 8): number {
  const pending = db().prepare(
    `SELECT COUNT(*) AS n FROM grok_jobs
      WHERE agent='OPPORTUNITY_RESEARCHER' AND state IN ('queued','claimed')
        AND instruction LIKE 'upgrade-contact:%'`
  ).get() as { n: number };
  const slots = Math.max(0, limit - pending.n);
  if (!slots) return 0;
  let queued = 0;
  for (const target of listWeakEmailBuyers(slots + 4)) {
    if (queued >= slots) break;
    const instruction = `upgrade-contact:${target.buyerId}`;
    const existing = db().prepare(
      "SELECT id FROM grok_jobs WHERE agent='OPPORTUNITY_RESEARCHER' AND instruction=? AND state IN ('queued','claimed')"
    ).get(instruction);
    if (existing) continue;
    db().prepare("INSERT INTO grok_jobs(agent,instruction,input) VALUES(?,?,?)").run(
      "OPPORTUNITY_RESEARCHER",
      instruction,
      JSON.stringify({
        buyerId: target.buyerId,
        domain: target.domain,
        company: target.company,
        current_handle: target.handle,
        current_quality: target.quality,
        goal: "named_buyer",
      }),
    );
    queued += 1;
  }
  if (queued) audit("targeting", "upgrade_jobs_queued", { detail: { queued } });
  return queued;
}
