import { getSetting, setSetting, audit } from "../db";
import { processInbound, repairSenderLimitNotices, replayStoredBounces } from "../inbound";
import { AUTHORIZED_SENDER, PREVIOUS_SENDER, parseFromHeader } from "./address";
import { extractFailedRecipient } from "./bounce";
import { fetchRecentBounceMessages, gmailInboxConfigured, getGmailClient, prioritizeInboxMessages, type GmailInboxMessage } from "./provider";

async function ingestMessage(m: GmailInboxMessage, mailbox: string): Promise<boolean> {
  const failed = m.failedRecipient || (m.bounced ? extractFailedRecipient(m.text || m.subject, m.from) : null);
  const from = failed || parseFromHeader(m.from);
  const result = await processInbound({
    from,
    text: [m.text, m.subject].filter(Boolean).join("\n"),
    providerMessageId: m.providerMessageId,
    bounced: m.bounced || Boolean(failed),
    mailbox,
  });
  return result.ok && result.classification !== "duplicate";
}

export async function syncGmailInbox(): Promise<{ ok: boolean; ingested: number; reason?: string }> {
  if (!gmailInboxConfigured()) return { ok: false, ingested: 0, reason: "gmail not connected" };
  const client = getGmailClient();
  const since = getSetting("gmail_history_id", "") || null;
  const { messages, historyId } = await client.listInbox(since);
  const mailboxOf = new Map<string, string>();
  for (const m of messages) mailboxOf.set(m.providerMessageId, AUTHORIZED_SENDER);
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
    mailboxOf.set(m.providerMessageId, PREVIOUS_SENDER);
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
  for (const m of prioritizeInboxMessages(messages)) {
    if (await ingestMessage(m, mailboxOf.get(m.providerMessageId) ?? AUTHORIZED_SENDER)) ingested += 1;
  }
  repairSenderLimitNotices();
  if (historyId) setSetting("gmail_history_id", String(historyId));
  if (legacy.historyId) setSetting("gmail_legacy_history_id", String(legacy.historyId));
  audit("gmail", "inbox_synced", {
    detail: { ingested, historyId, legacyHistoryId: legacy.historyId, bounceBackfill: extra },
  });
  return { ok: true, ingested };
}
