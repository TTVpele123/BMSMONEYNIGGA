import { audit, db } from "./db";
import { buyerAuthoredReply, classifyReply, type ReplyAnalysisT } from "./classify";
import { listSendableMediaFiles } from "./email/attachments";

type LotRef = { id: number; title: string };

function parseLotIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function marketableLots(ids: number[]): LotRef[] {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  return db().prepare(
    `SELECT id, title FROM lots
      WHERE id IN (${unique.map(() => "?").join(",")})
        AND availability='active'
        AND state NOT IN ('paused','sold','archived')
        AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')`
  ).all(...unique) as LotRef[];
}

/** Lots from the email they actually replied to — never rematch leftovers like paused lot 61. */
export function lotsForEscalation(conversationId: number | null, buyerId: number): LotRef[] {
  const sent = db().prepare(
    `SELECT lot_ids FROM outreach_attempts
      WHERE buyer_id=? AND status IN ('sent','dry_run') AND lot_ids IS NOT NULL AND trim(lot_ids)!=''
        AND (? IS NULL OR conversation_id=? OR conversation_id IS NULL)
      ORDER BY CASE WHEN conversation_id=? THEN 0 ELSE 1 END,
               CASE status WHEN 'sent' THEN 0 ELSE 1 END,
               id DESC
      LIMIT 8`
  ).all(buyerId, conversationId, conversationId, conversationId) as Array<{ lot_ids: string }>;
  for (const row of sent) {
    const lots = marketableLots(parseLotIds(row.lot_ids));
    if (lots.length) return lots;
  }

  if (conversationId) {
    const attached = db().prepare(
      "SELECT lot_id AS id FROM conversation_lots WHERE conversation_id=? ORDER BY rank"
    ).all(conversationId) as Array<{ id: number }>;
    const lots = marketableLots(attached.map((r) => r.id));
    if (lots.length) return lots;
  }

  const opps = db().prepare(
    "SELECT lot_ids FROM opportunities WHERE buyer_id=? ORDER BY id DESC LIMIT 8"
  ).all(buyerId) as Array<{ lot_ids: string }>;
  for (const row of opps) {
    const lots = marketableLots(parseLotIds(row.lot_ids));
    if (lots.length) return lots;
  }
  return [];
}

function goodsLabel(lots: LotRef[]): string {
  const titles = lots.map((l) => l.title).filter(Boolean);
  if (titles.some((t) => /hoodie/i.test(t))) return titles.find((t) => /hoodie/i.test(t)) || "Hoodies";
  if (titles.some((t) => /drill/i.test(t))) return "drill";
  return titles.join(" / ") || "lot on conversation";
}

export function photosForLots(lotIds: number[]): Array<{ path: string; filename: string; lotId: number }> {
  const lots = marketableLots(lotIds);
  if (lots.some((l) => /drill/i.test(l.title)) && !lots.some((l) => /hoodie/i.test(l.title))) return [];
  const out: Array<{ path: string; filename: string; lotId: number }> = [];
  for (const id of lotIds) {
    const first = listSendableMediaFiles(id)[0];
    if (first) out.push({ path: first.path, filename: first.filename, lotId: id });
    if (out.length >= 3) break;
  }
  return out;
}

function personName(buyerId: number, authored: string | null | undefined, company: string): string {
  const contact = db().prepare(
    `SELECT name FROM buyer_contacts
      WHERE buyer_id=? AND name IS NOT NULL AND trim(name)!=''
      ORDER BY id DESC LIMIT 1`
  ).get(buyerId) as { name: string } | undefined;
  if (contact?.name.trim()) return contact.name.trim();
  const skip = /^(hi|hello|hey|dear|thanks|thank|best|regards|from|sent|to|subject|can|i am|we are|on )\b/i;
  for (const line of (authored ?? "").split("\n")) {
    const t = line.replace(/\*/g, "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 70 || skip.test(t)) continue;
    const m = t.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3})(?:\s*[,|]|,|\s*$)/);
    if (m?.[1]) return m[1];
  }
  return company;
}

