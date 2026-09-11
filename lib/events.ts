import { db, audit } from "./db";

export type EventType =
  | "whatsapp.ingested"
  | "lot.created"
  | "lot.updated"
  | "match.requested"
  | "outreach.requested"
  | "inbound.received"
  | "research.tick"
  | "learning.recorded";

export function emit(type: EventType, payload: unknown, idempotencyKey?: string): number {
  const key = idempotencyKey ?? `${type}:${JSON.stringify(payload)}:${Date.now()}`;
  try {
    const info = db().prepare(
      "INSERT INTO events(type,payload,idempotency_key) VALUES(?,?,?)"
    ).run(type, JSON.stringify(payload), key);
    audit("orchestrator", "event_emitted", { entityType: "events", entityId: Number(info.lastInsertRowid), detail: { type } });
    return Number(info.lastInsertRowid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/.test(msg)) {
      const row = db().prepare("SELECT id FROM events WHERE idempotency_key=?").get(key) as { id: number };
      return row.id;
    }
    throw err;
  }
}

export function unprocessedEvents(limit = 50): { id: number; type: EventType; payload: string; attempts: number }[] {
  return db().prepare(
    "SELECT id, type, payload, attempts FROM events WHERE processed_at IS NULL ORDER BY id LIMIT ?"
  ).all(limit) as { id: number; type: EventType; payload: string; attempts: number }[];
}

export function markProcessed(id: number): void {
  db().prepare("UPDATE events SET processed_at=datetime('now') WHERE id=?").run(id);
}

export function markFailed(id: number, error: string): void {
  db().prepare("UPDATE events SET attempts=attempts+1, last_error=? WHERE id=?").run(error, id);
  const row = db().prepare("SELECT attempts FROM events WHERE id=?").get(id) as { attempts: number };
  if (row.attempts >= 5) {
    db().prepare("UPDATE events SET processed_at=datetime('now') WHERE id=?").run(id);
    audit("orchestrator", "event_dead", { entityType: "events", entityId: id, ok: false, detail: { error } });
  }
}
