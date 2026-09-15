import { describe, expect, it } from "vitest";
import { AUTHORIZED_SENDER, PREVIOUS_SENDER, assertAuthorizedSender } from "../lib/email/address";
import { buildRawMessage } from "../lib/email/mime";
import {
  gmailSendCooldownUntil,
  noteGmailSenderLimit,
  pickAvailableSender,
  sendAuthorizedEmail,
  senderCooldownUntil,
  senderPool,
  setGmailClient,
} from "../lib/email/provider";
import { GMAIL_SCOPES, saveLegacyTokens, saveSenderTokens, senderHasSendTokens } from "../lib/email/tokens";
import { setSetting } from "../lib/db";

describe("authorized sender pool", () => {
  it("treats both business mailboxes as authorized From and keeps Berkeley denied", () => {
    expect(assertAuthorizedSender(AUTHORIZED_SENDER).ok).toBe(true);
    expect(assertAuthorizedSender(PREVIOUS_SENDER).ok).toBe(true);
    expect(assertAuthorizedSender("bailey@berkeley.edu").ok).toBe(false);
    const mime = buildRawMessage({
      from: PREVIOUS_SENDER,
      to: "buy@fitco.com",
      subject: "x",
      body: "y",
    });
    expect(Buffer.from(mime, "base64url").toString("utf8")).toContain(`From: Bailey Saevitzon <${PREVIOUS_SENDER}>`);
  });

  it("cools only the limited sender and returns the other to the pool when recovered", () => {
    saveSenderTokens({
      address: AUTHORIZED_SENDER,
      refresh_token: "a-rt",
      access_token: "a-at",
      expiry: new Date(Date.now() + 60_000).toISOString(),
      scopes: [...GMAIL_SCOPES],
    });
    saveLegacyTokens({
      address: PREVIOUS_SENDER,
      refresh_token: "b-rt",
      access_token: "b-at",
      expiry: new Date(Date.now() + 60_000).toISOString(),
      scopes: [...GMAIL_SCOPES],
    });
    expect(senderHasSendTokens(AUTHORIZED_SENDER)).toBe(true);
    expect(senderHasSendTokens(PREVIOUS_SENDER)).toBe(true);
    expect(pickAvailableSender()).toBe(AUTHORIZED_SENDER);

    noteGmailSenderLimit(45, AUTHORIZED_SENDER);
    expect(senderCooldownUntil(AUTHORIZED_SENDER)).not.toBeNull();
    expect(senderCooldownUntil(PREVIOUS_SENDER)).toBeNull();
    expect(pickAvailableSender()).toBe(PREVIOUS_SENDER);
    expect(gmailSendCooldownUntil()).toBeNull();

    noteGmailSenderLimit(45, PREVIOUS_SENDER);
    expect(pickAvailableSender()).toBeNull();
    expect(gmailSendCooldownUntil()).not.toBeNull();

    setSetting("gmail_sender_cooldowns", JSON.stringify({
      [AUTHORIZED_SENDER]: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(pickAvailableSender()).toBe(AUTHORIZED_SENDER);
    expect(senderPool().find((s) => s.address === AUTHORIZED_SENDER)?.status).toBe("available");
  });

  it("does not call send while the only injected sender is cooling", async () => {
    const sent: string[] = [];
    setGmailClient({
      profile: async () => ({ emailAddress: AUTHORIZED_SENDER }),
      send: async (input) => {
        sent.push(input.from ?? AUTHORIZED_SENDER);
        return { ok: true, id: "should-not-fire" };
      },
      listInbox: async () => ({ messages: [], historyId: null }),
    });
    noteGmailSenderLimit(45, AUTHORIZED_SENDER);
    const cooling = await sendAuthorizedEmail({
      to: "buy@poolco.com", subject: "x", body: "y", attachments: [],
    });
    expect(cooling.ok).toBe(false);
    if (!cooling.ok) expect(cooling.error).toMatch(/gmail 429 cooldown until/);
    expect(sent).toHaveLength(0);
  });
});
