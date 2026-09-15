import { applyFormJobResult } from "@/lib/channels/form-exec";
import { db } from "@/lib/db";
import { claimGrokJobs, finishGrokJob, peekGrokJobs } from "@/lib/research";
import { applyOliverHandoffResult } from "@/lib/warm-inbound";

function jobsForClient(jobs: Array<{ id: number; agent: string; instruction: string; input: string }>) {
  return jobs.map((j) => {
    try {
      return { ...j, input: JSON.parse(j.input) };
    } catch {
      return j;
    }
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent") ?? "";
  const claim = url.searchParams.get("claim") === "1";
  // Peek unless claim=1 so a dashboard check cannot steal a form or Oliver send.
  if ((agent === "INBOUND_ANALYST" || agent === "FORM_OPERATOR") && !claim) {
    return Response.json({ ok: true, jobs: jobsForClient(peekGrokJobs(agent)) });
  }
  return Response.json({ ok: true, jobs: jobsForClient(claimGrokJobs(agent || undefined)) });
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
