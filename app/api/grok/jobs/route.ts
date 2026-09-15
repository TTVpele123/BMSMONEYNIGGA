import { applyFormJobResult } from "@/lib/channels/form-exec";
import { db } from "@/lib/db";
import { claimGrokJobs, finishGrokJob, peekGrokJobs } from "@/lib/research";
import { applyOliverHandoffResult } from "@/lib/warm-inbound";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent") ?? "";
  const claim = url.searchParams.get("claim") === "1";
  // INBOUND_ANALYST GET is a peek unless claim=1 so a check cannot steal the send.
  if (agent === "INBOUND_ANALYST" && !claim) {
    return Response.json({ ok: true, jobs: peekGrokJobs(agent) });
  }
  return Response.json({ ok: true, jobs: claimGrokJobs(agent || undefined) });
}

export async function POST(req: Request) {
  const body = await req.json() as { id: number; ok: boolean; result: unknown };
  const job = db().prepare("SELECT agent FROM grok_jobs WHERE id=?").get(body.id) as { agent: string } | undefined;
  finishGrokJob(body.id, body.ok, body.result);
  let form;
  if (job?.agent === "FORM_OPERATOR") {
    form = applyFormJobResult(body.id, body.result);
  }
  if (job?.agent === "INBOUND_ANALYST") {
    applyOliverHandoffResult(body.id, body.ok);
  }
  return Response.json({ ok: true, form });
}
