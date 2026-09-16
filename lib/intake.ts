import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { audit, db } from "./db";
import { emit } from "./events";
import { inferLotCategory } from "./matcher";
import { classifyOliverMedia } from "./media";
import { mediaRoot } from "./paths";
import { restoreLotIfEligible } from "./repairs";

export const WhatsAppIngest = z.object({
  chat: z.string().default("oliver"),
  scanned_at: z.string(),
  since: z.string().optional(),
  messages: z.array(z.object({
    id: z.string(),
    at: z.string(),
    text: z.string().optional().default(""),
    media: z.array(z.object({
      filename: z.string(),
      sha256: z.string().optional(),
      path: z.string().optional(),
      bytes_base64: z.string().optional(),
    })).optional().default([]),
  })),
});
export type WhatsAppIngestT = z.infer<typeof WhatsAppIngest>;

function looksLikeGoods(text: string): boolean {
  return /lot|unit|pcs|pairs|qty|quantity|\$|price|nike|adidas|nfl|apparel|shoe|sandal|slide|slipper|footwear|sock|pallet|available|in stock/i.test(text);
}

function extractFacts(text: string): Record<string, string> {
  const facts: Record<string, string> = {};
  const qty = text.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:units|pcs|pairs|qty)?/i);
  if (qty) facts.quantity = qty[1].replace(/,/g, "");
  const price = text.match(/\$\s?(\d+(?:\.\d+)?)/);
  if (price) facts.unit_price = price[1];
  const brand = text.match(/\b(nike|adidas|puma|vans|crocs|disney|nfl|nba|new era|under armour|skims|elf)\b/i);
  if (brand) facts.brand = brand[1];
  if (/new|nwt|deadstock/i.test(text)) facts.condition = "new";
  if (/licensed|nfl|nba|disney/i.test(text)) facts.licensing = "licensed";
  return facts;
}

function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  // Never persist internal provenance as the product title.
  if (!line || /^oliver(\s+lot)?$/i.test(line) || /\boliver\s+lot\b/i.test(line)) return "Available Inventory";
  return line.slice(0, 120);
}

function storeMediaForLot(
  lotId: number,
  messageId: string,
  media: WhatsAppIngestT["messages"][number]["media"],
  context: string,
  seen: Set<string>,
): number {
  let certainMedia = 0;
  for (const m of media) {
    let storedPath = m.path;
    if (m.bytes_base64) {
      const buf = Buffer.from(m.bytes_base64, "base64");
      const dest = path.join(mediaRoot(), "oliver", String(lotId));
      fs.mkdirSync(dest, { recursive: true });
      storedPath = path.join(dest, m.filename);
      fs.writeFileSync(storedPath, buf);
    }
    if (!storedPath || !fs.existsSync(storedPath)) {
      audit("lot_intake", "media_missing", { entityType: "lots", entityId: lotId, ok: false, detail: { filename: m.filename } });
      continue;
    }
    const classified = classifyOliverMedia({ filePath: storedPath, filename: m.filename, context, seenHashes: seen });
    const certain = classified.outreachSafe && classified.classification !== "screenshot_chat_capture";
    db().prepare(
      `INSERT INTO lot_media(lot_id,oliver_message_id,sha256,path,filename,bytes,width,height,classification,outreach_safe,association_certain)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sha256) DO UPDATE SET lot_id=excluded.lot_id`
    ).run(
      lotId, messageId, classified.sha256, storedPath, m.filename, classified.bytes,
      classified.width, classified.height, classified.classification, certain ? 1 : 0, certain ? 1 : 0,
    );
    if (certain) certainMedia += 1;
  }
  return certainMedia;
}

export function ingestWhatsApp(raw: unknown): { ok: true; newMessages: number; lotsTouched: number[] } {
  const body = WhatsAppIngest.parse(raw);
  const lotsTouched = new Set<number>();
  let newMessages = 0;
  const seen = new Set<string>();

  for (const msg of body.messages) {
    const existing = db().prepare("SELECT id, lot_id FROM whatsapp_messages WHERE message_id=?").get(msg.id) as { id: number; lot_id: number | null } | undefined;
    if (existing) {
      if (existing.lot_id && msg.media.length) {
        const certainMedia = storeMediaForLot(existing.lot_id, msg.id, msg.media, msg.text ?? "", seen);
        db().prepare("UPDATE whatsapp_messages SET scanned_at=? WHERE message_id=?").run(body.scanned_at, msg.id);
        if (certainMedia > 0) {
          db().prepare("UPDATE lots SET state='matchable', availability='active', updated_at=datetime('now') WHERE id=?").run(existing.lot_id);
          restoreLotIfEligible(existing.lot_id);
          emit("match.requested", { lotId: existing.lot_id }, `match.requested:${existing.lot_id}:${msg.id}:media`);
        }
      }
      if (existing.lot_id) lotsTouched.add(existing.lot_id);
      continue;
    }

    db().prepare(
      "INSERT INTO whatsapp_messages(message_id,chat,sent_at,text,scanned_at) VALUES(?,?,?,?,?)"
    ).run(msg.id, body.chat, msg.at, msg.text ?? "", body.scanned_at);
    newMessages += 1;

    const goods = looksLikeGoods(msg.text ?? "") || msg.media.length > 0;
    if (!goods) continue;

    const facts = extractFacts(msg.text ?? "");
    const title = titleFrom(msg.text ?? "");
    const category = inferLotCategory(title, msg.text ?? "");
    const externalKey = `wa:${msg.id}`;

    const insert = db().prepare(
      `INSERT INTO lots(external_key,title,category,category_normalized,brand,quantity,unit_price,condition,licensing,raw_text,state)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    );
    const info = insert.run(
      externalKey,
      title,
      category,
      category,
      facts.brand ?? null,
      facts.quantity ? Number(facts.quantity) : null,
      facts.unit_price ? Number(facts.unit_price) : null,
      facts.condition ?? null,
      facts.licensing ?? null,
      msg.text ?? "",
      "structured",
    );
    const lotId = Number(info.lastInsertRowid);
    db().prepare("UPDATE whatsapp_messages SET processed=1, lot_id=? WHERE message_id=?").run(lotId, msg.id);
    for (const [k, v] of Object.entries(facts)) {
      db().prepare("INSERT OR IGNORE INTO lot_facts(lot_id,key,value,source_message_id,confidence) VALUES(?,?,?,?,0.7)").run(lotId, k, v, msg.id);
    }

    const certainMedia = storeMediaForLot(lotId, msg.id, msg.media, msg.text ?? "", seen);

    if (certainMedia > 0) {
      db().prepare("UPDATE lots SET state='matchable', availability='active', updated_at=datetime('now') WHERE id=?").run(lotId);
      restoreLotIfEligible(lotId);
      emit("match.requested", { lotId }, `match.requested:${lotId}:${msg.id}`);
    } else {
      db().prepare(
        "UPDATE lots SET state='paused', project_gate='DO_NOT_MARKET', availability='paused', updated_at=datetime('now') WHERE id=?"
      ).run(lotId);
    }
    lotsTouched.add(lotId);
    emit("lot.created", { lotId }, `lot.created:${lotId}`);
    audit("lot_intake", "lot_upserted", { entityType: "lots", entityId: lotId, detail: { messageId: msg.id, certainMedia } });
  }

  emit("whatsapp.ingested", { scanned_at: body.scanned_at, newMessages }, `whatsapp.ingested:${body.scanned_at}`);
  return { ok: true, newMessages, lotsTouched: [...lotsTouched] };
}
