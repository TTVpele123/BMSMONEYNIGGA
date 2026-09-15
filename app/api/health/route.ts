import { assessOutboundProgress } from "@/lib/outbound-stall";
import { heartbeat, northStar, schedulerHealth } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function GET() {
  const watchdog = assessOutboundProgress();
  const scheduler = schedulerHealth();
  const beat = heartbeat();
  return Response.json({
    ok: true,
    heartbeat: beat,
    queued_oliver_handoffs: beat.queuedOliverHandoffs,
    northStar: northStar(),
    lastConfirmedSendAt: watchdog.lastConfirmedSendAt,
    minutesSinceLastConfirmedSend: watchdog.minutesSinceLastConfirmedSend,
    eligibleUntouchedBuyerCount: watchdog.eligibleUntouchedBuyerCount,
    emailSendableBuyerCount: watchdog.emailSendableBuyerCount,
    eligibleActiveLotCount: watchdog.eligibleActiveLotCount,
    pendingMatchCount: watchdog.pendingMatchCount,
    outbound_stalled: watchdog.outbound_stalled,
    stall_reason: watchdog.stall_reason,
    watchdog,
    schedulerStartedAt: scheduler.schedulerStartedAt,
    schedulerVersion: scheduler.schedulerVersion,
    lastSuccessfulSchedulerCycleAt: scheduler.lastSuccessfulSchedulerCycleAt,
    minutesSinceLastSchedulerCycle: scheduler.minutesSinceLastSchedulerCycle,
    scheduler_unhealthy: scheduler.scheduler_unhealthy,
    scheduler_unhealthy_reason: scheduler.scheduler_unhealthy_reason,
    scheduler,
  });
}
