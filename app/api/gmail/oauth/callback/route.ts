import { getSetting, setSetting, audit } from "@/lib/db";
import { AUTHORIZED_SENDER } from "@/lib/email/address";
import { exchangeAuthorizationCode } from "@/lib/email/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) return Response.json({ ok: false, error: err }, { status: 400 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = getSetting("gmail_oauth_state", "");
  setSetting("gmail_oauth_state", "");
  if (!code || !state || !expected || state !== expected) {
    return Response.json({ ok: false, error: "invalid OAuth state" }, { status: 400 });
  }
  try {
    const tokens = await exchangeAuthorizationCode(code);
    audit("gmail", "oauth_connected", { detail: { address: tokens.address } });
    return new Response(
      `<html><body><p>Gmail connected as ${AUTHORIZED_SENDER}.</p><p>Keep OUTBOUND_MODE / settings.outbound_mode = dry_run until you explicitly flip live.</p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    audit("gmail", "oauth_failed", { ok: false, detail: { error: message } });
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
