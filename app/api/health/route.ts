import { heartbeat, northStar } from "@/lib/orchestrator";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, heartbeat: heartbeat(), northStar: northStar() });
}
