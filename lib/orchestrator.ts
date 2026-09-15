import { audit, db, killSwitchOn, outboundMode } from "./db";
import { emit, markFailed, markProcessed, unprocessedEvents, type EventType } from "./events";
import { assessOutboundProgress, recoverIfOutboundStalled, type OutboundWatchdog, type StallRecovery } from "./outbound-stall";
import { lotEligibleForResearch, researchTick } from "./research";

export const SCHEDULER_VERSION = "runSchedulerCycle/v1";
export const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
/** Two missed 5-minute ticks plus buffer. Independent of outbound_stalled. */
export const SCHEDULER_STALE_MINUTES = 12;

let schedulerStartedAt: string | null = null;
let lastSuccessfulCycleAt: string | null = null;

function parseDbUtc(ts: string): number {
  return Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
}

function markSchedulerCycleOk(): void {
  lastSuccessfulCycleAt = new Date().toISOString();
  if (!schedulerStartedAt) schedulerStartedAt = lastSuccessfulCycleAt;
}

export function resetSchedulerRuntimeForTests(): void {
  schedulerStartedAt = null;
  lastSuccessfulCycleAt = null;
}

export type SchedulerHealth = {
  schedulerStartedAt: string | null;
  schedulerVersion: string;
  lastSuccessfulSchedulerCycleAt: string | null;
  minutesSinceLastSchedulerCycle: number | null;
  scheduler_unhealthy: boolean;
  scheduler_unhealthy_reason: string | null;
};

export function schedulerHealth(): SchedulerHealth {
  const row = db().prepare(
    "SELECT at FROM audit_log WHERE actor='orchestrator' AND action='scheduler_cycle' ORDER BY id DESC LIMIT 1"
  ).get() as { at: string } | undefined;
  // Audit is source of truth. In-process Date.now() lies after next-dev HMR:
  // /api/health and the interval can be different module instances.
  const lastMs = row ? parseDbUtc(row.at) : lastSuccessfulCycleAt ? Date.parse(lastSuccessfulCycleAt) : null;
  const minutes = lastMs != null ? (Date.now() - lastMs) / 60_000 : null;
  const disabled = process.env.BMSM_DISABLE_SCHEDULER === "1";
  let scheduler_unhealthy = false;
  let scheduler_unhealthy_reason: string | null = null;
  if (!disabled) {
    if (minutes == null) {
      const startedMs = schedulerStartedAt ? Date.parse(schedulerStartedAt) : null;
      if (startedMs != null && (Date.now() - startedMs) / 60_000 >= SCHEDULER_STALE_MINUTES) {
        scheduler_unhealthy = true;
        scheduler_unhealthy_reason = "no_scheduler_cycle";
      }
    } else if (minutes >= SCHEDULER_STALE_MINUTES) {
      scheduler_unhealthy = true;
      scheduler_unhealthy_reason = "scheduler_cycle_stale";
    }
  }
  return {
    schedulerStartedAt,
    schedulerVersion: SCHEDULER_VERSION,
    lastSuccessfulSchedulerCycleAt: row?.at ?? lastSuccessfulCycleAt,
    minutesSinceLastSchedulerCycle: minutes == null ? null : Number(minutes.toFixed(1)),
    scheduler_unhealthy,
    scheduler_unhealthy_reason,
  };
}

/** Re-queue matching for media-eligible lots so a drained event log cannot stall outreach. */
export function enqueueEligibleLotMatches(opts?: { source?: "sched" | "watchdog" | "tick" }): number {
  const source = opts?.source ?? "sched";
  // "tick" is unique so a stale in-process fire cannot consume the HTTP clock's rematch.
  const windowMs = source === "watchdog" ? 15 * 60 * 1000 : 5 * 60 * 1000;
  const bucket = source === "tick" ? Date.now() : Math.floor(Date.now() / windowMs);
  const lots = db().prepare(
    `SELECT id FROM lots
      WHERE availability='active'
        AND project_gate NOT IN ('DO_NOT_MARKET','ARCHIVED')
        AND state IN ('matchable','outreach_active','media_ready')`
  ).all() as { id: number }[];
  let queued = 0;
  for (const lot of lots) {
    if (!lotEligibleForResearch(lot.id)) continue;
    const key = `match.requested:${source}:${lot.id}:${bucket}`;
    const before = db().prepare("SELECT id FROM events WHERE idempotency_key=?").get(key) as { id: number } | undefined;
    emit("match.requested", { lotId: lot.id }, key);
    if (!before) queued += 1;
  }
  return queued;
}

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
    case "match.requested": {
      const { runMatching: matchNow } = await import("./conversations");
      return matchNow(Number(payload.lotId));
    }
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

