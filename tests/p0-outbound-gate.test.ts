import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listOperators } from "../lib/channels/registry";
import { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP } from "../lib/caps";
import { db, setSetting } from "../lib/db";
import { AUTHORIZED_SENDER } from "../lib/email/address";
import { getGmailClient, sendAuthorizedEmail, setGmailClient } from "../lib/email/provider";
import { ingestWhatsApp } from "../lib/intake";
import { composeMessage, guardedOutreach } from "../lib/outreach";
import { enrollBuyer } from "../lib/research";
import { writeUnsubscribe } from "../lib/suppression";
import { writeTestPng } from "./png";

function seedBuyer(domain: string, email = `buy@${domain}`) {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel,licensed",
    verification_status: "verified",
    outreach_channel: "email",
  });
  db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=5000000 WHERE id=?").run(buyerId);
  db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, email);
  return buyerId;
}

let photoNonce = 0;
function seedLot(title: string, withPhoto: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-p05-"));
  const photo = path.join(dir, `${title.replace(/\s+/g, "-")}.jpg`);
  photoNonce += 1;
  writeTestPng(photo, 420 + photoNonce * 8, 220 + photoNonce * 4);
  const ingested = ingestWhatsApp({
    chat: "oliver",
    scanned_at: new Date().toISOString(),
    messages: [{
      id: `wa-${title}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      text: `${title} 1000 units $4`,
      media: withPhoto ? [{ filename: path.basename(photo), path: photo }] : [],
    }],
  });
  return db().prepare("SELECT id, title, category, quantity, unit_price, brand FROM lots WHERE id=?").get(ingested.lotsTouched[0]) as {
    id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null;
  };
}

function convo(buyerId: number, email: string) {
  return Number(db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email',?)").run(buyerId, email).lastInsertRowid);
}

function mockSend() {
  const calls: unknown[] = [];
  setGmailClient({
    profile: async () => ({ emailAddress: AUTHORIZED_SENDER }),
    send: async (input) => {
      calls.push(input);
      return { ok: true, id: `gmail-${calls.length}` };
    },
    listInbox: async () => ({ messages: [], historyId: "1" }),
  });
  return calls;
}

function payload(lotIds?: number[]) {
  return {
    to: "buy@gateco.com",
    subject: "bypass",
    body: "should not send",
    attachments: [],
    lotIds,
    domain: "gateco.com",
  };
}

describe("P0 #5 final outbound gate blocks provider execution", () => {
  it("does not let dry_run, kill switch, suppression, missing media, or exhausted caps reach provider send", async () => {
    const good = seedLot("Gate tees", true);
    const bare = seedLot("No photo gate", false);
    seedBuyer("gateco.com");
    const calls = mockSend();

    const dryDirect = await getGmailClient().send(payload([good.id]));
    const dryAuth = await sendAuthorizedEmail(payload([good.id]));
    expect(dryDirect).toEqual({ ok: false, error: "outbound_mode is not live" });
    expect(dryAuth).toEqual({ ok: false, error: "outbound_mode is not live" });
    expect(calls).toHaveLength(0);

    setSetting("outbound_mode", "live");
    setSetting("kill_switch", "true");
    const held = await getGmailClient().send(payload([good.id]));
    expect(held).toEqual({ ok: false, error: "outbound paused/held" });
    expect(calls).toHaveLength(0);
    setSetting("kill_switch", "false");

    writeUnsubscribe("buy@gateco.com");
    const suppressedTo = await getGmailClient().send(payload([good.id]));
    expect(suppressedTo.ok).toBe(false);
    if (!suppressedTo.ok) expect(suppressedTo.error).toMatch(/suppressed/);
    expect(calls).toHaveLength(0);
    db().prepare("DELETE FROM suppressions").run();

    writeUnsubscribe("other@gateco.com");
    const suppressedDomain = await sendAuthorizedEmail({
      ...payload([good.id]),
      to: "fresh@gateco.com",
    });
    expect(suppressedDomain.ok).toBe(false);
    if (!suppressedDomain.ok) expect(suppressedDomain.error).toMatch(/suppressed/);
    expect(calls).toHaveLength(0);
    db().prepare("DELETE FROM suppressions").run();

    db().prepare("UPDATE lots SET project_gate='AMBER', state='matchable' WHERE id=?").run(bare.id);
    const noLots = await getGmailClient().send(payload());
    const emptyLots = await getGmailClient().send(payload([]));
    const missingLot = await getGmailClient().send(payload([99999]));
    const noMedia = await getGmailClient().send(payload([bare.id]));
    expect(noLots.ok).toBe(false);
    expect(emptyLots.ok).toBe(false);
    expect(missingLot.ok).toBe(false);
    expect(noMedia.ok).toBe(false);
    if (!noMedia.ok) expect(noMedia.error).toMatch(/eligible original Oliver product media/);
    expect(calls).toHaveLength(0);

    db().prepare("UPDATE lots SET project_gate='DO_NOT_MARKET' WHERE id=?").run(good.id);
    const dnm = await getGmailClient().send(payload([good.id]));
    expect(dnm).toEqual({ ok: false, error: "lot is DO_NOT_MARKET" });
    expect(calls).toHaveLength(0);
    db().prepare("UPDATE lots SET project_gate='AMBER', state='paused' WHERE id=?").run(good.id);
    const paused = await sendAuthorizedEmail(payload([good.id]));
    expect(paused).toEqual({ ok: false, error: "lot is DO_NOT_MARKET" });
    expect(calls).toHaveLength(0);
    db().prepare("UPDATE lots SET state='outreach_active' WHERE id=?").run(good.id);

    const buyerId = seedBuyer("fullcap.com");
    const conversationId = convo(buyerId, "buy@fullcap.com");
    // No artificial daily volume cap in production (LIVE_DAILY_CAP === null).
    if (LIVE_DAILY_CAP != null) {
      for (let i = 0; i < LIVE_DAILY_CAP; i++) {
        db().prepare(
          `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
           VALUES(?,?,?,'[]','','','[]','sent','provider accepted',?,?)`
        ).run(conversationId, buyerId, "email", `cap-fill-${i}`, `gmail-fill-${i}`);
      }
      const daily = await getGmailClient().send({ ...payload([good.id]), to: "buy@othercap.com", domain: "othercap.com" });
      expect(daily).toEqual({ ok: false, error: `daily cap ${LIVE_DAILY_CAP}` });
      expect(calls).toHaveLength(0);
      db().prepare("DELETE FROM outreach_attempts").run();
    } else {
      expect(LIVE_DAILY_CAP).toBeNull();
    }

    for (let i = 0; i < LIVE_DOMAIN_CAP; i++) {
      db().prepare(
        `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
         VALUES(?,?,?,'[]','','','[]','sent','provider accepted',?,?)`
      ).run(conversationId, buyerId, "email", `dom-fill-${i}`, `gmail-dom-${i}`);
    }
    const domain = await getGmailClient().send({
      ...payload([good.id]),
      to: "buy@fullcap.com",
      domain: "fullcap.com",
    });
    expect(domain).toEqual({ ok: false, error: `domain cap ${LIVE_DOMAIN_CAP}` });
    expect(calls).toHaveLength(0);
  });

  it("does not let drafts, deferred channels, or orchestration retries bypass the gate", async () => {
    const lot = seedLot("Retry tees", true);
    const buyerId = seedBuyer("retrygate.com");
    const conversationId = convo(buyerId, "buy@retrygate.com");
    const calls = mockSend();

    composeMessage({ company: "Retry", lots: [lot] });
    expect(calls).toHaveLength(0);

    setSetting("outbound_mode", "live");
    for (const op of listOperators().filter((o) => !o.liveExecution)) {
      const ctx = {
        conversationId,
        buyerId,
        company: "Retry",
        domain: "retrygate.com",
        lots: [lot],
        endpoint: { channel: op.id, handle: `https://retrygate.com/${op.id}`, confidence: 0.9, verified: true, source: "test" },
        idempotencyKey: `gate-${op.id}`,
      };
      const prepared = { channel: op.id, handle: ctx.endpoint.handle, subject: "x", body: "y", mediaHashes: [] };
      const result = op.execute(ctx, prepared);
      expect(result).toMatchObject({ status: "deferred" });
    }
    expect(calls).toHaveLength(0);

    setSetting("outbound_mode", "dry_run");
    const dry = await guardedOutreach({
      conversationId, buyerId, email: "buy@retrygate.com", domain: "retrygate.com",
      company: "Retry", lots: [lot], channel: "email", idempotencyKey: "gate-retry-1",
    });
    expect(dry.status).toBe("dry_run");
    const again = await guardedOutreach({
      conversationId, buyerId, email: "buy@retrygate.com", domain: "retrygate.com",
      company: "Retry", lots: [lot], channel: "email", idempotencyKey: "gate-retry-1",
    });
    expect(again.status).toBe("duplicate");
    expect(calls).toHaveLength(0);

    setSetting("outbound_mode", "live");
    setSetting("kill_switch", "true");
    const retryHeld = await guardedOutreach({
      conversationId, buyerId, email: "buy@retrygate.com", domain: "retrygate.com",
      company: "Retry", lots: [lot], channel: "email", idempotencyKey: "gate-retry-held",
    });
    expect(retryHeld.status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("allows provider send only when every final-gate check passes", async () => {
    const lot = seedLot("Live gate tees", true);
    const buyerId = seedBuyer("livegate.com");
    const conversationId = convo(buyerId, "buy@livegate.com");
    setSetting("outbound_mode", "live");
    const calls = mockSend();
    const r = await guardedOutreach({
      conversationId, buyerId, email: "buy@livegate.com", domain: "livegate.com",
      company: "LiveGate", lots: [lot], channel: "email", idempotencyKey: "gate-live-ok",
    });
    expect(r.status).toBe("sent");
    expect(calls).toHaveLength(1);
  });
});
