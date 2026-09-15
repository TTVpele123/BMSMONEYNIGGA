import { db } from "./db";

/** No artificial daily volume target. Null = uncapped by launch quota. */
export const LIVE_DAILY_CAP: number | null = null;
/** Deliverability safeguard: max confirmed live first-touch sends per buyer domain per rolling 24h. */
export const LIVE_DOMAIN_CAP = 4;

export function liveSentToday(): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM outreach_attempts
     WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''
       AND created_at >= datetime('now','-1 day')`
  ).get() as { n: number };
  return row.n;
}

export function liveSentToDomainToday(domain: string): number {
  const row = db().prepare(
    `SELECT COUNT(*) AS n FROM outreach_attempts oa
     JOIN buyers b ON b.id=oa.buyer_id
     WHERE b.domain=? AND oa.status='sent' AND oa.provider_message_id IS NOT NULL AND trim(oa.provider_message_id)!=''
       AND oa.created_at >= datetime('now','-1 day')`
  ).get(domain) as { n: number };
  return row.n;
}

export function liveSendCapacity(domain?: string): {
  dailyUsed: number;
  dailyRemaining: number | null;
  dailyCap: number | null;
  domainUsed: number | null;
  domainRemaining: number | null;
  domainCap: number;
} {
  const dailyUsed = liveSentToday();
  const domainUsed = domain ? liveSentToDomainToday(domain) : null;
  return {
    dailyUsed,
    dailyRemaining: LIVE_DAILY_CAP == null ? null : Math.max(0, LIVE_DAILY_CAP - dailyUsed),
    dailyCap: LIVE_DAILY_CAP,
    domainUsed,
    domainRemaining: domainUsed == null ? null : Math.max(0, LIVE_DOMAIN_CAP - domainUsed),
    domainCap: LIVE_DOMAIN_CAP,
  };
}
