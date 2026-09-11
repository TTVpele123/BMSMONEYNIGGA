import { db } from "./db";
import { addrOf, isSuppressed } from "./suppression";

export type LedgerStatus = "eligible" | "queued" | "sent_once" | "replied_manual_only" | "suppressed" | "bounced" | "opted_out";

export function assertEligible(email: string, lotId: number): { eligible: boolean; reason: string } {
  const e = addrOf(email);
  const sup = isSuppressed(e);
  if (sup.suppressed) return { eligible: false, reason: `suppressed (${sup.matched})` };

  const inbound = db().prepare(
    "SELECT id FROM inbound_events WHERE lower(from_address) LIKE '%'||?||'%' LIMIT 1"
  ).get(e) as { id: number } | undefined;
  if (inbound) return { eligible: false, reason: `replied_manual_only: inbound ${inbound.id}` };

  const row = db().prepare(
    "SELECT status FROM outreach_ledger WHERE contact_email=? AND lot_id=?"
  ).get(e, lotId) as { status: LedgerStatus } | undefined;
  if (row && row.status !== "eligible" && row.status !== "queued") {
    return { eligible: false, reason: `one-touch: already ${row.status} for lot ${lotId}` };
  }
  return { eligible: true, reason: "no prior touch" };
}

export function reserveQueued(email: string, lotId: number, buyerId: number): { eligible: boolean; reason: string } {
  const gate = assertEligible(email, lotId);
  if (!gate.eligible) return gate;
  db().prepare(
    `INSERT INTO outreach_ledger(contact_email,lot_id,buyer_id,status) VALUES(?,?,?,'queued')
     ON CONFLICT(contact_email,lot_id) DO UPDATE SET status='queued', updated_at=datetime('now')`
  ).run(addrOf(email), lotId, buyerId);
  return { eligible: true, reason: "reserved" };
}

export function recordSend(email: string, lotId: number, buyerId: number): void {
  db().prepare(
    `INSERT INTO outreach_ledger(contact_email,lot_id,buyer_id,status) VALUES(?,?,?,'sent_once')
     ON CONFLICT(contact_email,lot_id) DO UPDATE SET status='sent_once', updated_at=datetime('now')`
  ).run(addrOf(email), lotId, buyerId);
}

export function markReplied(email: string, buyerId?: number): void {
  db().prepare(
    `UPDATE outreach_ledger SET status='replied_manual_only', updated_at=datetime('now')
     WHERE (contact_email=? OR (? IS NOT NULL AND buyer_id=?))
       AND status NOT IN ('opted_out','suppressed','bounced')`
  ).run(addrOf(email), buyerId ?? null, buyerId ?? null);
}
