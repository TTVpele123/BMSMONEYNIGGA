import { audit, db } from "./db";
import { normalizeCategory } from "./matcher";

export function recordOutcome(buyerId: number, kind: "send" | "reply" | "offer" | "close" | "ignore" | "reject", category?: string): void {
  const lot = db().prepare(
    `SELECT l.category FROM conversation_lots cl
     JOIN conversations c ON c.id=cl.conversation_id
     JOIN lots l ON l.id=cl.lot_id
     WHERE c.buyer_id=? ORDER BY cl.rank LIMIT 1`
  ).get(buyerId) as { category: string } | undefined;
  const cat = normalizeCategory(category ?? lot?.category ?? "other");
  db().prepare(
    `INSERT INTO buyer_category_stats(buyer_id,category,sends,replies,offers,closes,ignores,rejects)
     VALUES(?,?,0,0,0,0,0,0)
     ON CONFLICT(buyer_id,category) DO NOTHING`
  ).run(buyerId, cat);
  const col = { send: "sends", reply: "replies", offer: "offers", close: "closes", ignore: "ignores", reject: "rejects" }[kind];
  db().prepare(`UPDATE buyer_category_stats SET ${col}=${col}+1 WHERE buyer_id=? AND category=?`).run(buyerId, cat);
  audit("learning", `outcome_${kind}`, { entityType: "buyers", entityId: buyerId, detail: { category: cat } });
}
