import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordEndpoint, selectChannel } from "../lib/channels/select";
import { db, outboundMode, setSetting } from "../lib/db";
import { AUTHORIZED_SENDER, DENIED_SENDER, assertAuthorizedSender, parseRecipient } from "../lib/email/address";
import { selectSendableLots } from "../lib/email/attachments";
import { buildRawMessage } from "../lib/email/mime";
import { setGmailClient, type GmailClient, type GmailSendInput } from "../lib/email/provider";
import { syncGmailInbox } from "../lib/email/sync";
import { GMAIL_SCOPES, tokenPath } from "../lib/email/tokens";
import { processInbound } from "../lib/inbound";
import { ingestWhatsApp } from "../lib/intake";
import { guardedOutreach } from "../lib/outreach";
import { enrollBuyer } from "../lib/research";
import { isSuppressed } from "../lib/suppression";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-email-"));
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
  const id = ingested.lotsTouched[0];
  const row = db().prepare("SELECT id, title, category, quantity, unit_price, brand FROM lots WHERE id=?").get(id) as {
    id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null;
  };
  return row;
}

function convo(buyerId: number, email: string) {
  return Number(db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email',?)").run(buyerId, email).lastInsertRowid);
}

function mockGmail(overrides: Partial<GmailClient> = {}) {
  const sent: GmailSendInput[] = [];
  const client: GmailClient = {
    profile: async () => ({ emailAddress: AUTHORIZED_SENDER }),
    send: async (input) => {
      sent.push(input);
      return { ok: true, id: `gmail-${sent.length}` };
    },
    listInbox: async () => ({ messages: [], historyId: "1" }),
    ...overrides,
  };
  setGmailClient(client);
  return { sent, client };
}

describe("1 Gmail provider + MIME + From lock", () => {
  it("builds RFC MIME with authorized From and inline original photos", () => {
    const raw = buildRawMessage({
      from: AUTHORIZED_SENDER,
      to: "buy@fitco.com",
      subject: "Wholesale availability — tees",
      body: "Photos attached are the supplier's original lot photos.",
      attachments: [{
        filename: "oliver-product.jpg",
        mime: "image/jpeg",
        contentBase64: Buffer.from("fake-jpg").toString("base64"),
        contentId: "lot-54-abc123",
      }],
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain(`From: ${AUTHORIZED_SENDER}`);
    expect(decoded).toContain("To: buy@fitco.com");
    expect(decoded).toContain("Content-ID: <lot-54-abc123>");
    expect(decoded).toContain("Content-Disposition: inline");
    expect(decoded).toContain("multipart/mixed");
    expect(() => buildRawMessage({
      from: DENIED_SENDER,
      to: "buy@fitco.com",
      subject: "x",
      body: "y",
    })).toThrow(/From must be/);
    expect(assertAuthorizedSender(DENIED_SENDER).ok).toBe(false);
    expect(GMAIL_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(tokenPath()).toMatch(/gmail-oauth\.enc$/);
  });

  it("refuses live send when authenticated identity is not the authorized mailbox", async () => {
    const lot = seedLot("NFL tees", true);
    const buyerId = seedBuyer("wrongident.com");
    const conversationId = convo(buyerId, "buy@wrongident.com");
    setSetting("outbound_mode", "live");
    mockGmail({ profile: async () => ({ emailAddress: DENIED_SENDER }) });
    const result = await guardedOutreach({
      conversationId, buyerId, email: "buy@wrongident.com", domain: "wrongident.com",
      company: "Wrong", lots: [lot], channel: "email", idempotencyKey: "ident-1",
    });
    expect(result.status).toBe("failed");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not authorized|banned/);
  });
});

describe("2 Gmail inbox sync", () => {
  it("routes replies, unsubscribes, bounces, and phones into processInbound", async () => {
    seedBuyer("inboxco.com");
    seedBuyer("stopco.com");
    seedBuyer("bounceco.com");
    mockGmail({
      listInbox: async () => ({
        historyId: "99",
        messages: [
          {
            providerMessageId: "g-reply",
            from: "Buyer <buy@inboxco.com>",
            to: AUTHORIZED_SENDER,
            subject: "Re: lot",
            text: "Yes interested. Call 312-555-0142 this week.",
            bounced: false,
          },
          {
            providerMessageId: "g-unsub",
            from: "buy@stopco.com",
            to: AUTHORIZED_SENDER,
            subject: "stop",
            text: "Please stop emailing us.",
            bounced: false,
          },
          {
            providerMessageId: "g-bounce",
            from: "Mail Delivery Subsystem <mailer-daemon@google.com>",
            to: AUTHORIZED_SENDER,
            subject: "Delivery Status Notification (Failure)",
            text: "550 address not found",
            bounced: true,
            failedRecipient: "buy@bounceco.com",
          },
        ],
      }),
    });
    const synced = await syncGmailInbox();
    expect(synced.ok).toBe(true);
    expect(synced.ingested).toBe(3);
    const reply = processInbound({ from: "buy@inboxco.com", text: "dup", providerMessageId: "g-reply" });
    expect(reply.classification).toBe("duplicate");
    const inbound = db().prepare("SELECT classification, phone, from_address FROM inbound_events ORDER BY id").all() as Array<{
      classification: string; phone: string | null; from_address: string;
    }>;
    expect(inbound.map((r) => r.classification)).toEqual(["positive_interest", "unsubscribe", "bounce"]);
    expect(inbound[0].phone).toContain("312");
    expect(inbound[0].from_address).toBe("buy@inboxco.com");
    expect(isSuppressed("other@stopco.com").suppressed).toBe(true);
    expect(isSuppressed("buy@bounceco.com").suppressed).toBe(true);
    expect(isSuppressed("alive@bounceco.com").suppressed).toBe(false);
    expect(db().prepare("SELECT value FROM settings WHERE key='gmail_history_id'").get() as { value: string }).toEqual({ value: "99" });
  });
});

describe("3 dry-run to live promotion", () => {
  it("promotes the same idempotency row to one real send", async () => {
    const lot = seedLot("Licensed tees", true);
    const buyerId = seedBuyer("promoteco.com");
    const conversationId = convo(buyerId, "buy@promoteco.com");
    const input = {
      conversationId, buyerId, email: "buy@promoteco.com", domain: "promoteco.com",
      company: "Promote Co", lots: [lot], channel: "email", idempotencyKey: "promo-1",
    };
    const dry = await guardedOutreach(input);
    expect(dry.status).toBe("dry_run");
    const againDry = await guardedOutreach(input);
    expect(againDry.status).toBe("duplicate");
    expect(againDry.attemptId).toBe(dry.attemptId);

    setSetting("outbound_mode", "live");
    const { sent } = mockGmail();
    const live = await guardedOutreach(input);
    expect(live.status).toBe("sent");
    expect(live.attemptId).toBe(dry.attemptId);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("buy@promoteco.com");
    const rows = db().prepare("SELECT id, status FROM outreach_attempts WHERE idempotency_key='promo-1'").all() as Array<{ id: number; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");

    const twice = await guardedOutreach(input);
    expect(twice.status).toBe("duplicate");
    expect(twice.reason).toBe("already sent");
    expect(sent).toHaveLength(1);
  });
});

describe("4 dry-run counters vs live caps", () => {
  it("does not let dry-runs consume daily or domain live capacity", async () => {
    const lotA = seedLot("Cap tees A", true);
    const lotB = seedLot("Cap tees B", true);
    const lotC = seedLot("Cap tees C", true);
    const buyerId = seedBuyer("capco.com");
    const conversationId = convo(buyerId, "buy@capco.com");
    for (let i = 0; i < 20; i++) {
      const r = await guardedOutreach({
        conversationId, buyerId, email: "buy@capco.com", domain: "capco.com",
        company: "Cap", lots: [lotA], channel: "email", idempotencyKey: `dry-cap-${i}`,
      });
      expect(r.status).toBe("dry_run");
    }
    setSetting("outbound_mode", "live");
    const { sent } = mockGmail();
    const first = await guardedOutreach({
      conversationId, buyerId, email: "buy@capco.com", domain: "capco.com",
      company: "Cap", lots: [lotA], channel: "email", idempotencyKey: "live-after-dry",
    });
    expect(first.status).toBe("sent");
    expect(sent).toHaveLength(1);

    const second = await guardedOutreach({
      conversationId, buyerId, email: "buy@capco.com", domain: "capco.com",
      company: "Cap", lots: [lotB], channel: "email", idempotencyKey: "live-domain-2",
    });
    expect(second.status).toBe("sent");

    const third = await guardedOutreach({
      conversationId, buyerId, email: "buy@capco.com", domain: "capco.com",
      company: "Cap", lots: [lotC], channel: "email", idempotencyKey: "live-domain-3",
    });
    expect(third.status).toBe("blocked");
    expect(third.reason).toMatch(/domain cap/);
  });
});

describe("5 outbound mode is settings-first", () => {
  it("does not let process.env.OUTBOUND_MODE override settings, and defaults dry_run", () => {
    expect(outboundMode()).toBe("dry_run");
    process.env.OUTBOUND_MODE = "live";
    expect(outboundMode()).toBe("dry_run");
    setSetting("outbound_mode", "live");
    process.env.OUTBOUND_MODE = "dry_run";
    expect(outboundMode()).toBe("live");
    setSetting("outbound_mode", "dry_run");
    process.env.OUTBOUND_MODE = "dry_run";
    expect(outboundMode()).toBe("dry_run");
    const startSh = fs.readFileSync(path.join(process.cwd(), "start.sh"), "utf8");
    expect(startSh).not.toMatch(/export OUTBOUND_MODE=/);
  });
});

describe("6 From lock at send time", () => {
  it("sends only after identity assert and MIME From is authorized", async () => {
    const lot = seedLot("From lock tees", true);
    const buyerId = seedBuyer("fromlock.com");
    const conversationId = convo(buyerId, "buy@fromlock.com");
    setSetting("outbound_mode", "live");
    const { sent } = mockGmail();
    const r = await guardedOutreach({
      conversationId, buyerId, email: "buy@fromlock.com", domain: "fromlock.com",
      company: "FromLock", lots: [lot], channel: "email", idempotencyKey: "from-1",
    });
    expect(r.status).toBe("sent");
    const mime = buildRawMessage({
      from: AUTHORIZED_SENDER,
      to: sent[0].to,
      subject: sent[0].subject,
      body: sent[0].body,
      attachments: sent[0].attachments,
    });
    expect(Buffer.from(mime, "base64url").toString("utf8")).toContain(`From: ${AUTHORIZED_SENDER}`);
    expect(assertAuthorizedSender("bailey@berkeley.edu").ok).toBe(false);
  });
});

describe("7 media gating subset", () => {
  it("blocks media-less live email and still sends a valid 1-lot subset", async () => {
    const bad = seedLot("No photo lot", false);
    const good = seedLot("Oliver product lot", true);
    const buyerId = seedBuyer("mediaco.com");
    const conversationId = convo(buyerId, "buy@mediaco.com");
    setSetting("outbound_mode", "live");
    const { sent } = mockGmail();

    const none = await guardedOutreach({
      conversationId, buyerId, email: "buy@mediaco.com", domain: "mediaco.com",
      company: "Media", lots: [bad], channel: "email", idempotencyKey: "media-none",
    });
    expect(none.status).toBe("blocked");
    expect(none.reason).toMatch(/verified Oliver media/);
    expect(sent).toHaveLength(0);

    const subset = await guardedOutreach({
      conversationId, buyerId, email: "buy@mediaco.com", domain: "mediaco.com",
      company: "Media", lots: [bad, good], channel: "email", idempotencyKey: "media-subset",
    });
    expect(subset.status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments.length).toBeGreaterThan(0);
    expect(sent[0].body).toContain(good.title);
    expect(sent[0].body).not.toContain(bad.title);
    const row = db().prepare("SELECT lot_ids FROM outreach_attempts WHERE idempotency_key='media-subset'").get() as { lot_ids: string };
    expect(JSON.parse(row.lot_ids)).toEqual([good.id]);
    const pick = selectSendableLots([bad, good]);
    expect(pick.ok).toBe(true);
    if (pick.ok) expect(pick.pick.lots.map((l) => l.id)).toEqual([good.id]);
  });
});

describe("8 To: address normalization", () => {
  it("rejects phone/URL/blob handles before Gmail and skips them as endpoints", async () => {
    expect(parseRecipient("sales@x.com; 555-123-4567; https://x.com").ok).toBe(false);
    expect(parseRecipient("sales@x.com 5551234567").ok).toBe(false);
    expect(parseRecipient("https://acme.com/contact").ok).toBe(false);
    expect(parseRecipient("Fit Co <buy@fitco.com>").ok).toBe(true);
    expect(parseRecipient(AUTHORIZED_SENDER).ok).toBe(false);

    const lot = seedLot("Blob tees", true);
    const buyerId = seedBuyer("blobco.com");
    const conversationId = convo(buyerId, "sales@blobco.com; 555-123-4567; https://blobco.com");
    const { sent } = mockGmail();
    setSetting("outbound_mode", "live");
    const r = await guardedOutreach({
      conversationId, buyerId,
      email: "sales@blobco.com; 555-123-4567; https://blobco.com",
      domain: "blobco.com",
      company: "Blob", lots: [lot], channel: "email", idempotencyKey: "blob-1",
    });
    expect(r.status).toBe("blocked");
    expect(r.reason).toMatch(/blob|URL|phone/i);
    expect(sent).toHaveLength(0);

    const messy = seedBuyer("messy.com");
    db().prepare("UPDATE buyer_contacts SET email=? WHERE buyer_id=?").run("sales@messy.com; 818-406-8612; https://messy.com", messy);
    recordEndpoint({ buyerId: messy, channel: "email", handle: "sales@messy.com; phone; https://x.com", confidence: 0.9, verified: true });
    expect(selectChannel(messy)).toBeNull();
  });
});
