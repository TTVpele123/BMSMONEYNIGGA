import { ingestWhatsApp } from "@/lib/intake";
import { tick } from "@/lib/orchestrator";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const ingested = ingestWhatsApp(body);
    const orch = await tick();
    return Response.json({ ok: true, ingested, orch });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