export function heartbeat(): {
  lots: number;
  buyers: number;
  conversations: number;
  openHandoffs: number;
  queuedOliverHandoffs: number;
  kill: boolean;
  mode: string;
} {
  const lots = (db().prepare("SELECT COUNT(*) AS n FROM lots").get() as { n: number }).n;
  const buyers = (db().prepare("SELECT COUNT(*) AS n FROM buyers").get() as { n: number }).n;
  const conversations = (db().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
  const openHandoffs = (db().prepare("SELECT COUNT(*) AS n FROM escalations WHERE state='open'").get() as { n: number }).n;
  const queuedOliverHandoffs = (db().prepare(
    "SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND state IN ('queued','claimed')"
  ).get() as { n: number }).n;
  return { lots, buyers, conversations, openHandoffs, queuedOliverHandoffs, kill: killSwitchOn(), mode: outboundMode() };
}

export type SchedulerCycle = {
  research: ReturnType<typeof researchTick>;
  rematch: number;
  orch: Awaited<ReturnType<typeof tick>>;
  inbox: { ok: boolean; ingested: number; reason?: string };
  watchdog: OutboundWatchdog;
  recovery: StallRecovery | null;
};

/** Research → rematch → drain → inbox sync → stall recovery. launchd POSTs this; do not add a second clock. */
export async function runSchedulerCycle(): Promise<SchedulerCycle> {
  const { repairSenderLimitNotices } = await import("./inbound");
  repairSenderLimitNotices();
  const research = researchTick();
  const rematch = enqueueEligibleLotMatches({ source: "tick" });
  const orch = await tick();
  let inbox: { ok: boolean; ingested: number; reason?: string } = { ok: false, ingested: 0, reason: "sync skipped" };
  try {
    const { syncGmailInbox } = await import("./email/sync");
    inbox = await syncGmailInbox();
    const { closeFalseBounceHandoffs, continueMissedPhoneHandoffs, continueUnansweredWarmInbounds } = await import("./inbound");
    const { releaseStaleClaimedGrokJobs } = await import("./research");
    closeFalseBounceHandoffs();
    continueMissedPhoneHandoffs();
    await continueUnansweredWarmInbounds();
    releaseStaleClaimedGrokJobs();
  } catch (err) {
    inbox = { ok: false, ingested: 0, reason: String(err) };
    audit("gmail", "inbox_sync_failed", { ok: false, detail: { error: String(err) } });
  }
  const recovery = await recoverIfOutboundStalled({
    rematch: () => enqueueEligibleLotMatches({ source: "watchdog" }),
    process: tick,
  });
  const watchdog = assessOutboundProgress();
  audit("orchestrator", "scheduler_cycle", {
    detail: {
      rematch,
      processed: orch.processed,
      inbox,
      recovery: recovery
        ? { rematch: recovery.rematch, processed: recovery.processed, sendVerified: recovery.sendVerified, stall_reason: recovery.snapshot.stall_reason }
        : null,
      watchdog,
    },
  });
  markSchedulerCycleOk();
  return { research, rematch, orch, inbox, watchdog, recovery };
}

/** Boot marker only. The live clock is launchd → POST /api/jobs/tick. */
export function startScheduler(_ms = SCHEDULER_INTERVAL_MS): void {
  if (process.env.BMSM_DISABLE_SCHEDULER === "1") return;
  if (!schedulerStartedAt) schedulerStartedAt = new Date().toISOString();
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
