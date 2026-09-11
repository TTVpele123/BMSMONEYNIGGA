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

export function suppressedDomainSet(): Set<string> {
  const rows = db().prepare("SELECT address_or_domain FROM suppressions").all() as { address_or_domain: string }[];
  return new Set(rows.map((r) => r.address_or_domain.toLowerCase()));
}
