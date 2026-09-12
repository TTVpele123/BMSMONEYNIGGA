import { audit, db, killSwitchOn, outboundMode } from "./db";
import { runMatching } from "./conversations";
import { markFailed, markProcessed, unprocessedEvents, type EventType } from "./events";
import { researchTick } from "./research";

export async function tick(): Promise<{ processed: number; failed: number; details: string[] }> {
  const details: string[] = [];
  let processed = 0;
  let failed = 0;
  for (const ev of unprocessedEvents(80)) {
    try {
      const payload = JSON.parse(ev.payload) as Record<string, unknown>;
      const result = await handle(ev.type, payload);
      markProcessed(ev.id);
      processed += 1;
      details.push(`${ev.type}#${ev.id} ${JSON.stringify(result)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markFailed(ev.id, msg);
      failed += 1;
      details.push(`${ev.type}#${ev.id} FAIL ${msg}`);
      audit("orchestrator", "handler_failed", { entityType: "events", entityId: ev.id, ok: false, detail: { error: msg } });
    }
  }
  return { processed, failed, details };
}

async function handle(type: EventType, payload: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case "lot.created":
    case "lot.updated":
    case "match.requested":
      return runMatching(Number(payload.lotId));
    case "research.tick":
      return { ok: true };
    case "whatsapp.ingested":
    case "outreach.requested":
    case "inbound.received":
    case "learning.recorded":
      return { ok: true };
    default:
      throw new Error(`unknown event ${type}`);
  }
}

export function heartbeat(): { lots: number; buyers: number; conversations: number; openHandoffs: number; kill: boolean; mode: string } {
  const lots = (db().prepare("SELECT COUNT(*) AS n FROM lots").get() as { n: number }).n;
  const buyers = (db().prepare("SELECT COUNT(*) AS n FROM buyers").get() as { n: number }).n;
  const conversations = (db().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
  const openHandoffs = (db().prepare("SELECT COUNT(*) AS n FROM escalations WHERE state='open'").get() as { n: number }).n;
  return { lots, buyers, conversations, openHandoffs, kill: killSwitchOn(), mode: outboundMode() };
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler(ms = 5 * 60 * 1000): void {
  if (timer || process.env.BMSM_DISABLE_SCHEDULER === "1") return;
  timer = setInterval(() => {
    void (async () => {
      try {
        researchTick();
        await tick();
        const { syncGmailInbox } = await import("./email/sync");
        await syncGmailInbox();
      } catch (err) {
        audit("orchestrator", "scheduler_error", { ok: false, detail: { error: String(err) } });
      }
    })();
  }, ms);
}

export function northStar(): {
  conversations_per_lot: number;
  deals_per_lot: number;
  qualified_conversations: number;
  active_lots: number;
} {
  const active = (db().prepare("SELECT COUNT(*) AS n FROM lots WHERE availability='active'").get() as { n: number }).n;
  const qualified = (db().prepare("SELECT COUNT(*) AS n FROM conversations WHERE state IN ('replied','qualified','escalated')").get() as { n: number }).n;
  const deals = (db().prepare("SELECT COUNT(*) AS n FROM escalations WHERE state='handed_to_oliver'").get() as { n: number }).n;
  return {
    conversations_per_lot: active ? Number((qualified / active).toFixed(3)) : 0,
    deals_per_lot: active ? Number((deals / active).toFixed(3)) : 0,
    qualified_conversations: qualified,
    active_lots: active,
  };
}
