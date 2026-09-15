import crypto from "node:crypto";
import { getSetting, setSetting } from "@/lib/db";
import { gmailAuthorizationUrl } from "@/lib/email/oauth";
import { oauthClientConfigured, type GmailOAuthMailbox } from "@/lib/email/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function pushState(state: string, mailbox: GmailOAuthMailbox): void {
  let list: string[] = [];
  try { list = JSON.parse(getSetting("gmail_oauth_states", "[]")); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list.push(state);
  setSetting("gmail_oauth_states", JSON.stringify(list.slice(-5)));
  setSetting("gmail_oauth_state", state);
  let mailboxes: Record<string, string> = {};
  try { mailboxes = JSON.parse(getSetting("gmail_oauth_mailboxes", "{}")); } catch { mailboxes = {}; }
  mailboxes[state] = mailbox;
  const keep = new Set(list.slice(-5));
  for (const key of Object.keys(mailboxes)) {
    if (!keep.has(key)) delete mailboxes[key];
  }
  setSetting("gmail_oauth_mailboxes", JSON.stringify(mailboxes));
}

export async function GET(req: Request) {
  if (!oauthClientConfigured()) {
    return Response.json({ ok: false, error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required" }, { status: 400 });
  }
  const mailbox = new URL(req.url).searchParams.get("mailbox");
  if (mailbox && mailbox !== "legacy") {
    return Response.json({ ok: false, error: "mailbox must be omitted or legacy" }, { status: 400 });
  }
  const intent: GmailOAuthMailbox = mailbox === "legacy" ? "legacy_inbound" : "send";
  const state = crypto.randomBytes(16).toString("hex");
  pushState(state, intent);
  return Response.redirect(gmailAuthorizationUrl(state, intent));
}
