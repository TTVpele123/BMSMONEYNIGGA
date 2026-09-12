import { audit, db } from "./db";
import { lotHasSendableMedia } from "./email/attachments";

export function isCapacityReason(reason: string | null | undefined): boolean {
  return /^(daily cap|domain cap)\b/i.test((reason ?? "").trim());
}

/** Only the stale permanent daily-cap blocks. Domain-cap and other blocks are left alone. */
export function repairStaleDailyCapBlocks(): { repaired: number } {
  const rows = db().prepare(
    "SELECT id FROM outreach_attempts WHERE status='blocked' AND reason='daily cap'"
  ).all() as { id: number }[];
  if (!rows.length) return { repaired: 0 };
  const ids = rows.map((r) => r.id);
  db().prepare(
    `UPDATE outreach_attempts SET status='failed', reason='daily cap (retryable)'
     WHERE status='blocked' AND reason='daily cap'`
  ).run();
  db().prepare(
    `UPDATE opportunities SET reason='capacity retryable', updated_at=datetime('now')
     WHERE reason='already blocked'`
  ).run();
  audit("repair", "stale_daily_cap_unblocked", { detail: { repaired: ids.length, attemptIds: ids } });
  return { repaired: ids.length };
}

export function pauseLotsMissingOriginalMedia(): { paused: number; eligible: number; skippedSold: number } {
  const lots = db().prepare(
    "SELECT id, state, availability, project_gate FROM lots"
  ).all() as { id: number; state: string; availability: string; project_gate: string }[];
  let paused = 0;
  let eligible = 0;
  let skippedSold = 0;
  for (const lot of lots) {
    if (lotHasSendableMedia(lot.id)) {
      eligible += 1;
      continue;
    }
    if (lot.state === "sold" || lot.state === "archived" || lot.availability === "sold") {
      skippedSold += 1;
      continue;
    }
    if (lot.state === "paused" && lot.project_gate === "DO_NOT_MARKET" && lot.availability !== "active") continue;
    const availability = lot.availability === "active" ? "paused" : lot.availability;
    db().prepare(
      `UPDATE lots SET state='paused', project_gate='DO_NOT_MARKET', availability=?, updated_at=datetime('now')
       WHERE id=? AND state NOT IN ('sold','archived')`
    ).run(availability, lot.id);
    paused += 1;
  }
  if (paused) audit("repair", "paused_media_less_lots", { detail: { paused, eligible, skippedSold } });
  return { paused, eligible, skippedSold };
}

export function restoreLotIfEligible(lotId: number): boolean {
  if (!lotHasSendableMedia(lotId)) return false;
  db().prepare(
    `UPDATE lots SET state='matchable', availability='active', project_gate='AMBER', updated_at=datetime('now')
     WHERE id=? AND (state='paused' OR project_gate='DO_NOT_MARKET' OR availability='paused')`
  ).run(lotId);
  return true;
}

/** Unconfirmed `sent` rows stay in the audit log but do not consume live caps. */
export function repairUnconfirmedSentAccounting(): { unconfirmedSent: number; confirmedSent: number } {
  const unconfirmed = db().prepare(
    "SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent' AND (provider_message_id IS NULL OR trim(provider_message_id)='')"
  ).get() as { n: number };
  const confirmed = db().prepare(
    "SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''"
  ).get() as { n: number };
  if (unconfirmed.n) {
    audit("repair", "unconfirmed_sent_excluded_from_caps", {
      detail: { unconfirmedSent: unconfirmed.n, confirmedSent: confirmed.n },
    });
  }
  return { unconfirmedSent: unconfirmed.n, confirmedSent: confirmed.n };
}

export function applyP0Repairs(): { caps: { repaired: number }; media: { paused: number; eligible: number; skippedSold: number }; accounting: { unconfirmedSent: number; confirmedSent: number } } {
  return {
    caps: repairStaleDailyCapBlocks(),
    media: pauseLotsMissingOriginalMedia(),
    accounting: repairUnconfirmedSentAccounting(),
  };
}
