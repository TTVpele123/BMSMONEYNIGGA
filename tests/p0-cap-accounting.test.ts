import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db, setSetting } from "../lib/db";
import { setGmailClient } from "../lib/email/provider";
import { ingestWhatsApp } from "../lib/intake";
import { guardedOutreach, LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSendCapacity, liveSentToday, liveSentToDomainToday } from "../lib/outreach";
import { repairUnconfirmedSentAccounting } from "../lib/repairs";
import { enrollBuyer } from "../lib/research";
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
function seedLot(title: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-p04-"));
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
      media: [{ filename: path.basename(photo), path: photo }],
    }],
  });
  return db().prepare("SELECT id, title, category, quantity, unit_price, brand FROM lots WHERE id=?").get(ingested.lotsTouched[0]) as {
    id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null;
  };
}

function convo(buyerId: number, email: string) {
  return Number(db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email',?)").run(buyerId, email).lastInsertRowid);
}

function insertAttempt(opts: {
  conversationId: number;
  buyerId: number;
  status: string;
  key: string;
  providerMessageId?: string | null;
  reason?: string;
}) {
  db().prepare(
    `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
     VALUES(?,?,?,'[]','','','[]',?,?,?,?)`
  ).run(opts.conversationId, opts.buyerId, "email", opts.status, opts.reason ?? opts.status, opts.key, opts.providerMessageId ?? null);
}

describe("P0 #4 live caps count provider-confirmed sends only", () => {
  it("does not let dry_run, failed, blocked, or unsent rows consume daily or domain capacity", async () => {
    const lot = seedLot("Unsent tees");
    const buyerId = seedBuyer("unsentcap.com");
    const conversationId = convo(buyerId, "buy@unsentcap.com");
    for (let i = 0; i < 20; i++) {
      const r = await guardedOutreach({
        conversationId, buyerId, email: "buy@unsentcap.com", domain: "unsentcap.com",
        company: "Unsent", lots: [lot], channel: "email", idempotencyKey: `dry-${i}`,
      });
      expect(r.status).toBe("dry_run");
    }
    insertAttempt({ conversationId, buyerId, status: "failed", key: "fail-1", reason: "provider 500" });
    insertAttempt({ conversationId, buyerId, status: "blocked", key: "block-1", reason: "kill switch" });
    insertAttempt({ conversationId, buyerId, status: "logged", key: "log-1" });
    insertAttempt({ conversationId, buyerId, status: "sent", key: "sent-no-provider", providerMessageId: null, reason: "provider accepted" });

    expect(liveSentToday()).toBe(0);
    expect(liveSentToDomainToday("unsentcap.com")).toBe(0);
    const cap = liveSendCapacity("unsentcap.com");
    expect(cap.dailyUsed).toBe(0);
    expect(cap.dailyRemaining).toBe(LIVE_DAILY_CAP);
    expect(cap.domainUsed).toBe(0);
    expect(cap.domainRemaining).toBe(LIVE_DOMAIN_CAP);
    expect(repairUnconfirmedSentAccounting()).toEqual({ unconfirmedSent: 1, confirmedSent: 0 });
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts").get() as { n: number }).n).toBe(24);

    setSetting("outbound_mode", "live");
    const sent: string[] = [];
    setGmailClient({
      profile: async () => ({ emailAddress: "saevitzonoverstock@gmail.com" }),
      send: async () => {
        sent.push("ok");
        return { ok: true, id: `gmail-${sent.length}` };
      },
      listInbox: async () => ({ messages: [], historyId: "1" }),
    });
    const live = await guardedOutreach({
      conversationId, buyerId, email: "buy@unsentcap.com", domain: "unsentcap.com",
      company: "Unsent", lots: [lot], channel: "email", idempotencyKey: "live-after-unsent",
    });
    expect(live.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(liveSendCapacity("unsentcap.com")).toMatchObject({ dailyUsed: 1, dailyRemaining: 19, domainUsed: 1, domainRemaining: 1 });
  });

  it("lets confirmed live sends exhaust daily and domain caps", async () => {
    const lotA = seedLot("Confirmed A");
    const lotB = seedLot("Confirmed B");
    const lotC = seedLot("Confirmed C");
    const buyerId = seedBuyer("realcap.com");
    const conversationId = convo(buyerId, "buy@realcap.com");
    setSetting("outbound_mode", "live");
    let n = 0;
    setGmailClient({
      profile: async () => ({ emailAddress: "saevitzonoverstock@gmail.com" }),
      send: async () => ({ ok: true, id: `gmail-real-${++n}` }),
      listInbox: async () => ({ messages: [], historyId: "1" }),
    });

    for (let i = 0; i < LIVE_DOMAIN_CAP; i++) {
      const lot = i === 0 ? lotA : lotB;
      const r = await guardedOutreach({
        conversationId, buyerId, email: "buy@realcap.com", domain: "realcap.com",
        company: "Real", lots: [lot], channel: "email", idempotencyKey: `real-domain-${i}`,
      });
      expect(r.status).toBe("sent");
    }
    expect(liveSentToDomainToday("realcap.com")).toBe(LIVE_DOMAIN_CAP);
    expect(liveSendCapacity("realcap.com").domainRemaining).toBe(0);

    const blockedDomain = await guardedOutreach({
      conversationId, buyerId, email: "buy@realcap.com", domain: "realcap.com",
      company: "Real", lots: [lotC], channel: "email", idempotencyKey: "real-domain-over",
    });
    expect(blockedDomain.status).toBe("deferred");
    expect(blockedDomain.reason).toMatch(/domain cap/);

    const other = seedBuyer("othercap.com");
    const otherConvo = convo(other, "buy@othercap.com");
    for (let i = 0; i < LIVE_DAILY_CAP - LIVE_DOMAIN_CAP; i++) {
      insertAttempt({
        conversationId: otherConvo,
        buyerId: other,
        status: "sent",
        key: `daily-fill-${i}`,
        providerMessageId: `gmail-fill-${i}`,
        reason: "provider accepted",
      });
    }
    expect(liveSentToday()).toBe(LIVE_DAILY_CAP);
    expect(liveSendCapacity().dailyRemaining).toBe(0);

    const dailyHit = await guardedOutreach({
      conversationId: otherConvo, buyerId: other, email: "buy@othercap.com", domain: "othercap.com",
      company: "Other", lots: [lotC], channel: "email", idempotencyKey: "daily-over",
    });
    expect(dailyHit.status).toBe("deferred");
    expect(dailyHit.reason).toMatch(/daily cap/);
  });
});
