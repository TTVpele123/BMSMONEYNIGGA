import { heartbeat, runSchedulerCycle } from "@/lib/orchestrator";

export async function POST() {
  const cycle = await runSchedulerCycle();
  return Response.json({ ok: true, ...cycle, heartbeat: heartbeat() });
}
