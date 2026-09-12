import { getSetting, setSetting, audit } from "../db";
import { processInbound } from "../inbound";
import { parseFromHeader } from "./address";
import { gmailConfigured, getGmailClient } from "./provider";

export async function syncGmailInbox(): Promise<{ ok: boolean; ingested: number; reason?: string }> {
  if (!gmailConfigured()) return { ok: false, ingested: 0, reason: "gmail not connected" };
  const client = getGmailClient();
  const since = getSetting("gmail_history_id", "") || null;
  const { messages, historyId } = await client.listInbox(since);
  let ingested = 0;
  for (const m of messages) {
    const from = m.bounced && m.failedRecipient
      ? parseFromHeader(m.failedRecipient)
      : parseFromHeader(m.from);
    const result = processInbound({
      from,
      text: m.text || m.subject,
      providerMessageId: m.providerMessageId,
      bounced: m.bounced,
    });
    if (result.ok && result.classification !== "duplicate") ingested += 1;
  }
  if (historyId) setSetting("gmail_history_id", historyId);
  audit("gmail", "inbox_synced", { detail: { ingested, historyId } });
  return { ok: true, ingested };
}
