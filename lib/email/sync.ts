import { getSetting, setSetting, audit } from "../db";
import { processInbound, replayStoredBounces } from "../inbound";
import { parseFromHeader } from "./address";
import { extractFailedRecipient } from "./bounce";
import { fetchRecentBounceMessages, gmailInboxConfigured, getGmailClient, type GmailInboxMessage } from "./provider";

async function ingestMessage(m: GmailInboxMessage): Promise<boolean> {
  const failed = m.failedRecipient || (m.bounced ? extractFailedRecipient(m.text || m.subject, m.from) : null);
  const from = failed || parseFromHeader(m.from);
  const result = await processInbound({
    from,
    text: [m.text, m.subject].filter(Boolean).join("\n"),
    providerMessageId: m.providerMessageId,
    bounced: m.bounced || Boolean(failed),
  });
  return result.ok && result.classification !== "duplicate";
}

export async function syncGmailInbox(): Promise<{ ok: boolean; ingested: number; reason?: string }> {
  if (!gmailInboxConfigured()) return { ok: false, ingested: 0, reason: "gmail not connected" };
  const client = getGmailClient();
  const since = getSetting("gmail_history_id", "") || null;
  const { messages, historyId } = await client.listInbox(since);
  const seen = new Set(messages.map((m) => m.providerMessageId));
  const legacySince = getSetting("gmail_legacy_history_id", "") || null;
  const legacy = client.listLegacyInbox
    ? await client.listLegacyInbox(legacySince)
    : { messages: [] as GmailInboxMessage[], historyId: null as string | null };
  for (const m of legacy.messages) {
    if (!seen.has(m.providerMessageId)) {
      messages.push(m);
      seen.add(m.providerMessageId);
    }
  }
  let extra = 0;
  if (!getSetting("gmail_bounce_backfill_at", "")) {
    replayStoredBounces();
    for (const m of await fetchRecentBounceMessages()) {
      if (!seen.has(m.providerMessageId)) {
        messages.push(m);
        seen.add(m.providerMessageId);
        extra += 1;
      }
    }
    setSetting("gmail_bounce_backfill_at", new Date().toISOString());
  }
  let ingested = 0;
  for (const m of messages) {
    if (await ingestMessage(m)) ingested += 1;
  }
  if (historyId) setSetting("gmail_history_id", historyId);
  if (legacy.historyId) setSetting("gmail_legacy_history_id", legacy.historyId);
  audit("gmail", "inbox_synced", {
    detail: { ingested, historyId, legacyHistoryId: legacy.historyId, bounceBackfill: extra },
  });
  return { ok: true, ingested };
}
