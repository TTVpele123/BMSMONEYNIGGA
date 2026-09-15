import { buyerAuthoredReply, looksLikeAutoAck, type ReplyAnalysisT } from "./classify";
import { audit, db, killSwitchOn, outboundMode } from "./db";
import { AUTHORIZED_SENDER } from "./email/address";
import { sendAuthorizedEmail } from "./email/provider";
import { buyerFacingTitle } from "./email/template";
import { lotsForEscalation, photosForLots } from "./escalate";
import { enqueueGrokJob } from "./research";
import { recordQualityOutcome, sourceForEmail } from "./targeting";

const PHONE_ASK = "What's the best phone number to reach you at?";

export type VerifiedLotFacts = {
  id: number;
  title: string;
  quantity: number | null;
  unitPrice: number | null;
  brand: string | null;
  extra: Record<string, string>;
};

export function loadVerifiedLotFacts(lotIds: number[]): VerifiedLotFacts[] {
  if (!lotIds.length) return [];
  const lots = db().prepare(
    `SELECT id, title, category, quantity, unit_price, brand FROM lots WHERE id IN (${lotIds.map(() => "?").join(",")})`
  ).all(...lotIds) as Array<{
    id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null;
  }>;
  return lots.map((lot) => {
    const extra: Record<string, string> = {};
    const rows = db().prepare("SELECT key, value FROM lot_facts WHERE lot_id=? AND fabricated=0").all(lot.id) as Array<{ key: string; value: string }>;
    for (const row of rows) {
      if (row.key && row.value) extra[row.key.toLowerCase()] = row.value;
    }
    return {
      id: lot.id,
      title: buyerFacingTitle(lot),
      quantity: lot.quantity,
      unitPrice: lot.unit_price,
      brand: lot.brand,
      extra,
    };
  });
}

function asked(text: string, re: RegExp): boolean {
  return re.test(text);
}

export function answerFromVerified(question: string, lots: VerifiedLotFacts[]): { answered: string[]; missing: string[] } {
  const q = question.toLowerCase();
  const answered: string[] = [];
  const missing: string[] = [];
  const first = lots[0];
  if (!first) return { answered, missing: ["lot details"] };

  const qty = first.quantity ?? (first.extra.quantity ? Number(first.extra.quantity) : null);
  if (asked(q, /price|unit|cost|how much|asking/)) {
    if (first.unitPrice != null && first.unitPrice > 0) answered.push(`Asking price is $${first.unitPrice}/unit.`);
    else missing.push("unit price");
  }
  if (asked(q, /how many|quantity|qty|units|8000|hoodies/)) {
    if (qty != null && Number.isFinite(qty) && qty > 0) answered.push(`Quantity is ${qty.toLocaleString()} units.`);
    else missing.push("quantity");
  }
  if (asked(q, /brand/)) {
    if (first.brand?.trim()) answered.push(`Brand is ${first.brand.trim()}.`);
    else missing.push("brand");
  }
  if (asked(q, /fabric|composition|cotton|poly|gsm|oz\/|weight/)) {
    const fact = first.extra.fabric || first.extra.composition || first.extra.gsm || first.extra.weight;
    if (fact) answered.push(`Fabric/composition: ${fact}.`);
    else missing.push("fabric composition / GSM");
  }
  if (asked(q, /size break|sizes?|pre-?pack|packed/)) {
    const fact = first.extra.sizes || first.extra.size_breakdown || first.extra.prepack || first.extra.packed;
    if (fact) answered.push(`Pack/size detail: ${fact}.`);
    else missing.push("size breakdown / pre-pack");
  }
  return { answered, missing: [...new Set(missing)] };
}

export function composeWarmReply(input: {
  company: string;
  subject: string;
  answered: string[];
  missing: string[];
  alreadyHasPhone: boolean;
}): { subject: string; body: string } | null {
  if (input.alreadyHasPhone) return null;
  const lines = [
    `Hi ${input.company} team,`,
    "",
    "Thanks for the reply.",
  ];
  if (input.answered.length) {
    lines.push("", ...input.answered);
  }
  if (input.missing.length) {
    lines.push("", `I don't have verified ${input.missing.join(", ")} on this lot, so I won't guess.`);
  }
  lines.push("", PHONE_ASK, "", "Bailey Saevitzon", "Saefam Overstock", "818-406-8612", AUTHORIZED_SENDER);
  return { subject: input.subject, body: lines.join("\n") };
}

export function conversationLotIds(conversationId: number | null, buyerId: number): number[] {
  return lotsForEscalation(conversationId, buyerId).map((l) => l.id);
}

function lastSubject(buyerId: number, lots: VerifiedLotFacts[]): string {
  const prior = db().prepare(
    "SELECT subject FROM outreach_attempts WHERE buyer_id=? AND subject IS NOT NULL AND trim(subject)!='' ORDER BY id DESC LIMIT 1"
  ).get(buyerId) as { subject: string } | undefined;
  const base = prior?.subject?.replace(/^re:\s*/i, "") || `Wholesale availability — ${lots.map((l) => l.title).join(" / ") || "Available Inventory"}`;
  return `Re: ${base}`.slice(0, 140);
}

export function shouldSendWarmReply(analysis: ReplyAnalysisT, raw: string): boolean {
  if (["bounce", "send_limit", "out_of_office", "unsubscribe", "suspicious", "not_interested"].includes(analysis.classification)) return false;
  if (looksLikeAutoAck(raw) && !/\?/.test(buyerAuthoredReply(raw))) return false;
  if (analysis.phone) return false;
  return true;
}

