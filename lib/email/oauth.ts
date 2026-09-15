import { AUTHORIZED_SENDER, PREVIOUS_SENDER } from "./address";
import { GMAIL_LEGACY_INBOUND_SCOPES, GMAIL_SCOPES, gmailRedirectUri, type GmailOAuthMailbox } from "./tokens";

export { gmailRedirectUri };

export function gmailAuthorizationUrl(state: string, mailbox: GmailOAuthMailbox = "send"): string {
  const inboundOnly = mailbox === "legacy_inbound";
  const saefam = mailbox === "legacy_inbound" || mailbox === "saefam_send";
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: gmailRedirectUri(),
    response_type: "code",
    scope: (inboundOnly ? GMAIL_LEGACY_INBOUND_SCOPES : GMAIL_SCOPES).join(" "),
    access_type: "offline",
    include_granted_scopes: inboundOnly ? "false" : "true",
    prompt: "consent",
    login_hint: saefam ? PREVIOUS_SENDER : AUTHORIZED_SENDER,
    state,
  }).toString();
}
