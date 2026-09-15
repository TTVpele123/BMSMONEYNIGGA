import { db } from "../db";
import { extractBuyerEmail, parseRecipient } from "../email/address";
import { isSuppressed } from "../suppression";
import { rankEmailScore } from "../targeting";
import type { ChannelEndpoint, ChannelId } from "./types";

/** Lower is better. Email is preferred when a real verified inbox exists. */
const FRICTION: Record<ChannelId, number> = {
  email: 1,
  form: 3,
  marketplace: 4,
  application: 4,
  linkedin: 5,
  instagram: 5,
  phone: 8,
  other: 9,
};

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
    const parsed = parseRecipient(handle);
    if (!parsed.ok) return;
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
      const parsed = parseRecipient(r.handle);
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

  return out.filter((e) => !isSuppressed(e.handle).suppressed);
}

function scoreEndpoint(e: ChannelEndpoint, preferred?: string): number {
  const friction = FRICTION[e.channel] ?? 9;
  let score = e.confidence * 10 - friction;
  if (e.verified) score += 2;
  if (preferred && e.channel === preferred) score += 1.5;
  if (e.channel === "email" && !e.verified) score -= 1.5;
  if (e.channel === "email") {
    score += rankEmailScore(e.handle, { source: e.source, name: e.name, title: e.title }).bonus;
  }
  return score;
}

/**
 * Highest-confidence / lowest-friction available route.
 * Never invents purchasing@domain.
 */
export function selectChannel(buyerId: number): { endpoint: ChannelEndpoint; score: number; reason: string } | null {
  const buyer = db().prepare("SELECT outreach_channel FROM buyers WHERE id=?").get(buyerId) as { outreach_channel: string } | undefined;
  const preferred = buyer?.outreach_channel && buyer.outreach_channel !== "unknown" ? buyer.outreach_channel : undefined;
  const endpoints = listEndpoints(buyerId);
  if (!endpoints.length) return null;

  const ranked = endpoints
    .map((e) => ({ endpoint: e, score: scoreEndpoint(e, preferred) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const quality = best.endpoint.channel === "email"
    ? rankEmailScore(best.endpoint.handle, { source: best.endpoint.source, name: best.endpoint.name, title: best.endpoint.title }).quality
    : best.endpoint.channel;
  const reason = preferred && best.endpoint.channel === preferred
    ? `preferred ${preferred} available`
    : `${best.endpoint.channel} ${quality} score ${best.score.toFixed(2)} (verified=${best.endpoint.verified})`;
  return { ...best, reason };
}
