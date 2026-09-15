import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyReply, extractPhone } from "../lib/classify";
import { runMatching } from "../lib/conversations";
import { db, killSwitchOn, setSetting } from "../lib/db";
import { processInbound } from "../lib/inbound";
import { ingestWhatsApp } from "../lib/intake";
import { hardDisqualifier, inferLotCategory, matchBuyerLot, normalizeCategory, validateMandateEvidence } from "../lib/matcher";
import { classifyOliverMedia } from "../lib/media";
import { tick } from "../lib/orchestrator";
import { guardedOutreach } from "../lib/outreach";
import { enrollBuyer, recordMandate } from "../lib/research";
import { isSuppressed, writeBounce, writeUnsubscribe } from "../lib/suppression";
import { writeTestPng } from "./png";

function seedBuyer(domain: string, extras: Record<string, unknown> = {}) {
  const { buyerId } = enrollBuyer({
    company: String(extras.company ?? domain),
    domain,
    categories: String(extras.categories ?? "closeout,apparel,licensed"),
    verification_status: "verified",
    outreach_channel: "email",
  });
  db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=? WHERE id=?").run(extras.cap ?? 5_000_000, buyerId);
  db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, extras.email ?? `buy@${domain}`);
  return buyerId;
}

describe("matcher", () => {
  it("normalizes licensed apparel and toys-before-licensed", () => {
    expect(normalizeCategory("Licensed NFL apparel")).toBe("apparel-licensed");
    expect(normalizeCategory("toys-licensed")).toBe("toys");
    expect(normalizeCategory("Nike sneakers")).toBe("footwear-athletic");
    expect(normalizeCategory("skincare closeout")).toBe("health-beauty");
    expect(normalizeCategory("Lithium-Ion Drill Tool Set")).toBe("tools-hardware");
    expect(normalizeCategory("Foldable remote-control drone")).toBe("electronics");
    expect(inferLotCategory("Lithium-Ion Drill Tool Set", "Hoodies and drills in the same caption")).toBe("tools-hardware");
    expect(inferLotCategory("Available Inventory", "mixed pallet closeout")).toBe("general-merchandise");
    expect(normalizeCategory("slides / sandals closeout")).toBe("footwear-other");
    expect(inferLotCategory("Nike slides", "mixed warehouse photos")).toBe("footwear-other");
  });

  it("hard DQ wins and mandate rejects are do-not-contact", () => {
    const lot = { id: 1, category: "health-beauty", quantity: 1000, unit_price: 2, total_price: 2000 };
    const buyer = {
      id: 1, company: "X", domain: "x.com", channel: "wholesale", categories: "footwear",
      txn_capacity_usd: 100, geography: "domestic", verification_status: "verified",
      source_evidence: null, confidence: 0.8, disqualified_reason: null,
    };
    expect(hardDisqualifier(buyer, lot)).toMatch(/Wrong category|Capacity/);
    const toolsLot = { id: 2, category: "tools-hardware", quantity: 100, unit_price: 10, total_price: 1000 };
    const hoodieLot = { id: 3, category: "apparel-basic", quantity: 1200, unit_price: 4, total_price: 4800 };
    expect(hardDisqualifier({ ...buyer, categories: "US-MI tool crib clean-outs, surplus materials", txn_capacity_usd: 1_000_000 }, toolsLot)).toBeNull();
    expect(hardDisqualifier({ ...buyer, categories: "UK clothing stocklots, knitwear parcels", txn_capacity_usd: 1_000_000 }, hoodieLot)).toBeNull();
    expect(hardDisqualifier({ ...buyer, categories: "UK clothing stocklots", txn_capacity_usd: 1_000_000 }, toolsLot)).toBe("Wrong category");
    expect(hardDisqualifier(
      { ...buyer, categories: "industrial asset recovery", txn_capacity_usd: 1_000_000 },
      toolsLot,
      ["power-tools"],
    )).toBeNull();
    const m = matchBuyerLot(
      { ...buyer, categories: "closeout", txn_capacity_usd: 1_000_000 },
      lot,
      { mandates: [{ id: 1, buyer_id: 1, category: "health-beauty", stance: "rejects", min_units: null, max_units: null, superseded_by: null, confidence: 0.9 }] },
    );
    expect(m.bucket).toBe("doNotContact");
    expect(m.score).toBe(0);
  });

  it("refuses research mandates without evidence", () => {
    expect(() => validateMandateEvidence({ origin: "research" })).toThrow(/sourceUrl/);
  });
});

