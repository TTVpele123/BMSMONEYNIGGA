import { z } from "zod";
import { applyFormResult } from "@/lib/channels/form-exec";

const Body = z.object({
  idempotencyKey: z.string(),
  submitted: z.boolean().optional(),
  confirmationText: z.string().optional(),
  confirmationUrl: z.string().optional(),
  httpStatus: z.number().optional(),
  error: z.string().optional(),
  needsHuman: z.boolean().optional(),
  blocker: z.string().optional(),
  fieldsFilled: z.record(z.string(), z.string()).optional(),
});

export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const result = applyFormResult(body);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
