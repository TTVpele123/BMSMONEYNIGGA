import { db } from "./db";

const CONSUMER = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|protonmail)\./i;

export function addrOf(s: string): string {
  return (s.match(/[\w.+-]+@[\w.-]+/)?.[0] ?? s).toLowerCase();
}

export function domainOf(addr: string): string {
  return addrOf(addr).split("@")[1] ?? "";
}

export function isSuppressed(emailOrDomain: string): { suppressed: boolean; reason?: string; matched?: string } {
  const addr = addrOf(emailOrDomain);
  const domain = domainOf(addr) || addr;
  const row = db().prepare(
    "SELECT address_or_domain, reason FROM suppressions WHERE address_or_domain IN (?, ?)"
  ).get(addr, domain) as { address_or_domain: string; reason: string } | undefined;
  return row ? { suppressed: true, reason: row.reason, matched: row.address_or_domain } : { suppressed: false };
}

export function writeUnsubscribe(fromAddr: string): void {
  const addr = addrOf(fromAddr);
  const domain = domainOf(addr);
  const insert = db().prepare(
    "INSERT INTO suppressions(address_or_domain,reason,source) VALUES(?,?,?) ON CONFLICT(address_or_domain) DO NOTHING"
  );
  insert.run(addr, "unsubscribe request", "inbound");
  if (domain && !CONSUMER.test(domain)) {
    insert.run(domain, "unsubscribe request — domain", "inbound");
  }
}

export function writeBounce(address: string): void {
  db().prepare(
    "INSERT INTO suppressions(address_or_domain,reason,source) VALUES(?,?,?) ON CONFLICT(address_or_domain) DO NOTHING"
  ).run(addrOf(address), "hard bounce — address only", "bounce");
}

/** Hard-bounced address: suppression row or buyer_contacts.verification='bounced'. Never retry. */
export function isDeadInbox(emailOrDomain: string): boolean {
  const addr = addrOf(emailOrDomain);
  if (!addr.includes("@")) return isSuppressed(addr).suppressed;
  if (isSuppressed(addr).suppressed) return true;
  const row = db().prepare(
    "SELECT 1 AS ok FROM buyer_contacts WHERE lower(email)=lower(?) AND verification='bounced' LIMIT 1"
  ).get(addr) as { ok: number } | undefined;
  return Boolean(row);
}

/** Drop leftover email endpoints that match a dead inbox so matching cannot re-select them. */
export function purgeDeadInboxEndpoints(): number {
  const info = db().prepare(
    `DELETE FROM buyer_channel_endpoints
      WHERE channel='email'
        AND (
          lower(handle) IN (SELECT lower(email) FROM buyer_contacts WHERE verification='bounced' AND email IS NOT NULL)
          OR lower(handle) IN (SELECT lower(address_or_domain) FROM suppressions WHERE source='bounce')
        )`
  ).run();
  return info.changes;
}

export function suppressedDomainSet(): Set<string> {
  const rows = db().prepare("SELECT address_or_domain FROM suppressions").all() as { address_or_domain: string }[];
  return new Set(rows.map((r) => r.address_or_domain.toLowerCase()));
}