describe("media", () => {
  it("rejects WhatsApp screenshots and accepts original product photos", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-media-"));
    const good = path.join(dir, "lot.jpg");
    const shot = path.join(dir, "WhatsApp screenshot chat capture.png");
    writeTestPng(good);
    writeTestPng(shot);
    const seen = new Set<string>();
    const a = classifyOliverMedia({ filePath: good, filename: "oliver-product.jpg", seenHashes: seen });
    const b = classifyOliverMedia({ filePath: shot, filename: "WhatsApp screenshot chat capture.png", context: "whatsapp web", seenHashes: new Set() });
    expect(a.outreachSafe).toBe(true);
    expect(b.classification).toBe("screenshot_chat_capture");
    expect(b.outreachSafe).toBe(false);
  });
});

describe("suppression", () => {
  it("opt-out suppresses the domain; bounce does not", () => {
    writeUnsubscribe("buyer@acmewholesale.com");
    expect(isSuppressed("buyer@acmewholesale.com").suppressed).toBe(true);
    expect(isSuppressed("purchasing@acmewholesale.com").suppressed).toBe(true);
    writeBounce("dead@otherco.com");
    expect(isSuppressed("dead@otherco.com").suppressed).toBe(true);
    expect(isSuppressed("alive@otherco.com").suppressed).toBe(false);
  });
});

describe("inbound", () => {
  it("extracts phone and escalates hot replies", async () => {
    expect(extractPhone("call me at 312-555-0199")).toContain("312");
    expect(extractPhone("call me at 818-406-8612")).toBeNull();
    const buyerId = seedBuyer("hotbuyer.com");
    const r = await processInbound({
      from: "buy@hotbuyer.com",
      text: "Yes we are interested. Call me at 312-555-0199. Can we hop on a call this week?",
      providerMessageId: "m1",
    });
    expect(r.escalated).toBe(true);
    expect(r.classification).toBe("request_call");
    const esc = db().prepare("SELECT * FROM escalations WHERE buyer_id=?").get(buyerId) as { phone: string };
    expect(esc.phone).toContain("312");
  });

  it("unsubscribe is none and suppresses", async () => {
    seedBuyer("stop.com");
    const r = await processInbound({ from: "buy@stop.com", text: "Please stop emailing us." });
    expect(r.classification).toBe("unsubscribe");
    expect(isSuppressed("other@stop.com").suppressed).toBe(true);
    expect(classifyReply("Please stop.").classification).toBe("unsubscribe");
  });
});

