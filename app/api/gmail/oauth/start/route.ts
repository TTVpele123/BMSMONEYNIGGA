import crypto from "node:crypto";
import { setSetting } from "@/lib/db";
import { gmailAuthorizationUrl } from "@/lib/email/oauth";
import { oauthClientConfigured } from "@/lib/email/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (!oauthClientConfigured()) {
    return Response.json({ ok: false, error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required" }, { status: 400 });
  }
  const state = crypto.randomBytes(16).toString("hex");
  setSetting("gmail_oauth_state", state);
  return Response.redirect(gmailAuthorizationUrl(state));
}
