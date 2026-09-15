import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POST as postFindings } from "../app/api/research/findings/route";
import { runMatching } from "../lib/conversations";
import { outboundMode, db } from "../lib/db";
import { lotHasSendableMedia, selectSendableLots } from "../lib/email/attachments";
import { AUTHORIZED_SENDER } from "../lib/email/address";
import { getGmailClient, sendAuthorizedEmail, setGmailClient } from "../lib/email/provider";
import { openHandoffs } from "../lib/escalate";
import { processInbound } from "../lib/inbound";
import { ingestWhatsApp } from "../lib/intake";
import { tick } from "../lib/orchestrator";
import { discoverQuery, enrollBuyer, researchTick } from "../lib/research";
import { writeUnsubscribe } from "../lib/suppression";

const HOODIE_PHOTO = path.join(os.homedir(), ".bmsmoneynigga/media/oliver/55/3AFE50765D8531461670_hoodies.jpg");
const HOODIE_SHA = "6a004eaae280cb3142c8a6b47028f8eb771d98371196fc3a6fb5b635ed28534b";
const DECOY_PHOTO = path.join(os.homedir(), ".bmsmoneynigga/media/oliver/54/3A801BF1AA6202F71555_cardigans.jpg");
const DECOY_SHA = "3de995f598a5cdf1046e95df00ac958578841f9bad86203cfb8cc6b773dd63f7";

