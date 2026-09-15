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

function buyerContactEmails(buyerId: number): string[] {
  const contacts = db().prepare(
    "SELECT email FROM buyer_contacts WHERE buyer_id=? AND email IS NOT NULL AND trim(email)!=''"
  ).all(buyerId) as Array<{ email: string }>;
  const endpoints = db().prepare(
    "SELECT handle FROM buyer_channel_endpoints WHERE buyer_id=? AND channel='email' AND handle IS NOT NULL AND trim(handle)!=''"
  ).all(buyerId) as Array<{ handle: string }>;
  return [...new Set([...contacts.map((r) => r.email), ...endpoints.map((r) => r.handle)].map(addrOf))];
}

/** Cross-channel one-touch: a confirmed send or terminal reply on this buyer+lot — or the same contact email+lot — blocks every adapter. */
export function buyerLotAlreadyTouched(buyerId: number, lotIds: number[]): { touched: boolean; reason: string } {
  for (const lotId of lotIds) {
    const row = db().prepare(
      `SELECT status FROM outreach_ledger
        WHERE buyer_id=? AND lot_id=?
          AND status IN ('sent_once','replied_manual_only','opted_out','suppressed')
        LIMIT 1`
    ).get(buyerId, lotId) as { status: LedgerStatus } | undefined;
    if (row) return { touched: true, reason: `one-touch: ${row.status} for lot ${lotId}` };
  }
  const emails = buyerContactEmails(buyerId);
  if (emails.length) {
    for (const lotId of lotIds) {
      const row = db().prepare(
        `SELECT status FROM outreach_ledger
          WHERE contact_email IN (${emails.map(() => "?").join(",")}) AND lot_id=?
            AND status IN ('sent_once','replied_manual_only','opted_out','suppressed')
          LIMIT 1`
      ).get(...emails, lotId) as { status: LedgerStatus } | undefined;
      if (row) return { touched: true, reason: `one-touch: already ${row.status} for lot ${lotId}` };
    }
  }
  const sent = db().prepare(
    "SELECT channel, lot_ids FROM outreach_attempts WHERE buyer_id=? AND status='sent'"
  ).all(buyerId) as Array<{ channel: string; lot_ids: string }>;
  for (const row of sent) {
    let ids: number[] = [];
    try { ids = JSON.parse(row.lot_ids) as number[]; } catch { ids = []; }
    const hit = ids.find((id) => lotIds.includes(id));
    if (hit != null) return { touched: true, reason: `one-touch: ${row.channel} already sent lot ${hit}` };
  }
  return { touched: false, reason: "" };
}

/** One-touch is contact-email+lot and buyer+lot. A hoodie send must not block a later drill send. */
export function untouchedLotIds(buyerId: number, lotIds: number[]): number[] {
  return lotIds.filter((id) => !buyerLotAlreadyTouched(buyerId, [id]).touched);
}

/** Address-terminal. Does not one-touch the buyer+lot — form may still run once. */
export function markBounced(email: string): void {
  db().prepare(
    `UPDATE outreach_ledger SET status='bounced', updated_at=datetime('now')
     WHERE contact_email=? AND status NOT IN ('opted_out','suppressed')`
  ).run(addrOf(email));
}

export function markReplied(email: string, buyerId?: number): void {
  db().prepare(
    `UPDATE outreach_ledger SET status='replied_manual_only', updated_at=datetime('now')
     WHERE (contact_email=? OR (? IS NOT NULL AND buyer_id=?))
       AND status NOT IN ('opted_out','suppressed','bounced')`
  ).run(addrOf(email), buyerId ?? null, buyerId ?? null);
}
