import { db } from "../db";
import { extractBuyerEmail, parseRecipient } from "../email/address";
import { isDeadInbox, isSuppressed } from "../suppression";
import { rankEmailScore } from "../targeting";
import type { ChannelEndpoint, ChannelId } from "./types";

/** Channels that may become a sales action. Instagram/portals/phone are research or reject. */
export const OUTREACH_CHANNELS: ChannelId[] = ["email", "form", "linkedin"];

/** Lower is better. Named email beats a form; form beats last-resort LinkedIn. */
const FRICTION: Record<ChannelId, number> = {
  email: 1,
  form: 3,
  marketplace: 9,
  application: 9,
  linkedin: 6,
  instagram: 9,
  phone: 8,
  other: 9,
};

const GENERIC_LOCAL = /^(info|sales|hello|contact|office|admin|support|mail)@/i;
const BUYING_TITLE = /purchas|buyer|merchant|procurement|sourcing|closeout|liquidation|wholesale/i;

export function recordEndpoint(input: {
  buyerId: number;
  channel: ChannelId;
  handle: string;
  confidence?: number;
  verified?: boolean;
  source?: string;
}): void {
  let handle = input.handle.trim();
  if (!handle) return;
  if (input.channel === "email") {
    const parsed = extractBuyerEmail(handle);
    if (!parsed.ok) return;
    if (isDeadInbox(parsed.email)) return;
    handle = parsed.email;
  }
  db().prepare(
    `INSERT INTO buyer_channel_endpoints(buyer_id,channel,handle,confidence,verified,source)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(buyer_id,channel,handle) DO UPDATE SET
       confidence=MAX(buyer_channel_endpoints.confidence, excluded.confidence),
       verified=MAX(buyer_channel_endpoints.verified, excluded.verified)`
  ).run(input.buyerId, input.channel, handle, input.confidence ?? 0.5, input.verified ? 1 : 0, input.source ?? "manual");
}