function findingsReq(body: unknown) {
  return new Request("http://localhost:3222/api/research/findings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("operational readiness #1 dry-run sales loop", () => {
  it("Oliver hoodie lot → research → match → opportunity → dry-run gate → phone handoff", async () => {
    expect(outboundMode()).toBe("dry_run");
    expect(fs.existsSync(HOODIE_PHOTO)).toBe(true);
    expect(fs.existsSync(DECOY_PHOTO)).toBe(true);

    const ingestedHoodie = ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-11T18:00:00Z",
      messages: [{
        id: "wa-oliver-55",
        at: "2026-09-11T17:55:00Z",
        text: "Hoodies\n\nEach container is\n\n8000 black\n\n4000 navy\n\n4000 gray\n\n2 containers coming by 9/12",
        media: [{ filename: "3AFE50765D8531461670_hoodies.jpg", path: HOODIE_PHOTO }],
      }],
    });
    const hoodieId = ingestedHoodie.lotsTouched[0];
    const hoodie = db().prepare("SELECT id, title, category, quantity, state, availability, project_gate FROM lots WHERE id=?").get(hoodieId) as {
      id: number; title: string; category: string; quantity: number | null; state: string; availability: string; project_gate: string;
    };
    const hoodieMedia = db().prepare("SELECT sha256, filename, classification, outreach_safe, association_certain, path FROM lot_media WHERE lot_id=?").get(hoodieId) as {
      sha256: string; filename: string; classification: string; outreach_safe: number; association_certain: number; path: string;
    };
    expect(hoodie.title).toMatch(/Hoodies/i);
    expect(hoodie.category).toBe("apparel-basic");
    expect(hoodie.quantity).toBe(8000);
    expect(hoodie.state).toBe("matchable");
    expect(hoodie.availability).toBe("active");
    expect(hoodie.project_gate).not.toBe("DO_NOT_MARKET");
    expect(hoodieMedia.sha256).toBe(HOODIE_SHA);
    expect(hoodieMedia.classification).toBe("clean_product_photo");
    expect(hoodieMedia.outreach_safe).toBe(1);
    expect(hoodieMedia.association_certain).toBe(1);
    expect(lotHasSendableMedia(hoodieId)).toBe(true);

    ingestWhatsApp({
      chat: "oliver",
      scanned_at: "2026-09-11T18:01:00Z",
      messages: [{
        id: "wa-decoy-footwear",
        at: "2026-09-11T18:00:00Z",
        text: "Nike sneakers 20000 units $8 athletic closeout",
        media: [{ filename: "3A801BF1AA6202F71555_cardigans.jpg", path: DECOY_PHOTO }],
      }],
    });
    const decoyId = (db().prepare("SELECT id FROM lots WHERE external_key='wa:wa-decoy-footwear'").get() as { id: number }).id;
    expect(lotHasSendableMedia(decoyId)).toBe(true);

    const beforeBuyers = await tick();
    expect(beforeBuyers.failed).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts").get() as { n: number }).n).toBe(0);

    const queued = researchTick();
    expect(queued.seeded).toBeGreaterThanOrEqual(1);
    expect(queued.queued).toBeGreaterThanOrEqual(1);
    const job = db().prepare(
      "SELECT id, query, lot_id, state FROM research_jobs WHERE lot_id=? AND kind='discover' AND state='pending'"
    ).get(hoodieId) as { id: number; query: string; lot_id: number; state: string };
    expect(job.query).toBe(discoverQuery({ id: hoodieId, category: hoodie.category, title: hoodie.title }));

    const first = await postFindings(findingsReq({
      agent: "BUYER_RESEARCHER",
      lotId: hoodieId,
      buyers: [{
        company: "Merchandise USA",
        domain: "merchandiseusa.com",
        categories: "closeout,apparel",
        verification: "clay_verified",
        evidence: [{ url: "https://merchandiseusa.com/buy", quote: "We buy apparel closeouts and hoodies" }],
        endpoints: [{
          channel: "email",
          handle: "buying@merchandiseusa.com",
          source: "https://merchandiseusa.com/contact",
          evidence: "mailto:buying@merchandiseusa.com on contact page",
          confidence: 0.9,
          outreach_permitted: true,
          executable: true,
        }],
        mandate: {
          category: "apparel-basic",
          stance: "accepts",
          sourceUrl: "https://merchandiseusa.com/buy",
          sourceQuote: "We buy apparel closeouts and hoodies",
        },
      }],
    }));
    const enrolled = await first.json() as { ok: boolean; buyerIds: number[] };
    expect(enrolled.ok).toBe(true);
    const buyerId = enrolled.buyerIds[0];
    db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=5000000 WHERE id=?").run(buyerId);

    const again = await postFindings(findingsReq({
      agent: "BUYER_RESEARCHER",
      lotId: hoodieId,
      buyers: [{
        company: "Merchandise USA",
        domain: "merchandiseusa.com",
        categories: "closeout,apparel",
        verification: "clay_verified",
        endpoints: [{
          channel: "email",
          handle: "buying@merchandiseusa.com",
          source: "https://merchandiseusa.com/contact",
          evidence: "mailto:buying@merchandiseusa.com on contact page",
          confidence: 0.9,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const deduped = await again.json() as { ok: boolean; buyerIds: number[] };
    expect(deduped.buyerIds).toEqual([buyerId]);
    expect((db().prepare("SELECT COUNT(*) AS n FROM buyers WHERE domain='merchandiseusa.com'").get() as { n: number }).n).toBe(1);

    const afterResearch = await tick();
    expect(afterResearch.failed).toBe(0);
    expect(afterResearch.processed).toBeGreaterThan(0);

    const score = db().prepare("SELECT buyer_id, score, hard_disqualified FROM match_scores WHERE lot_id=? AND buyer_id=?").get(hoodieId, buyerId) as {
      buyer_id: number; score: number; hard_disqualified: string | null;
    };
    expect(score.hard_disqualified).toBeNull();
    expect(score.score).toBeGreaterThanOrEqual(0.45);

    const opp = db().prepare("SELECT id, stage, lot_ids FROM opportunities WHERE buyer_id=?").get(buyerId) as {
      id: number; stage: string; lot_ids: string;
    };
    expect(JSON.parse(opp.lot_ids)).toEqual([hoodieId]);
    expect(opp.stage).toBe("dry_run");

    const attempt = db().prepare("SELECT status, reason, subject, body, media_hashes, lot_ids FROM outreach_attempts WHERE buyer_id=?").get(buyerId) as {
      status: string; reason: string; subject: string; body: string; media_hashes: string; lot_ids: string;
    };
    expect(attempt.status).toBe("dry_run");
    expect(attempt.reason).toMatch(/dry_run/);
    expect(JSON.parse(attempt.lot_ids)).toEqual([hoodieId]);
    expect(attempt.subject).toContain("Hoodies");
    expect(attempt.subject).not.toMatch(/Nike|sneaker/i);
    expect(attempt.body).toContain("Merchandise USA");
    expect(attempt.body).toContain("Hoodies");
    expect(attempt.body).toMatch(/8,?000/);
    expect(attempt.body).not.toMatch(/Nike sneakers/i);
    expect(JSON.parse(attempt.media_hashes)).toEqual([HOODIE_SHA]);
    expect(JSON.parse(attempt.media_hashes)).not.toContain(DECOY_SHA);
    const pick = selectSendableLots([{
      id: hoodieId, title: hoodie.title, category: hoodie.category, quantity: hoodie.quantity, unit_price: null, brand: null,
    }]);
    expect(pick.ok).toBe(true);
    if (pick.ok) {
      expect(pick.pick.hashes).toEqual([HOODIE_SHA]);
      expect(pick.pick.attachments[0].filename).toContain("hoodies");
    }

    const sendCalls: unknown[] = [];
    setGmailClient({
      profile: async () => ({ emailAddress: AUTHORIZED_SENDER }),
      send: async (input) => {
        sendCalls.push(input);
        return { ok: true, id: "should-not-send" };
      },
      listInbox: async () => ({ messages: [], historyId: "1" }),
    });
    const gated = await getGmailClient().send({
      to: "buying@merchandiseusa.com",
      subject: attempt.subject,
      body: attempt.body,
      attachments: pick.ok ? pick.pick.attachments : [],
      lotIds: [hoodieId],
      domain: "merchandiseusa.com",
    });
    const gatedAuth = await sendAuthorizedEmail({
      to: "buying@merchandiseusa.com",
      subject: attempt.subject,
      body: attempt.body,
      attachments: [],
      lotIds: [hoodieId],
      domain: "merchandiseusa.com",
    });
    expect(gated).toEqual({ ok: false, error: "outbound_mode is not live" });
    expect(gatedAuth).toEqual({ ok: false, error: "outbound_mode is not live" });
    expect(sendCalls).toHaveLength(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE status='sent'").get() as { n: number }).n).toBe(0);

    const rematch = await runMatching(hoodieId);
    expect(rematch.queued).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE buyer_id=?").get(buyerId) as { n: number }).n).toBe(1);

    writeUnsubscribe("buying@merchandiseusa.com");
    const { buyerId: otherId } = enrollBuyer({
      company: "Suppressed Twin",
      domain: "suppressedtwin.com",
      categories: "closeout,apparel",
      verification_status: "verified",
      outreach_channel: "email",
    });
    db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=5000000 WHERE id=?").run(otherId);
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buying@merchandiseusa.com','verified')").run(otherId);
    await runMatching(hoodieId);
    const suppressedAttempt = db().prepare("SELECT id FROM outreach_attempts WHERE buyer_id=?").get(otherId);
    expect(suppressedAttempt).toBeUndefined();

    const inbound = await processInbound({
      from: "buying@merchandiseusa.com",
      text: "Interested in the hoodies. Call 312-555-0148 for 4000 units.",
      providerMessageId: "ops-loop-reply-1",
    });
    expect(inbound.escalated).toBe(true);
    const handoff = openHandoffs()[0];
    expect(handoff.packet).toContain("Merchandise USA");
    expect(handoff.packet).toContain("312-555-0148");
    expect(handoff.packet).toContain("Hoodies");
    expect(handoff.packet).not.toMatch(/OLIVER HANDOFF/);
    expect((db().prepare("SELECT next_action, state FROM conversations WHERE buyer_id=?").get(buyerId) as { next_action: string; state: string })).toMatchObject({
      state: "escalated",
      next_action: "oliver_handoff",
    });
    const afterHandoff = await runMatching(hoodieId);
    expect(afterHandoff.queued).toBe(0);
    expect(outboundMode()).toBe("dry_run");
    expect(sendCalls).toHaveLength(0);
  });
});
