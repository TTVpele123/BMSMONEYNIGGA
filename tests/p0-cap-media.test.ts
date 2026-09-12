import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMatching } from "../lib/conversations";
import { db, setSetting } from "../lib/db";
import { lotHasSendableMedia } from "../lib/email/attachments";
import { setGmailClient } from "../lib/email/provider";
import { ingestWhatsApp } from "../lib/intake";
import { researchCoverage } from "../lib/metrics";
import { guardedOutreach } from "../lib/outreach";
import { isCapacityReason, pauseLotsMissingOriginalMedia, repairStaleDailyCapBlocks } from "../lib/repairs";
import { enrollBuyer, recordMandate, researchTick } from "../lib/research";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-p0-"));
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
  return db().prepare("SELECT id, title, category, quantity, unit_price, brand, state, availability, project_gate FROM lots WHERE id=?").get(ingested.lotsTouched[0]) as {
    id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null;
    state: string; availability: string; project_gate: string;
  };
}

function convo(buyerId: number, email: string) {
  return Number(db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email',?)").run(buyerId, email).lastInsertRowid);
}

describe("P0 #1 capacity blocks are retryable", () => {
  it("treats stale daily-cap blocked rows as retryable and leaves other blocks permanent", async () => {
    expect(isCapacityReason("daily cap")).toBe(true);
    expect(isCapacityReason("daily cap 20")).toBe(true);
    expect(isCapacityReason("domain cap 2")).toBe(true);
    expect(isCapacityReason("kill switch")).toBe(false);

    const lot = seedLot("Retry tees", true);
    const buyerId = seedBuyer("retrycap.com");
    const conversationId = convo(buyerId, "buy@retrycap.com");
    const cap = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[]','','','[]','blocked','daily cap','retry-cap-1')`
    ).run(conversationId, buyerId, "email");
    const kill = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[]','','','[]','blocked','kill switch','retry-kill-1')`
    ).run(conversationId, buyerId, "email");
    const other = db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[]','','','[]','blocked','no verified Oliver media for any offered lot','retry-media-1')`
    ).run(conversationId, buyerId, "email");

    expect(repairStaleDailyCapBlocks()).toEqual({ repaired: 1 });
    expect(repairStaleDailyCapBlocks()).toEqual({ repaired: 0 });
    const capRow = db().prepare("SELECT status, reason FROM outreach_attempts WHERE id=?").get(Number(cap.lastInsertRowid)) as { status: string; reason: string };
    expect(capRow.status).toBe("failed");
    expect(capRow.reason).toBe("daily cap (retryable)");
    expect((db().prepare("SELECT status FROM outreach_attempts WHERE id=?").get(Number(kill.lastInsertRowid)) as { status: string }).status).toBe("blocked");
    expect((db().prepare("SELECT status FROM outreach_attempts WHERE id=?").get(Number(other.lastInsertRowid)) as { status: string }).status).toBe("blocked");

    const again = await guardedOutreach({
      conversationId, buyerId, email: "buy@retrycap.com", domain: "retrycap.com",
      company: "Retry", lots: [lot], channel: "email", idempotencyKey: "retry-cap-1",
    });
    expect(again.status).toBe("dry_run");
    expect(again.attemptId).toBe(Number(cap.lastInsertRowid));
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE idempotency_key='retry-cap-1'").get() as { n: number }).n).toBe(1);

    const stillKill = await guardedOutreach({
      conversationId, buyerId, email: "buy@retrycap.com", domain: "retrycap.com",
      company: "Retry", lots: [lot], channel: "email", idempotencyKey: "retry-kill-1",
    });
    expect(stillKill.status).toBe("duplicate");
    expect(stillKill.reason).toMatch(/already blocked/);
  });

  it("retries a blocked daily-cap row even before repair runs", async () => {
    const lot = seedLot("Pre-repair tees", true);
    const buyerId = seedBuyer("prerepair.com");
    const conversationId = convo(buyerId, "buy@prerepair.com");
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[]','','','[]','blocked','daily cap','pre-repair-1')`
    ).run(conversationId, buyerId, "email");
    const r = await guardedOutreach({
      conversationId, buyerId, email: "buy@prerepair.com", domain: "prerepair.com",
      company: "Pre", lots: [lot], channel: "email", idempotencyKey: "pre-repair-1",
    });
    expect(r.status).toBe("dry_run");
    expect((db().prepare("SELECT status FROM outreach_attempts WHERE idempotency_key='pre-repair-1'").get() as { status: string }).status).toBe("dry_run");
  });

  it("does not permanently block when live daily cap is hit", async () => {
    const lot = seedLot("Live cap tees", true);
    const buyerId = seedBuyer("livecap.com");
    const conversationId = convo(buyerId, "buy@livecap.com");
    setSetting("outbound_mode", "live");
    setGmailClient({
      profile: async () => ({ emailAddress: "saevitzonoverstock@gmail.com" }),
      send: async () => ({ ok: true, id: "g1" }),
      listInbox: async () => ({ messages: [], historyId: "1" }),
    });
    for (let i = 0; i < 20; i++) {
      db().prepare(
        `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
         VALUES(?,?,?,'[]','','','[]','sent','provider accepted',?,?)`
      ).run(conversationId, buyerId, "email", `prior-sent-${i}`, `gmail-prior-${i}`);
    }
    const hit = await guardedOutreach({
      conversationId, buyerId, email: "buy@livecap.com", domain: "livecap.com",
      company: "LiveCap", lots: [lot], channel: "email", idempotencyKey: "cap-hit-1",
    });
    expect(hit.status).toBe("deferred");
    expect(hit.reason).toMatch(/daily cap/);
    const row = db().prepare("SELECT status FROM outreach_attempts WHERE idempotency_key='cap-hit-1'").get() as { status: string };
    expect(row.status).toBe("failed");

    db().prepare("DELETE FROM outreach_attempts WHERE status='sent' AND idempotency_key LIKE 'prior-sent-%'").run();
    const retried = await guardedOutreach({
      conversationId, buyerId, email: "buy@livecap.com", domain: "livecap.com",
      company: "LiveCap", lots: [lot], channel: "email", idempotencyKey: "cap-hit-1",
    });
    expect(retried.status).toBe("sent");
    expect(retried.attemptId).toBe(hit.attemptId);
  });
});

