import { audit, db } from "./db";
import { buyerAuthoredReply, classifyReply, isHotLead, looksLikeAutoAck, type ReplyAnalysisT } from "./classify";
import { extractFailedRecipient, looksLikeHardBounce, looksLikeSenderLimit } from "./email/bounce";
import { isOurMailbox, parseFromHeader } from "./email/address";
import { noteGmailSenderLimit } from "./email/provider";
import { emit } from "./events";
import { createEscalation } from "./escalate";
import { recordOutcome } from "./learning";
import { markBounced, markReplied } from "./ledger";
import { recordContact } from "./research";
import { writeBounce, writeUnsubscribe } from "./suppression";
import { queueOliverHandoff, sendWarmReply, shouldSendWarmReply } from "./warm-inbound";

function findBuyerForAddress(email: string): { id: number; conversation_id: number | null } | undefined {
  const lookup = parseFromHeader(email);
  const byEndpoint = db().prepare(
    `SELECT b.id, c.id AS conversation_id FROM buyers b
     LEFT JOIN conversations c ON c.buyer_id=b.id
     LEFT JOIN buyer_contacts bc ON bc.buyer_id=b.id
     LEFT JOIN buyer_channel_endpoints ep ON ep.buyer_id=b.id AND ep.channel='email'
     WHERE lower(bc.email)=lower(?) OR lower(ep.handle)=lower(?)
     LIMIT 1`
  ).get(lookup, lookup) as { id: number; conversation_id: number | null } | undefined;
  if (byEndpoint) return byEndpoint;
  return db().prepare(
    `SELECT b.id, c.id AS conversation_id FROM inbound_events ie
     JOIN buyers b ON b.id=ie.buyer_id
     LEFT JOIN conversations c ON c.buyer_id=b.id
     WHERE lower(ie.from_address)=lower(?) AND ie.buyer_id IS NOT NULL
     ORDER BY ie.id DESC LIMIT 1`
  ).get(lookup) as { id: number; conversation_id: number | null } | undefined;
}

const CONSUMER_DOMAIN = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|protonmail|proton|me|msn|zendesk)\./i;

function quotedRecipientEmails(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.matchAll(/^(?:To|Cc|An|À|Para):\s*(.+)$/gim)) {
    const emails = line[1].match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
    for (const email of emails) {
      const lower = email.toLowerCase();
      if (!isOurMailbox(lower) && !out.includes(lower)) out.push(lower);
    }
  }
  return out;
}

function findBuyerForFromDomain(from: string): { id: number; conversation_id: number | null } | undefined {
  const domain = parseFromHeader(from).split("@")[1] ?? "";
  if (!domain || CONSUMER_DOMAIN.test(domain)) return undefined;
  return db().prepare(
    `SELECT b.id, c.id AS conversation_id FROM buyers b
     LEFT JOIN conversations c ON c.buyer_id=b.id
     WHERE lower(b.domain)=lower(?)
     LIMIT 1`
  ).get(domain) as { id: number; conversation_id: number | null } | undefined;
}

/** From-address first; colleague/personal replies fall back to quoted To:/Cc: then company domain. */
function findBuyerForInbound(from: string, raw: string): { id: number; conversation_id: number | null } | undefined {
  const direct = findBuyerForAddress(from);
  if (direct) return direct;
  for (const email of quotedRecipientEmails(raw)) {
    const hit = findBuyerForAddress(email);
    if (hit) return hit;
  }
  return findBuyerForFromDomain(from);
}

