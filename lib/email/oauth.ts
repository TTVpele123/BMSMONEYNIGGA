import { AUTHORIZED_SENDER } from "./address";
import { GMAIL_SCOPES, gmailRedirectUri } from "./tokens";

export { gmailRedirectUri };

export function gmailAuthorizationUrl(state: string): string {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: gmailRedirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    login_hint: AUTHORIZED_SENDER,
    state,
  }).toString();
}
