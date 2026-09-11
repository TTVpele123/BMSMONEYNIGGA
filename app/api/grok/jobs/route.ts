import { claimGrokJobs, finishGrokJob } from "@/lib/research";

export async function GET(req: Request) {
  const agent = new URL(req.url).searchParams.get("agent") ?? undefined;
  return Response.json({ ok: true, jobs: claimGrokJobs(agent) });
}

export async function POST(req: Request) {
  const body = await req.json() as { id: number; ok: boolean; result: unknown };
  finishGrokJob(body.id, body.ok, body.result);
  return Response.json({ ok: true });
}