export function queueOliverHandoff(input: { escalationId: number; packet: string; phone: string }): number {
  const key = `oliver_handoff:${input.escalationId}`;
  const esc = db().prepare("SELECT id, state, lot_ids FROM escalations WHERE id=?").get(input.escalationId) as
    | { id: number; state: string; lot_ids: string }
    | undefined;
  if (!esc) return 0;
  const existing = db().prepare(
    "SELECT id, state FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND instruction LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(`%${key}%`) as { id: number; state: string } | undefined;
  // One-shot: already handed or already successfully sent — never queue a second Oliver message.
  if (esc.state === "handed_to_oliver" || existing?.state === "done") return existing?.id ?? 0;
  const lotIds = (() => {
    try { return JSON.parse(esc.lot_ids) as number[]; } catch { return []; }
  })();
  const payload = { ...input, photos: photosForLots(lotIds) };
  if (existing) {
    if (existing.state === "claimed") return existing.id;
    db().prepare(
      "UPDATE grok_jobs SET input=?, state='queued', claimed_at=NULL, result=NULL, finished_at=NULL WHERE id=? AND state IN ('queued','failed')"
    ).run(JSON.stringify(payload), existing.id);
    return existing.id;
  }
  const jobId = enqueueGrokJob(
    "INBOUND_ANALYST",
    `Send this to Oliver on WhatsApp as one message: name, phone, and product only. Attach the listed original lot photos if present. Do not add facts. Do not message anyone else. ${key}`,
    payload,
  );
  const contact = db().prepare(
    `SELECT o.selected_handle AS handle, c.contact_email AS email
       FROM escalations e
       LEFT JOIN opportunities o ON o.buyer_id=e.buyer_id
       LEFT JOIN conversations c ON c.buyer_id=e.buyer_id
      WHERE e.id=?
      ORDER BY o.id DESC LIMIT 1`
  ).get(input.escalationId) as { handle: string | null; email: string | null } | undefined;
  const target = contact?.handle || contact?.email;
  if (target) recordQualityOutcome(target, "oliver_handoff", { source: sourceForEmail(target) });
  return jobId;
}

export function applyOliverHandoffResult(jobId: number, ok: boolean): void {
  if (!ok) return;
  const job = db().prepare("SELECT input FROM grok_jobs WHERE id=?").get(jobId) as { input: string } | undefined;
  let escalationId: number | undefined;
  try { escalationId = (JSON.parse(job?.input ?? "{}") as { escalationId?: number }).escalationId; } catch { return; }
  if (!escalationId) return;
  db().prepare("UPDATE escalations SET state='handed_to_oliver' WHERE id=? AND state='open'").run(escalationId);
  audit("inbound", "handed_to_oliver", { entityType: "escalations", entityId: escalationId });
}

export async function sendWarmReply(input: {
  inboundId: number;
  conversationId: number;
  buyerId: number;
  email: string;
  company: string;
  domain: string;
  question: string;
  alreadyHasPhone: boolean;
}): Promise<{ sent: boolean; reason: string }> {
  const convo = db().prepare("SELECT state FROM conversations WHERE id=?").get(input.conversationId) as { state: string } | undefined;
  if (convo && ["escalated", "suppressed", "closed"].includes(convo.state)) {
    return { sent: false, reason: "conversation already handed to Oliver" };
  }
  const key = `warm-reply:${input.inboundId}`;
  const existing = db().prepare("SELECT id, status FROM outreach_attempts WHERE idempotency_key=?").get(key) as { id: number; status: string } | undefined;
  if (existing) return { sent: false, reason: `already ${existing.status}` };

  const lotIds = conversationLotIds(input.conversationId, input.buyerId);
  const lots = loadVerifiedLotFacts(lotIds);
  const { answered, missing } = answerFromVerified(input.question, lots);
  const composed = composeWarmReply({
    company: input.company,
    subject: lastSubject(input.buyerId, lots),
    answered,
    missing,
    alreadyHasPhone: input.alreadyHasPhone,
  });
  if (!composed) return { sent: false, reason: "phone already captured — no ask" };

  const info = db().prepare(
    `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
     VALUES(?,?,?,?,?,?,?,'dry_run',?,?)`
  ).run(
    input.conversationId, input.buyerId, "email", JSON.stringify(lotIds),
    composed.subject, composed.body, "[]", "warm inbound reply", key,
  );
  const attemptId = Number(info.lastInsertRowid);

  if (killSwitchOn()) {
    db().prepare("UPDATE outreach_attempts SET status='blocked', reason='kill switch' WHERE id=?").run(attemptId);
    return { sent: false, reason: "kill switch" };
  }
  if (outboundMode() !== "live") {
    audit("inbound", "warm_reply_dry_run", { entityType: "outreach_attempts", entityId: attemptId });
    return { sent: false, reason: "dry_run — not sent" };
  }

  const sent = await sendAuthorizedEmail({
    to: input.email,
    subject: composed.subject,
    body: composed.body,
    attachments: [],
    lotIds,
    domain: input.domain,
  });
  if (!sent.ok) {
    db().prepare("UPDATE outreach_attempts SET status='failed', reason=? WHERE id=?").run(sent.error, attemptId);
    return { sent: false, reason: sent.error };
  }
  db().prepare(
    "UPDATE outreach_attempts SET status='sent', reason='provider accepted', provider_message_id=?, created_at=datetime('now') WHERE id=?"
  ).run(sent.id, attemptId);
  audit("inbound", "warm_reply_sent", { entityType: "outreach_attempts", entityId: attemptId });
  return { sent: true, reason: "sent" };
}
