import { db } from "./db";

export const LIVE_DAILY_CAP = 20;
export const LIVE_DOMAIN_CAP = 2;

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
  dailyRemaining: number;
  dailyCap: number;
  domainUsed: number | null;
  domainRemaining: number | null;
  domainCap: number;
} {
  const dailyUsed = liveSentToday();
  const domainUsed = domain ? liveSentToDomainToday(domain) : null;
  return {
    dailyUsed,
    dailyRemaining: Math.max(0, LIVE_DAILY_CAP - dailyUsed),
    dailyCap: LIVE_DAILY_CAP,
    domainUsed,
    domainRemaining: domainUsed == null ? null : Math.max(0, LIVE_DOMAIN_CAP - domainUsed),
    domainCap: LIVE_DOMAIN_CAP,
  };
}