describe("end-to-end dry run", () => {
  it("WhatsApp lot -> match -> dry-run outreach -> inbound escalate", async () => {
    const buyerId = seedBuyer("fitco.com", { company: "Fit Co", categories: "licensed,apparel,closeout" });
    recordMandate({
      buyerId,
      category: "apparel-licensed",
      stance: "accepts",
      origin: "operator",
      sourceUrl: "https://fitco.com/vendors",
      sourceQuote: "We buy licensed apparel closeouts",
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-lot-"));
    const photo = path.join(dir, "nfl-tees.jpg");
    writeTestPng(photo);

    const ingested = ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-11T12:00:00Z",
      messages: [{
        id: "wa-184",
        at: "2026-09-11T11:55:00Z",
        text: "Licensed NFL apparel 12400 units new $4.10/unit mixed sizes",
        media: [{ filename: "nfl-tees.jpg", path: photo }],
      }],
    });
    expect(ingested.newMessages).toBe(1);
    expect(ingested.lotsTouched.length).toBe(1);

    const lot = db().prepare("SELECT * FROM lots WHERE id=?").get(ingested.lotsTouched[0]) as { id: number; state: string; category: string };
    expect(lot.category).toBe("apparel-licensed");
    const media = db().prepare("SELECT * FROM lot_media WHERE lot_id=?").get(lot.id) as { outreach_safe: number; classification: string };
    expect(media.outreach_safe).toBe(1);

    const matched = await runMatching(lot.id);
    expect(matched.matches).toBeGreaterThan(0);
    const attempt = db().prepare("SELECT * FROM outreach_attempts WHERE buyer_id=?").get(buyerId) as { status: string; media_hashes: string; body: string };
    expect(attempt.status).toBe("dry_run");
    expect(JSON.parse(attempt.media_hashes).length).toBeGreaterThan(0);
    expect(attempt.body).toContain("Saefam Overstock");

    const orch = await tick();
    expect(orch.failed).toBe(0);

    const inbound = await processInbound({
      from: "buy@fitco.com",
      text: "Interested in 5000 units. My cell is 415-555-0100.",
      providerMessageId: "reply-1",
    });
    expect(inbound.escalated).toBe(true);
  });

  it("blocks screenshot media, duplicates, kill switch, and missing media", async () => {
    const buyerId = seedBuyer("block.com");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-block-"));
    const shot = path.join(dir, "whatsapp-screenshot.png");
    writeTestPng(shot);
    ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-11T13:00:00Z",
      messages: [{
        id: "wa-bad",
        at: "2026-09-11T12:55:00Z",
        text: "NFL tees 1000 units",
        media: [{ filename: "whatsapp web screenshot.png", path: shot }],
      }],
    });
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='wa:wa-bad'").get() as { id: number };
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email','buy@block.com')").run(buyerId);
    const blocked = await guardedOutreach({
      conversationId: Number(convo.lastInsertRowid),
      buyerId,
      email: "buy@block.com",
      domain: "block.com",
      company: "Block",
      lots: [{ id: lot.id, title: "tees", category: "apparel-licensed", quantity: 1000, unit_price: 4, brand: "NFL" }],
      channel: "email",
      idempotencyKey: "t1",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/media|screenshot/i);

    const again = await guardedOutreach({
      conversationId: Number(convo.lastInsertRowid),
      buyerId,
      email: "buy@block.com",
      domain: "block.com",
      company: "Block",
      lots: [{ id: lot.id, title: "tees", category: "apparel-licensed", quantity: 1000, unit_price: 4, brand: "NFL" }],
      channel: "email",
      idempotencyKey: "t1",
    });
    expect(again.status).toBe("duplicate");

    setSetting("kill_switch", "true");
    expect(killSwitchOn()).toBe(true);
  });

  it("is idempotent on WhatsApp message id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-idemp-"));
    const photo = path.join(dir, "a.jpg");
    writeTestPng(photo);
    const payload = {
      chat: "oliver",
      scanned_at: "2026-09-11T14:00:00Z",
      messages: [{ id: "same", at: "2026-09-11T14:00:00Z", text: "Nike socks 20000 units $1.10", media: [{ filename: "a.jpg", path: photo }] }],
    };
    expect(ingestWhatsApp(payload).newMessages).toBe(1);
    expect(ingestWhatsApp(payload).newMessages).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM lots").get() as { n: number }).n).toBe(1);
  });

  it("applies recovered media on a later POST of the same WhatsApp id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-late-media-"));
    const photo = path.join(dir, "late.jpg");
    writeTestPng(photo);
    const first = ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-14T17:01:00Z",
      messages: [{ id: "wa-album-later", at: "2026-09-14T17:01:00Z", text: "Drill sets 3000 $9.80", media: [] }],
    });
    expect(first.newMessages).toBe(1);
    const lot = db().prepare("SELECT id, state FROM lots WHERE external_key='wa:wa-album-later'").get() as { id: number; state: string };
    expect(lot.state).toBe("paused");
    const again = ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-14T17:13:00Z",
      messages: [{ id: "wa-album-later", at: "2026-09-14T17:01:00Z", text: "Drill sets 3000 $9.80", media: [{ filename: "late.jpg", path: photo }] }],
    });
    expect(again.newMessages).toBe(0);
    expect(again.lotsTouched).toContain(lot.id);
    const media = db().prepare("SELECT COUNT(*) AS n FROM lot_media WHERE lot_id=? AND outreach_safe=1").get(lot.id) as { n: number };
    expect(media.n).toBe(1);
    const restored = db().prepare("SELECT state, availability, project_gate FROM lots WHERE id=?").get(lot.id) as { state: string; availability: string; project_gate: string };
    expect(restored.state).toBe("matchable");
    expect(restored.availability).toBe("active");
  });
});
