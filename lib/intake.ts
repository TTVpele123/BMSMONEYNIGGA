import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { audit, db } from "./db";
import { emit } from "./events";
import { normalizeCategory } from "./matcher";
import { classifyOliverMedia } from "./media";
import { mediaRoot } from "./paths";

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
  return /lot|unit|pcs|pairs|qty|quantity|\$|price|nike|adidas|nfl|apparel|shoe|sock|pallet|available|in stock/i.test(text);
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
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "Oliver lot";
  return line.slice(0, 120);
}

export function ingestWhatsApp(raw: unknown): { ok: true; newMessages: number; lotsTouched: number[] } {
  const body = WhatsAppIngest.parse(raw);
  const lotsTouched = new Set<number>();
  let newMessages = 0;
  const seen = new Set<string>();

  for (const msg of body.messages) {
    const existing = db().prepare("SELECT id, lot_id FROM whatsapp_messages WHERE message_id=?").get(msg.id) as { id: number; lot_id: number | null } | undefined;
    if (existing) {
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
    const category = normalizeCategory(msg.text ?? "");
    const title = titleFrom(msg.text ?? `Oliver lot ${msg.id}`);
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

    let certainMedia = 0;
    for (const m of msg.media) {
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
      const classified = classifyOliverMedia({ filePath: storedPath, filename: m.filename, context: msg.text ?? "", seenHashes: seen });
      const certain = classified.outreachSafe && classified.classification !== "screenshot_chat_capture";
      db().prepare(
        `INSERT INTO lot_media(lot_id,oliver_message_id,sha256,path,filename,bytes,width,height,classification,outreach_safe,association_certain)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(sha256) DO UPDATE SET lot_id=excluded.lot_id`
      ).run(
        lotId, msg.id, classified.sha256, storedPath, m.filename, classified.bytes,
        classified.width, classified.height, classified.classification, certain ? 1 : 0, certain ? 1 : 0,
      );
      if (certain) certainMedia += 1;
    }

    const nextState = certainMedia > 0 ? "media_ready" : "structured";
    db().prepare("UPDATE lots SET state=?, updated_at=datetime('now') WHERE id=?").run(nextState === "media_ready" ? "matchable" : nextState, lotId);
    lotsTouched.add(lotId);
    emit("lot.created", { lotId }, `lot.created:${lotId}`);
    emit("match.requested", { lotId }, `match.requested:${lotId}:${msg.id}`);
    audit("lot_intake", "lot_upserted", { entityType: "lots", entityId: lotId, detail: { messageId: msg.id, certainMedia } });
  }

  emit("whatsapp.ingested", { scanned_at: body.scanned_at, newMessages }, `whatsapp.ingested:${body.scanned_at}`);
  return { ok: true, newMessages, lotsTouched: [...lotsTouched] };
}
