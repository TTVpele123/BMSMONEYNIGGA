import { opsSnapshot } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, ...opsSnapshot() });
}