describe("P0 #2 media-gate matching and research", () => {
  it("pauses media-less lots and never matches, researches, or bundles them", async () => {
    const good = seedLot("Licensed NFL apparel", true);
    const bad = seedLot("No photo lot", false);
    expect(lotHasSendableMedia(good.id)).toBe(true);
    expect(lotHasSendableMedia(bad.id)).toBe(false);
    expect(bad.state).toBe("paused");
    expect(bad.project_gate).toBe("DO_NOT_MARKET");
    expect(bad.availability).toBe("paused");
    expect(good.state).not.toBe("paused");
    expect(good.project_gate).not.toBe("DO_NOT_MARKET");

    const before = (db().prepare("SELECT COUNT(*) AS n FROM lots").get() as { n: number }).n;
    const paused = pauseLotsMissingOriginalMedia();
    expect(paused.eligible).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM lots").get() as { n: number }).n).toBe(before);

    const buyerId = seedBuyer("bundleco.com");
    recordMandate({
      buyerId,
      category: "apparel-licensed",
      stance: "accepts",
      origin: "operator",
      sourceUrl: "https://bundleco.com/vendors",
      sourceQuote: "We buy licensed apparel closeouts",
    });
    db().prepare(
      `INSERT INTO match_scores(lot_id,buyer_id,score,bucket,capacity_score,product_fit_score,geography_score,history_score,contact_score,rationale)
       VALUES(?,?,0.9,'strong',1,1,1,1,1,'test')`
    ).run(good.id, buyerId);
    db().prepare(
      `INSERT INTO match_scores(lot_id,buyer_id,score,bucket,capacity_score,product_fit_score,geography_score,history_score,contact_score,rationale)
       VALUES(?,?,0.95,'strong',1,1,1,1,1,'test')`
    ).run(bad.id, buyerId);

    const skipped = await runMatching(bad.id);
    expect(skipped.matches).toBe(0);
    expect(skipped.queued).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM opportunities").get() as { n: number }).n).toBe(0);

    const matched = await runMatching(good.id);
    expect(matched.queued).toBeGreaterThan(0);
    const opps = db().prepare("SELECT lot_ids FROM opportunities").all() as { lot_ids: string }[];
    expect(opps.length).toBeGreaterThan(0);
    for (const o of opps) {
      const ids = JSON.parse(o.lot_ids) as number[];
      expect(ids).toContain(good.id);
      expect(ids).not.toContain(bad.id);
    }
    const attached = db().prepare("SELECT lot_id FROM conversation_lots").all() as { lot_id: number }[];
    expect(attached.every((r) => r.lot_id !== bad.id)).toBe(true);

    db().prepare("DELETE FROM research_jobs").run();
    const tick = researchTick();
    expect(tick.seeded).toBe(1);
    const jobs = db().prepare("SELECT query FROM research_jobs").all() as { query: string }[];
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => !j.query.includes("No photo lot"))).toBe(true);
    expect(jobs.some((j) => j.query.includes(good.title))).toBe(true);

    const coverage = researchCoverage();
    const ids = (coverage.lots as Array<{ id: number }>).map((l) => l.id);
    expect(ids).toContain(good.id);
    expect(ids).not.toContain(bad.id);
  });
});