/** WhatsApp text only: name, phone, goods. Photos are attached separately. */
function buildHandoffPacket(input: {
  buyerId: number;
  conversationId: number;
  reason: string;
  phone: string | null;
  analysis: ReplyAnalysisT;
  question?: string | null;
  lots: LotRef[];
}): { packet: string; lotIds: number[]; phone: string } {
  const buyer = db().prepare("SELECT company, domain FROM buyers WHERE id=?").get(input.buyerId) as { company: string; domain: string };
  const contact = db().prepare(
    `SELECT phone FROM buyer_contacts
      WHERE buyer_id=? AND phone IS NOT NULL AND trim(phone)!=''
      ORDER BY id DESC LIMIT 1`
  ).get(input.buyerId) as { phone: string | null } | undefined;
  const person = personName(input.buyerId, input.question, buyer.company);
  const phone = input.phone ?? contact?.phone ?? "NOT YET CAPTURED — primary next action";
  const goods = goodsLabel(input.lots);
  const packet = [person, phone, goods].join("\n");
  return { packet, lotIds: input.lots.map((l) => l.id), phone };
}

export function createEscalation(input: {
  buyerId: number;
  conversationId: number | null;
  reason: string;
  phone: string | null;
  analysis: ReplyAnalysisT;
  question?: string | null;
}): number {
  let convoId = input.conversationId;
  if (!convoId) {
    const row = db().prepare("SELECT id FROM conversations WHERE buyer_id=?").get(input.buyerId) as { id: number } | undefined;
    if (row) convoId = row.id;
    else {
      const created = db().prepare("INSERT INTO conversations(buyer_id,state) VALUES(?,'escalated')").run(input.buyerId);
      convoId = Number(created.lastInsertRowid);
    }
  }
  const lots = lotsForEscalation(convoId, input.buyerId);
  const built = buildHandoffPacket({
    buyerId: input.buyerId,
    conversationId: convoId,
    reason: input.reason,
    phone: input.phone,
    analysis: input.analysis,
    question: input.question,
    lots,
  });

  const info = db().prepare(
    `INSERT INTO escalations(conversation_id,buyer_id,lot_ids,reason,phone,packet,state) VALUES(?,?,?,?,?,?,'open')`
  ).run(convoId, input.buyerId, JSON.stringify(built.lotIds), input.reason, input.phone, built.packet);
  db().prepare("UPDATE conversations SET state='escalated', next_action='oliver_handoff', updated_at=datetime('now') WHERE id=?").run(convoId);
  audit("escalation", "created", { entityType: "escalations", entityId: Number(info.lastInsertRowid), detail: { reason: input.reason } });
  return Number(info.lastInsertRowid);
}

/** Rewrite open queued Oliver packets whose lots are stale/unmarketable (e.g. paused lot 61). */
export function refreshOpenHandoffLots(): number {
  const rows = db().prepare(
    `SELECT id, conversation_id, buyer_id, reason, phone, lot_ids, packet
     FROM escalations WHERE state='open'`
  ).all() as Array<{
    id: number; conversation_id: number | null; buyer_id: number; reason: string;
    phone: string | null; lot_ids: string; packet: string;
  }>;
  let n = 0;
  for (const row of rows) {
    const lots = lotsForEscalation(row.conversation_id, row.buyer_id);
    const nextIds = lots.map((l) => l.id);
    const prevIds = parseLotIds(row.lot_ids);
    const job = db().prepare(
      "SELECT id, input FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND instruction LIKE ? AND state IN ('queued','claimed')"
    ).get(`%oliver_handoff:${row.id}%`) as { id: number; input: string } | undefined;
    const same = nextIds.length === prevIds.length && nextIds.every((id, i) => id === prevIds[i]);
    if (same && nextIds.length && !job) continue;
    const inbound = db().prepare(
      `SELECT raw_text FROM inbound_events
        WHERE buyer_id=? ORDER BY id DESC LIMIT 1`
    ).get(row.buyer_id) as { raw_text: string | null } | undefined;
    const raw = inbound?.raw_text ?? "";
    const built = buildHandoffPacket({
      buyerId: row.buyer_id,
      conversationId: row.conversation_id ?? 0,
      reason: row.reason,
      phone: row.phone,
      analysis: classifyReply(raw),
      question: buyerAuthoredReply(raw),
      lots,
    });
    db().prepare("UPDATE escalations SET lot_ids=?, packet=? WHERE id=?").run(JSON.stringify(built.lotIds), built.packet, row.id);
    if (job) {
      const payload = {
        escalationId: row.id,
        packet: built.packet,
        phone: row.phone ?? built.phone,
        photos: photosForLots(built.lotIds),
      };
      db().prepare("UPDATE grok_jobs SET input=? WHERE id=?").run(JSON.stringify(payload), job.id);
    }
    n += 1;
  }
  return n;
}

export function openHandoffs(): { id: number; packet: string; created_at: string }[] {
  return db().prepare("SELECT id, packet, created_at FROM escalations WHERE state='open' ORDER BY id DESC").all() as { id: number; packet: string; created_at: string }[];
}