export function listEndpoints(buyerId: number): ChannelEndpoint[] {
  const out: ChannelEndpoint[] = [];
  const seen = new Set<string>();
  const add = (e: ChannelEndpoint) => {
    const key = `${e.channel}:${e.handle.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };

  const stored = db().prepare(
    "SELECT channel, handle, confidence, verified, source FROM buyer_channel_endpoints WHERE buyer_id=?"
  ).all(buyerId) as Array<{ channel: ChannelId; handle: string; confidence: number; verified: number; source: string | null }>;
  for (const r of stored) {
    if (r.channel === "email") {
      const parsed = extractBuyerEmail(r.handle);
      if (!parsed.ok) continue;
      add({ channel: r.channel, handle: parsed.email, confidence: r.confidence, verified: r.verified === 1, source: r.source ?? "stored" });
      continue;
    }
    add({ channel: r.channel, handle: r.handle, confidence: r.confidence, verified: r.verified === 1, source: r.source ?? "stored" });
  }

  const contacts = db().prepare(
    "SELECT email, phone, linkedin, instagram, name, title, verification FROM buyer_contacts WHERE buyer_id=?"
  ).all(buyerId) as Array<{
    email: string | null; phone: string | null; linkedin: string | null; instagram: string | null;
    name: string | null; title: string | null; verification: string;
  }>;
  for (const c of contacts) {
    const verified = /verified|public_intake|clay/i.test(c.verification ?? "");
    if (c.email) {
      const parsed = parseRecipient(c.email);
      const extracted = parsed.ok ? parsed : extractBuyerEmail(c.email);
      if (extracted.ok) {
        add({
          channel: "email",
          handle: extracted.email,
          confidence: verified ? 0.95 : 0.6,
          verified,
          source: "buyer_contacts",
          name: c.name ?? undefined,
          title: c.title ?? undefined,
        });
      }
    }
    if (c.phone) add({ channel: "phone", handle: c.phone, confidence: 0.7, verified, source: "buyer_contacts" });
    if (c.linkedin) add({ channel: "linkedin", handle: c.linkedin, confidence: 0.65, verified, source: "buyer_contacts" });
    if (c.instagram) add({ channel: "instagram", handle: c.instagram, confidence: 0.6, verified, source: "buyer_contacts" });
  }

  return out.filter((e) => e.channel !== "email" ? !isSuppressed(e.handle).suppressed : !isDeadInbox(e.handle));
}

function namedContactBoost(buyerId: number, e: ChannelEndpoint): number {
  if (e.channel !== "email") return 0;
  const contact = db().prepare(
    "SELECT name, title FROM buyer_contacts WHERE buyer_id=? AND lower(email)=lower(?) LIMIT 1"
  ).get(buyerId, e.handle) as { name: string | null; title: string | null } | undefined;
  let boost = 0;
  if (contact?.name?.trim()) boost += 1.2;
  if (BUYING_TITLE.test(contact?.title ?? "")) boost += 2;
  if (GENERIC_LOCAL.test(e.handle) && boost < 2) boost -= 2;
  return boost;
}

function historyBoost(buyerId: number, channel: ChannelId): number {
  if (channel === "form") {
    const dead = db().prepare(
      "SELECT COUNT(*) AS n FROM channel_routes WHERE buyer_id=? AND channel='form' AND state IN ('failed','suppressed')"
    ).get(buyerId) as { n: number };
    if (dead.n > 0) return -4;
  }
  const stats = db().prepare(
    "SELECT COALESCE(SUM(replies),0) AS replies, COALESCE(SUM(rejects),0) AS rejects FROM buyer_category_stats WHERE buyer_id=?"
  ).get(buyerId) as { replies: number; rejects: number };
  if (channel === "email" && stats.rejects >= 2 && stats.replies === 0) return -1.5;
  if (channel === "email" && stats.replies > 0) return 0.8;
  return 0;
}

function scoreEndpoint(buyerId: number, e: ChannelEndpoint, preferred?: string): number {
  const friction = FRICTION[e.channel] ?? 9;
  let score = e.confidence * 10 - friction;
  if (e.verified) score += 2;
  if (preferred && e.channel === preferred) score += 1.5;
  if (e.channel === "email" && !e.verified) score -= 1.5;
  // Autonomous overnight path is email. A verified form must not outrank a real inbox.
  if (e.channel === "email") {
    score += 8;
    score += rankEmailScore(e.handle, { source: e.source, name: e.name, title: e.title }).bonus;
  }
  score += namedContactBoost(buyerId, e);
  score += historyBoost(buyerId, e.channel);
  return score;
}

export type RankedChannel = { endpoint: ChannelEndpoint; score: number; reason: string };

function rankEndpoints(buyerId: number, outreachOnly: boolean): RankedChannel[] {
  const buyer = db().prepare("SELECT outreach_channel FROM buyers WHERE id=?").get(buyerId) as { outreach_channel: string } | undefined;
  const preferred = buyer?.outreach_channel && buyer.outreach_channel !== "unknown" ? buyer.outreach_channel : undefined;
  return listEndpoints(buyerId)
    .filter((e) => !outreachOnly || OUTREACH_CHANNELS.includes(e.channel))
    .map((e) => {
      const score = scoreEndpoint(buyerId, e, preferred);
      const quality = e.channel === "email"
        ? rankEmailScore(e.handle, { source: e.source, name: e.name, title: e.title }).quality
        : e.channel;
      const reason = preferred && e.channel === preferred
        ? `preferred ${preferred} available`
        : `${e.channel} ${quality} score ${score.toFixed(2)} (verified=${e.verified})`;
      return { endpoint: e, score, reason };
    })
    .sort((a, b) => b.score - a.score);
}

/** All stored routes, best first. Includes research-only handles. */
export function selectChannels(buyerId: number): RankedChannel[] {
  return rankEndpoints(buyerId, false);
}

/** Channels that may be dispatched as a sales action. */
export function selectOutreachChannels(buyerId: number): RankedChannel[] {
  return rankEndpoints(buyerId, true);
}

export function hasOutreachPath(buyerId: number): boolean {
  return selectOutreachChannels(buyerId).length > 0;
}

/**
 * Highest-confidence outreach route. Never invents purchasing@domain.
 * Instagram/portals are not a sales path.
 */
export function selectChannel(buyerId: number): RankedChannel | null {
  return rankEndpoints(buyerId, true)[0] ?? null;
}