export async function processInbound(input: {
  from: string;
  text: string;
  providerMessageId?: string;
  bounced?: boolean;
  mailbox?: string;
}): Promise<{ ok: true; classification: string; conversationId: number | null; escalated: boolean; replied: boolean }> {
  const from = parseFromHeader(input.from);
  const existing = input.providerMessageId
    ? db().prepare("SELECT id FROM inbound_events WHERE provider_message_id=?").get(input.providerMessageId)
    : null;
  if (existing) {
    if (input.bounced) {
      const bounceEmail = extractFailedRecipient(input.text, from);
      if (bounceEmail) suppressBouncedAddress(bounceEmail);
    }
    return { ok: true, classification: "duplicate", conversationId: null, escalated: false, replied: false };
  }

  const analysis = classifyReply(input.text, { bounced: input.bounced });
  const bounceHint = (input.bounced || analysis.classification === "bounce")
    ? extractFailedRecipient(input.text, from)
    : null;
  const lookup = bounceHint ?? from;
  const buyer = findBuyerForInbound(lookup, input.text);

  const info = db().prepare(
    `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,provider_message_id,classification,interest_level,phone,quantity,price,raw_text)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    buyer?.conversation_id ?? null,
    buyer?.id ?? null,
    bounceHint ?? from,
    input.providerMessageId ?? null,
    analysis.classification,
    analysis.interestLevel,
    analysis.phone,
    analysis.targetQuantity,
    analysis.targetPrice,
    input.text,
  );

  if (analysis.classification === "send_limit") {
    noteGmailSenderLimit(45, input.mailbox);
    unconfirmRecentSendFromLimitNotice(input.text, new Date().toISOString().slice(0, 19).replace("T", " "));
  }
  if (analysis.classification === "unsubscribe") writeUnsubscribe(from);
  if (analysis.classification === "bounce" || analysis.classification === "suspicious") {
    const bounceEmail = extractFailedRecipient(input.text, from);
    if (bounceEmail) suppressBouncedAddress(bounceEmail, analysis.classification);
  }
  if (buyer && analysis.phone) {
    recordContact({ buyerId: buyer.id, email: from, phone: analysis.phone, verification: "inbound" });
  }

  if (buyer && !["bounce", "out_of_office"].includes(analysis.classification)) {
    markReplied(from, buyer.id);
    db().prepare("UPDATE conversations SET state='replied', last_inbound_at=datetime('now'), updated_at=datetime('now') WHERE buyer_id=?").run(buyer.id);
    db().prepare(
      "UPDATE opportunities SET stage='response_captured', updated_at=datetime('now') WHERE buyer_id=? AND stage IN ('dry_run','executed','deferred','prepared','channel_selected')"
    ).run(buyer.id);
  }

  applyLearning(buyer?.id, analysis);

  let escalated = false;
  const inboundId = Number(info.lastInsertRowid);
  const question = buyerAuthoredReply(input.text);
  const autoAck = looksLikeAutoAck(input.text) && !/\?/.test(question);
  let replied = false;

  if (buyer && isHotLead(analysis) && !autoAck) {
    const escalationId = createEscalation({
      buyerId: buyer.id,
      conversationId: buyer.conversation_id,
      reason: analysis.phone ? "phone captured" : analysis.classification,
      phone: analysis.phone,
      analysis,
      question,
    });
    const packet = (db().prepare("SELECT packet FROM escalations WHERE id=?").get(escalationId) as { packet: string }).packet;
    if (analysis.phone) queueOliverHandoff({ escalationId, packet, phone: analysis.phone });
    escalated = true;
  } else if (buyer && shouldSendWarmReply(analysis, input.text)) {
    let convoId = buyer.conversation_id;
    if (!convoId) {
      const created = db().prepare(
        "INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'replied','email',?)"
      ).run(buyer.id, from);
      convoId = Number(created.lastInsertRowid);
    }
    const buyerRow = db().prepare("SELECT company, domain FROM buyers WHERE id=?").get(buyer.id) as { company: string; domain: string };
    const warm = await sendWarmReply({
      inboundId,
      conversationId: convoId,
      buyerId: buyer.id,
      email: from,
      company: buyerRow.company,
      domain: buyerRow.domain,
      question,
      alreadyHasPhone: Boolean(analysis.phone),
    });
    replied = warm.sent || warm.reason === "dry_run — not sent";
  }

  emit("inbound.received", { inboundId, classification: analysis.classification }, input.providerMessageId ? `inbound:${input.providerMessageId}` : undefined);
  audit("inbound", "classified", { entityType: "inbound_events", entityId: inboundId, detail: { classification: analysis.classification, escalated, replied } });
  return { ok: true, classification: analysis.classification, conversationId: buyer?.conversation_id ?? null, escalated, replied };
}

export function closeFalseBounceHandoffs(): number {
  return db().prepare(
    "UPDATE escalations SET state='closed' WHERE state='open' AND packet LIKE '%Interest: none / bounce%'"
  ).run().changes;
}

function companyFromSendLimitBody(text: string): string | null {
  const hit = text.match(/Hi (.+?) team/i)?.[1]?.trim();
  return hit || null;
}

/** Gmail said this copy was not sent — do not keep it as a confirmed success. Does not suppress the inbox. */
export function unconfirmRecentSendFromLimitNotice(text: string, dsnAt: string): number {
  const company = companyFromSendLimitBody(text);
  if (!company) return 0;
  const buyer = db().prepare(
    "SELECT id FROM buyers WHERE lower(company)=lower(?) OR lower(domain)=lower(?) LIMIT 1"
  ).get(company, company) as { id: number } | undefined;
  if (!buyer) return 0;
  return db().prepare(
    `UPDATE outreach_attempts
        SET status='failed', reason='gmail send limit — message not sent'
      WHERE buyer_id=? AND status='sent'
        AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''
        AND created_at >= datetime(?, '-15 minutes')
        AND created_at <= datetime(?, '+2 minutes')`
  ).run(buyer.id, dsnAt, dsnAt).changes;
}

/** Reclassify quota DSNs that were stored as recipient bounces. */
export function repairSenderLimitNotices(): { reclassified: number; unconfirmed: number } {
  const rows = db().prepare(
    `SELECT id, raw_text, created_at FROM inbound_events
      WHERE classification IN ('bounce','unknown')
        AND (raw_text LIKE '%reached a limit for sending mail%'
          OR raw_text LIKE '%Your message was not sent%')`
  ).all() as Array<{ id: number; raw_text: string; created_at: string }>;
  let reclassified = 0;
  let unconfirmed = 0;
  for (const row of rows) {
    if (!looksLikeSenderLimit(row.raw_text)) continue;
    db().prepare("UPDATE inbound_events SET classification='send_limit', interest_level='none' WHERE id=?").run(row.id);
    reclassified += 1;
    unconfirmed += unconfirmRecentSendFromLimitNotice(row.raw_text, row.created_at);
  }
  if (reclassified) noteGmailSenderLimit();
  return { reclassified, unconfirmed };
}

function liftFalseBounceSuppress(email: string): void {
  db().prepare(
    "DELETE FROM suppressions WHERE lower(address_or_domain)=lower(?) AND source='bounce'"
  ).run(parseFromHeader(email));
}

function hasOliverHandoffJob(escalationId: number): boolean {
  return Boolean(db().prepare(
    "SELECT id FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND instruction LIKE ?"
  ).get(`%oliver_handoff:${escalationId}%`));
}

function alreadyQueuedOliverHandoff(buyerId: number, phone: string): boolean {
  const rows = db().prepare(
    "SELECT id, phone FROM escalations WHERE buyer_id=? AND state IN ('open','handed_to_oliver')"
  ).all(buyerId) as Array<{ id: number; phone: string | null }>;
  const digits = phone.replace(/\D/g, "");
  return rows.some((r) => (r.phone ?? "").replace(/\D/g, "") === digits && hasOliverHandoffJob(r.id));
}

function queueMissingOpenPhoneJobs(): number {
  const open = db().prepare(
    `SELECT id, buyer_id, phone, packet FROM escalations
      WHERE state='open' AND phone IS NOT NULL AND trim(phone)!=''`
  ).all() as Array<{ id: number; buyer_id: number; phone: string; packet: string }>;
  let n = 0;
  for (const esc of open) {
    if (hasOliverHandoffJob(esc.id) || alreadyQueuedOliverHandoff(esc.buyer_id, esc.phone)) continue;
    const inbound = db().prepare(
      `SELECT from_address, raw_text FROM inbound_events
        WHERE buyer_id=? ORDER BY id DESC LIMIT 1`
    ).get(esc.buyer_id) as { from_address: string; raw_text: string | null } | undefined;
    const raw = inbound?.raw_text ?? "";
    if (looksLikeHardBounce(raw, inbound?.from_address ?? "")) continue;
    if (looksLikeAutoAck(raw) && !/\?/.test(buyerAuthoredReply(raw))) continue;
    const analysis = classifyReply(raw);
    if (!analysis.phone) analysis.phone = esc.phone;
    if (!isHotLead(analysis)) continue;
    queueOliverHandoff({ escalationId: esc.id, packet: esc.packet, phone: esc.phone });
    n += 1;
  }
  return n;
}

/** Re-run phone capture + Oliver queue for replies that were stored unlinked or as false bounces. */
export function continueMissedPhoneHandoffs(limit = 500): number {
  const rows = db().prepare(
    `SELECT id, buyer_id, conversation_id, from_address, classification, phone, raw_text
     FROM inbound_events
     WHERE classification NOT IN ('unsubscribe','send_limit')
     ORDER BY id DESC LIMIT ?`
  ).all(limit) as Array<{
    id: number; buyer_id: number | null; conversation_id: number | null;
    from_address: string; classification: string; phone: string | null; raw_text: string | null;
  }>;
  let n = 0;
  for (const row of rows) {
    if (looksLikeHardBounce(row.raw_text ?? "", row.from_address)) continue;
    const raw = row.raw_text ?? "";
    if (looksLikeAutoAck(raw) && !/\?/.test(buyerAuthoredReply(raw))) continue;
    const analysis = classifyReply(raw);
    const buyer = row.buyer_id
      ? { id: row.buyer_id, conversation_id: row.conversation_id }
      : findBuyerForInbound(row.from_address, raw);
    if (!buyer) continue;
    if (row.classification === "bounce") {
      if (!analysis.phone || !isHotLead(analysis)) continue;
      liftFalseBounceSuppress(row.from_address);
    }
    if (analysis.phone) {
      recordContact({ buyerId: buyer.id, email: row.from_address, phone: analysis.phone, verification: "inbound" });
    }
    db().prepare(
      `UPDATE inbound_events
       SET buyer_id=?, conversation_id=COALESCE(?, conversation_id), classification=?, interest_level=?, phone=COALESCE(?, phone)
       WHERE id=?`
    ).run(buyer.id, buyer.conversation_id, analysis.classification, analysis.interestLevel, analysis.phone, row.id);
    if (!analysis.phone || !isHotLead(analysis)) continue;
    if (alreadyQueuedOliverHandoff(buyer.id, analysis.phone)) continue;
    const question = buyerAuthoredReply(row.raw_text ?? "");
    const escalationId = createEscalation({
      buyerId: buyer.id,
      conversationId: buyer.conversation_id,
      reason: "phone captured",
      phone: analysis.phone,
      analysis,
      question,
    });
    const packet = (db().prepare("SELECT packet FROM escalations WHERE id=?").get(escalationId) as { packet: string }).packet;
    queueOliverHandoff({ escalationId, packet, phone: analysis.phone });
    n += 1;
  }
  return n + queueMissingOpenPhoneJobs();
}

export async function continueUnansweredWarmInbounds(limit = 200): Promise<number> {
  const rows = db().prepare(
    `SELECT id FROM inbound_events
      WHERE buyer_id IS NOT NULL AND conversation_id IS NOT NULL
        AND classification NOT IN ('bounce','send_limit','unsubscribe','suspicious')
      ORDER BY id DESC LIMIT ?`
  ).all(limit) as Array<{ id: number }>;
  let n = 0;
  for (const row of rows) {
    const done = db().prepare("SELECT id, status, reason FROM outreach_attempts WHERE idempotency_key=?").get(`warm-reply:${row.id}`) as { id: number; status: string; reason: string } | undefined;
    if (done?.status === "failed" && /429|rate limit|domain cap|send limit|message not sent/i.test(done.reason ?? "")) {
      db().prepare("DELETE FROM outreach_attempts WHERE id=?").run(done.id);
    } else if (done) {
      continue;
    }
    const result = await continueWarmInbound(row.id);
    if (result.sent || result.reason === "dry_run — not sent") n += 1;
  }
  return n;
}

export async function continueWarmInbound(inboundId: number): Promise<{ sent: boolean; reason: string }> {
  const row = db().prepare(
    "SELECT id, buyer_id, conversation_id, from_address, classification, phone, raw_text FROM inbound_events WHERE id=?"
  ).get(inboundId) as {
    id: number; buyer_id: number | null; conversation_id: number | null; from_address: string;
    classification: string; phone: string | null; raw_text: string;
  } | undefined;
  if (!row?.buyer_id || !row.conversation_id) return { sent: false, reason: "inbound not tied to a buyer conversation" };
  const analysis = classifyReply(row.raw_text);
  if (row.phone || analysis.phone) return { sent: false, reason: "phone already captured — no ask" };
  if (!shouldSendWarmReply(analysis, row.raw_text)) return { sent: false, reason: `not a warm reply (${row.classification})` };
  const buyerRow = db().prepare("SELECT company, domain FROM buyers WHERE id=?").get(row.buyer_id) as { company: string; domain: string };
  return sendWarmReply({
    inboundId: row.id,
    conversationId: row.conversation_id,
    buyerId: row.buyer_id,
    email: row.from_address,
    company: buyerRow.company,
    domain: buyerRow.domain,
    question: buyerAuthoredReply(row.raw_text),
    alreadyHasPhone: Boolean(row.phone || analysis.phone),
  });
}

/** Address-only. Never domain-suppresses. Queues rematch so another real inbox can be tried. */
export function suppressBouncedAddress(email: string, classification = "bounce"): boolean {
  const addr = extractFailedRecipient(email, email);
  if (!addr) return false;
  writeBounce(addr);
  markBounced(addr);
  db().prepare("UPDATE buyer_contacts SET verification='bounced' WHERE lower(email)=lower(?)").run(addr);
  db().prepare("DELETE FROM buyer_channel_endpoints WHERE channel='email' AND lower(handle)=lower(?)").run(addr);
  db().prepare(
    `UPDATE outreach_attempts
     SET status='failed', reason=COALESCE(reason,'') || ' | provider_rejection_or_bounce'
     WHERE status='sent'
       AND (
         lower(idempotency_key) LIKE '%' || lower(?) || '%'
         OR buyer_id IN (SELECT buyer_id FROM buyer_contacts WHERE lower(email)=lower(?))
         OR buyer_id IN (SELECT buyer_id FROM buyer_channel_endpoints WHERE channel='email' AND lower(handle)=lower(?))
       )`
  ).run(addr, addr, addr);
  const buyer = db().prepare(
    `SELECT buyer_id AS id FROM buyer_contacts WHERE lower(email)=lower(?)
     UNION
     SELECT buyer_id AS id FROM buyer_channel_endpoints WHERE channel='email' AND lower(handle)=lower(?)
     LIMIT 1`
  ).get(addr, addr) as { id: number } | undefined;
  if (buyer) {
    const lots = db().prepare(
      `SELECT DISTINCT ms.lot_id AS id FROM match_scores ms
        JOIN lots l ON l.id=ms.lot_id
       WHERE ms.buyer_id=? AND ms.score>=0.45 AND ms.hard_disqualified IS NULL
         AND l.availability='active' AND l.project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
         AND l.state NOT IN ('paused','sold','archived')`
    ).all(buyer.id) as { id: number }[];
    for (const lot of lots) {
      emit("match.requested", { lotId: lot.id }, `match.requested:bounce:${buyer.id}:${lot.id}`);
    }
  }
  audit("inbound", "provider_rejection_suppressed", {
    entityType: "inbound_events",
    detail: { email: addr, classification, rematchLots: buyer ? true : false },
  });
  return true;
}

/** Re-apply address-only suppress from bounce rows already in the DB. */
export function replayStoredBounces(): number {
  const seen = new Set<string>();
  const rows = db().prepare(
    "SELECT from_address, raw_text FROM inbound_events WHERE classification='bounce'"
  ).all() as Array<{ from_address: string; raw_text: string | null }>;
  for (const r of rows) {
    if (looksLikeSenderLimit(r.raw_text ?? "")) continue;
    const addr = extractFailedRecipient(r.raw_text ?? "", r.from_address);
    if (addr && !seen.has(addr) && suppressBouncedAddress(addr)) seen.add(addr);
  }
  const failed = db().prepare(
    `SELECT reason, buyer_id FROM outreach_attempts
     WHERE reason LIKE '%bounce%' OR reason LIKE '%550%' OR reason LIKE '%address not found%' OR reason LIKE '%user unknown%'`
  ).all() as Array<{ reason: string; buyer_id: number }>;
  for (const r of failed) {
    const fromReason = extractFailedRecipient(r.reason, "");
    if (fromReason && !seen.has(fromReason) && suppressBouncedAddress(fromReason)) seen.add(fromReason);
    const led = db().prepare(
      "SELECT contact_email FROM outreach_ledger WHERE buyer_id=? AND status='bounced'"
    ).all(r.buyer_id) as Array<{ contact_email: string }>;
    for (const row of led) {
      const addr = extractFailedRecipient(row.contact_email, row.contact_email);
      if (addr && !seen.has(addr) && suppressBouncedAddress(addr)) seen.add(addr);
    }
  }
  return seen.size;
}

function applyLearning(buyerId: number | undefined, analysis: ReplyAnalysisT): void {
  if (!buyerId) return;
  if (analysis.classification === "not_interested" || analysis.classification === "unsubscribe") {
    recordOutcome(buyerId, "reject");
  } else if (analysis.interestLevel === "high") {
    recordOutcome(buyerId, "reply");
  } else if (analysis.classification === "unknown") {
    recordOutcome(buyerId, "ignore");
  }
}
