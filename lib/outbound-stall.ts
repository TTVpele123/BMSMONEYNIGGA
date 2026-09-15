import { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSentToDomainToday, liveSentToday } from "./caps";
import { selectOutreachChannels } from "./channels/select";
import { audit, db, killSwitchOn, outboundMode } from "./db";
import { gmailConfigured } from "./email/provider";
import { untouchedLotIds } from "./ledger";
import { lotEligibleForResearch } from "./research";
import { isSuppressed } from "./suppression";

export const STALL_MINUTES = 15;

export type OutboundWatchdog = {
  lastConfirmedSendAt: string | null;
  minutesSinceLastConfirmedSend: number | null;
  eligibleUntouchedBuyerCount: number;
  emailSendableBuyerCount: number;
  eligibleActiveLotCount: number;
  pendingMatchCount: number;
  outbound_stalled: boolean;
  stall_reason: string | null;
};

function parseDbUtc(ts: string): number {
  return Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

function minutesSince(ts: string): number {
  return (Date.now() - parseDbUtc(ts)) / 60_000;
}

export function lastConfirmedSendAt(): string | null {
  const row = db().prepare(
    `SELECT created_at FROM outreach_attempts
      WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''
      ORDER BY created_at DESC LIMIT 1`
  ).get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function confirmedSendCount(): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM outreach_attempts
      WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''`
  ).get() as { n: number };
  return row.n;
}

export function eligibleActiveLotIds(): number[] {
  const lots = db().prepare(
    `SELECT id FROM lots
      WHERE availability='active'
        AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
        AND state='outreach_active'`
  ).all() as { id: number }[];
  return lots.filter((lot) => lotEligibleForResearch(lot.id)).map((lot) => lot.id);
}

export function pendingMatchCount(): number {
  const row = db().prepare(
    "SELECT COUNT(*) AS n FROM events WHERE processed_at IS NULL AND type='match.requested'"
  ).get() as { n: number };
  return row.n;
}

function buyerFitsActiveLots(buyerId: number, lotIds: number[]): boolean {
  if (!lotIds.length) return false;
  const scored = db().prepare(
    `SELECT COUNT(*) AS n FROM match_scores WHERE lot_id IN (${lotIds.map(() => "?").join(",")})`
  ).get(...lotIds) as { n: number };
  if (scored.n === 0) return true;
  const hit = db().prepare(
    `SELECT 1 AS ok FROM match_scores
      WHERE buyer_id=? AND lot_id IN (${lotIds.map(() => "?").join(",")})
        AND score>=0.45 AND hard_disqualified IS NULL
      LIMIT 1`
  ).get(buyerId, ...lotIds) as { ok: number } | undefined;
  return Boolean(hit);
}

function buyerSendableWithoutSafetyBlock(buyerId: number, domain: string, lotIds: number[]): { any: boolean; email: boolean } {
  if (isSuppressed(domain).suppressed) return { any: false, email: false };
  const convo = db().prepare("SELECT state FROM conversations WHERE buyer_id=?").get(buyerId) as { state: string } | undefined;
  if (convo && ["replied", "qualified", "escalated", "suppressed"].includes(convo.state)) return { any: false, email: false };
  const openLots = untouchedLotIds(buyerId, lotIds);
  if (!openLots.length) return { any: false, email: false };
  if (!buyerFitsActiveLots(buyerId, openLots)) return { any: false, email: false };
  const channels = selectOutreachChannels(buyerId);
  if (!channels.length) return { any: false, email: false };
  const hasEmail = channels.some((c) => c.endpoint.channel === "email");
  const emailSendable = hasEmail && liveSentToDomainToday(domain) < LIVE_DOMAIN_CAP;
  return { any: true, email: emailSendable };
}

export function countEligibleUntouchedBuyers(lotIds: number[]): { any: number; email: number } {
  if (!lotIds.length) return { any: 0, email: 0 };
  const buyers = db().prepare(
    "SELECT id, domain FROM buyers WHERE disqualified_reason IS NULL"
  ).all() as Array<{ id: number; domain: string }>;
  let any = 0;
  let email = 0;
  for (const buyer of buyers) {
    const gate = buyerSendableWithoutSafetyBlock(buyer.id, buyer.domain, lotIds);
    if (gate.any) any += 1;
    if (gate.email) email += 1;
  }
  return { any, email };
}

function progressBlockReason(lotIds: number[], eligibleBuyers: number, emailSendable: number): string | null {
  if (outboundMode() !== "live") return "outbound_mode_not_live";
  if (killSwitchOn()) return "kill_switch";
  if (!gmailConfigured()) return "gmail_not_connected";
  if (!lotIds.length) return "no_eligible_active_lots";
  if (LIVE_DAILY_CAP != null && liveSentToday() >= LIVE_DAILY_CAP) return `daily_cap_${LIVE_DAILY_CAP}`;
  if (emailSendable <= 0 && eligibleBuyers > 0) return "no_email_sendable_buyers";
  if (eligibleBuyers <= 0) return "no_eligible_untouched_buyers";
  return null;
}

function quietLongEnough(lastSend: string | null, lotIds: number[]): boolean {
  if (lastSend) return minutesSince(lastSend) >= STALL_MINUTES;
  if (!lotIds.length) return false;
  const row = db().prepare(
    `SELECT MIN(updated_at) AS t FROM lots WHERE id IN (${lotIds.map(() => "?").join(",")})`
  ).get(...lotIds) as { t: string | null };
  return row.t ? minutesSince(row.t) >= STALL_MINUTES : false;
}

/** Read-only: whether live outbound should be moving, and whether it has gone quiet. */
export function assessOutboundProgress(): OutboundWatchdog {
  const lastSend = lastConfirmedSendAt();
  const lotIds = eligibleActiveLotIds();
  const eligible = countEligibleUntouchedBuyers(lotIds);
  const pending = pendingMatchCount();
  const block = progressBlockReason(lotIds, eligible.any, eligible.email);
  const stalled = block == null && quietLongEnough(lastSend, lotIds);
  return {
    lastConfirmedSendAt: lastSend,
    minutesSinceLastConfirmedSend: lastSend ? Number(minutesSince(lastSend).toFixed(1)) : null,
    eligibleUntouchedBuyerCount: eligible.any,
    emailSendableBuyerCount: eligible.email,
    eligibleActiveLotCount: lotIds.length,
    pendingMatchCount: pending,
    outbound_stalled: stalled,
    stall_reason: stalled ? (lastSend ? "no_confirmed_send_15m" : "never_confirmed_send") : block,
  };
}

export type StallRecovery = {
  snapshot: OutboundWatchdog;
  rematch: number;
  processed: number;
  sendVerified: boolean;
  after: OutboundWatchdog;
};

export async function recoverIfOutboundStalled(fns: {
  rematch: () => number;
  process: () => Promise<{ processed: number; failed: number }>;
}): Promise<StallRecovery | null> {
  const snapshot = assessOutboundProgress();
  if (!snapshot.outbound_stalled) return null;

  audit("orchestrator", "outbound_stall", {
    ok: false,
    detail: snapshot,
  });

  const beforeCount = confirmedSendCount();
  const rematch = fns.rematch();
  const orch = await fns.process();
  const after = assessOutboundProgress();
  const sendVerified = confirmedSendCount() > beforeCount;

  audit("orchestrator", sendVerified ? "outbound_stall_recovered" : "outbound_stall_rematch_no_send", {
    ok: sendVerified,
    detail: { rematch, processed: orch.processed, failed: orch.failed, sendVerified, after },
  });

  return { snapshot, rematch, processed: orch.processed, sendVerified, after };
}
