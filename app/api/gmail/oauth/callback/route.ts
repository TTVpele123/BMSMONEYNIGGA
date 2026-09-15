import { getSetting, setSetting, audit } from "@/lib/db";
import { PREVIOUS_SENDER } from "@/lib/email/address";
import { exchangeAuthorizationCode, expectedAddressForMailbox, type GmailOAuthMailbox } from "@/lib/email/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function takeState(state: string | null): boolean {
  if (!state) return false;
  let list: string[] = [];
  try { list = JSON.parse(getSetting("gmail_oauth_states", "[]")); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const legacy = getSetting("gmail_oauth_state", "");
  const ok = list.includes(state) || (legacy !== "" && legacy === state);
  const next = list.filter((s) => s !== state);
  setSetting("gmail_oauth_states", JSON.stringify(next));
  if (legacy === state) setSetting("gmail_oauth_state", "");
  return ok;
}

function takeMailbox(state: string | null): GmailOAuthMailbox {
  let mailboxes: Record<string, string> = {};
  try { mailboxes = JSON.parse(getSetting("gmail_oauth_mailboxes", "{}")); } catch { mailboxes = {}; }
  const raw = state ? mailboxes[state] : "";
  if (state) delete mailboxes[state];
  setSetting("gmail_oauth_mailboxes", JSON.stringify(mailboxes));
  if (raw === "legacy_inbound") return "legacy_inbound";
  if (raw === "saefam_send") return "saefam_send";
  return "send";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const err = url.searchParams.get("error");
  if (err) {
    audit("gmail", "oauth_failed", { ok: false, detail: { error: err, phase: "provider_error" } });
    return new Response(`<html><body><p>Gmail OAuth failed: ${err}</p></body></html>`, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !takeState(state)) {
    audit("gmail", "oauth_failed", { ok: false, detail: { error: "invalid OAuth state", hasCode: Boolean(code), hasState: Boolean(state) } });
    return new Response(
      `<html><body><p>Gmail OAuth failed: invalid or expired state.</p><p>Open <a href="/api/gmail/oauth/start">/api/gmail/oauth/start</a> once and finish without refreshing mid-flow.</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
  const mailbox = takeMailbox(state);
  const expected = expectedAddressForMailbox(mailbox);
  try {
    const tokens = await exchangeAuthorizationCode(code, { expected, mailbox });
    if (tokens.address !== expected) {
      audit("gmail", "oauth_failed", { ok: false, detail: { error: "wrong mailbox", address: tokens.address, expected } });
      return new Response(
        `<html><body><p>Connected as ${tokens.address}, but this flow requires ${expected}.</p><p>Tokens were not kept. Berkeley and personal mailboxes are refused.</p></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    audit("gmail", mailbox === "legacy_inbound" ? "oauth_legacy_inbound_connected" : "oauth_connected", {
      detail: { address: tokens.address, send: mailbox !== "legacy_inbound" },
    });
    if (mailbox === "legacy_inbound") {
      return new Response(
        `<html><body><p>Saefam inbox connected read-only as <b>${PREVIOUS_SENDER}</b>.</p><p>This mailbox cannot send until reconnected with send. Open <a href="/api/gmail/oauth/start?mailbox=saefam">/api/gmail/oauth/start?mailbox=saefam</a>.</p></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    if (mailbox === "saefam_send") {
      return new Response(
        `<html><body><p>Saefam joined the sender pool as <b>${tokens.address}</b>.</p><p>Outbound still honors kill switch, guardedOutreach, and per-sender Gmail cooldown.</p></body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    return new Response(
      `<html><body><p>Gmail connected as <b>${tokens.address}</b>.</p><p>Outbound mode is controlled by settings (prefer dry_run until intentionally flipped live).</p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    audit("gmail", "oauth_failed", { ok: false, detail: { error: message, expected } });
    return new Response(`<html><body><p>Gmail OAuth failed: ${message}</p></body></html>`, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}
