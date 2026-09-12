import { syncGmailInbox } from "@/lib/email/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await syncGmailInbox();
    return Response.json(result);
  } catch (e) {
    return Response.json({ ok: false, ingested: 0, reason: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
