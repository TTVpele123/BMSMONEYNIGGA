import { outboundMode } from "@/lib/db";
import { AUTHORIZED_SENDER, PREVIOUS_SENDER } from "@/lib/email/address";
import { gmailConfigured } from "@/lib/email/provider";
import {
  GMAIL_LEGACY_INBOUND_SCOPES,
  GMAIL_SCOPES,
  gmailRedirectUri,
  legacyTokenPath,
  legacyTokensPresent,
  loadLegacyTokens,
  loadTokens,
  oauthClientConfigured,
  tokenPath,
  tokensPresent,
} from "@/lib/email/tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const tokens = loadTokens();
  const legacy = loadLegacyTokens();
  return Response.json({
    authorized_sender: AUTHORIZED_SENDER,
    outbound_mode: outboundMode(),
    oauth_client: oauthClientConfigured(),
    connected: tokensPresent(),
    configured_for_send: gmailConfigured(),
    address: tokens?.address ?? null,
    token_path: tokenPath(),
    scopes: GMAIL_SCOPES,
    redirect_uri: gmailRedirectUri(),
    legacy_inbound: {
      mailbox: PREVIOUS_SENDER,
      connected: legacyTokensPresent(),
      address: legacy?.address ?? null,
      token_path: legacyTokenPath(),
      scopes: GMAIL_LEGACY_INBOUND_SCOPES,
      send: false,
    },
  });
}
