import { tick, heartbeat } from "@/lib/orchestrator";
import { researchTick } from "@/lib/research";

export async function POST() {
  const research = researchTick();
  const orch = tick();
  return Response.json({ ok: true, research, orch, heartbeat: heartbeat() });
}
