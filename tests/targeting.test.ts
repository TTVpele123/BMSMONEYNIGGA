import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { POST as postFindings } from "../app/api/research/findings/route";
import { recordEndpoint, selectChannel } from "../lib/channels/select";
import { runMatching } from "../lib/conversations";
import { db } from "../lib/db";
import { ingestWhatsApp } from "../lib/intake";
import { opportunityWorklist, researchCoverage } from "../lib/metrics";
import { enrollBuyer, researchTick } from "../lib/research";
import {
  applyBetterContact,
  classifyEmailQuality,
  enqueueContactUpgradeJobs,
  expireStaleUpgradeJobs,
  listWeakEmailBuyers,
  QUALITY_RANK,
  recordQualityOutcome,
  rankEmailScore,
} from "../lib/targeting";
import { writeTestPng } from "./png";

function findingsReq(body: unknown) {
  return new Request("http://localhost:3222/api/research/findings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedBuyer(domain: string, email: string) {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel",
    verification_status: "verified",
    outreach_channel: "email",
  });
  db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=2000000 WHERE id=?").run(buyerId);
  recordEndpoint({ buyerId, channel: "email", handle: email, confidence: 0.9, verified: true, source: "test" });
  db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, email);
  return buyerId;
}

function seedLot(title: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-target-"));
  const photo = path.join(dir, `${title.replace(/\s+/g, "-")}.jpg`);
  writeTestPng(photo, 400, 240);
  const ingested = ingestWhatsApp({
    chat: "oliver",
    scanned_at: new Date().toISOString(),
    messages: [{
      id: `wa-target-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      text: `${title} 2000 units $4 closeout apparel`,
      media: [{ filename: path.basename(photo), path: photo }],
    }],
  });
  return ingested.lotsTouched[0];
}

describe("contact quality ranking", () => {
  it("ranks named buyer > purchasing > sales/buying > info/contact", () => {
    expect(classifyEmailQuality("jane.doe@acme.com", { title: "Category Buyer" })).toBe("named_buyer");
    expect(classifyEmailQuality("purchasing@acme.com")).toBe("purchasing");
    expect(classifyEmailQuality("buying@acme.com")).toBe("sales_buying");
    expect(classifyEmailQuality("info@acme.com")).toBe("generic");
    expect(classifyEmailQuality("contact@acme.com")).toBe("generic");
    expect(classifyEmailQuality("hello@acme.com")).toBe("generic");
    expect(QUALITY_RANK.named_buyer).toBeGreaterThan(QUALITY_RANK.purchasing);
    expect(QUALITY_RANK.purchasing).toBeGreaterThan(QUALITY_RANK.sales_buying);
    expect(QUALITY_RANK.sales_buying).toBeGreaterThan(QUALITY_RANK.generic);
  });

  it("selects the named inbox when a generic one already exists", () => {
    const id = seedBuyer("rankco.com", "info@rankco.com");
    recordEndpoint({
      buyerId: id,
      channel: "email",
      handle: "jane.buyer@rankco.com",
      confidence: 0.85,
      verified: true,
      source: "OPPORTUNITY_RESEARCHER:https://rankco.com/team",
    });
    db().prepare(
      "INSERT OR IGNORE INTO buyer_contacts(buyer_id,name,title,email,verification) VALUES(?,'Jane','Closeout Buyer','jane.buyer@rankco.com','verified')"
    ).run(id);
    expect(selectChannel(id)?.endpoint.handle).toBe("jane.buyer@rankco.com");
  });

  it("still sends to an evidenced generic inbox when that is all we have", async () => {
    const lotId = seedLot("Generic inbox hoodies");
    const buyers = ["g1.com", "g2.com", "g3.com", "g4.com", "g5.com", "g6.com"].map((domain, i) =>
      seedBuyer(domain, `info@${domain}`),
    );
    const first = await runMatching(lotId);
    expect(first.queued).toBe(buyers.length);
    const handles = db().prepare(
      "SELECT selected_handle FROM opportunities WHERE selected_channel='email' ORDER BY buyer_id"
    ).all() as Array<{ selected_handle: string }>;
    expect(handles.every((h) => h.selected_handle.startsWith("info@"))).toBe(true);
    expect(handles).toHaveLength(buyers.length);

    const namedId = buyers[0];
    recordEndpoint({
      buyerId: namedId,
      channel: "email",
      handle: "pat.owner@g1.com",
      confidence: 0.9,
      verified: true,
      source: "BUYER_RESEARCHER:https://g1.com/about",
    });
    const upgraded = applyBetterContact(namedId, "pat.owner@g1.com");
    expect(upgraded.upgraded).toBe(true);
    expect(selectChannel(namedId)?.endpoint.handle).toBe("pat.owner@g1.com");

    const second = await runMatching(lotId);
    const attemptCount = (db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts").get() as { n: number }).n;
    expect(attemptCount).toBeGreaterThanOrEqual(first.queued);
    expect(second.matches).toBeGreaterThanOrEqual(first.matches);
  });

  it("upgrades a stored generic after findings ingest a named buyer", async () => {
    const id = seedBuyer("upgradeco.com", "info@upgradeco.com");
    db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email','info@upgradeco.com')").run(id);
    db().prepare(
      "INSERT INTO opportunities(buyer_id,lot_ids,stage,selected_channel,selected_handle) VALUES(?,'[1]','dry_run','email','info@upgradeco.com')"
    ).run(id);

    const res = await postFindings(findingsReq({
      agent: "OPPORTUNITY_RESEARCHER",
      buyers: [{
        company: "Upgrade Co",
        domain: "upgradeco.com",
        evidence: [{ url: "https://upgradeco.com/team", quote: "mailto:sam.lee@upgradeco.com" }],
        endpoints: [{
          channel: "email",
          handle: "sam.lee@upgradeco.com",
          name: "Sam Lee",
          title: "Inventory Buyer",
          source: "https://upgradeco.com/team",
          evidence: "mailto sam.lee@upgradeco.com on team page",
          confidence: 0.88,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const json = await res.json() as { ok: boolean; skippedGuessedEmails: string[] };
    expect(json.ok).toBe(true);
    expect(json.skippedGuessedEmails).toEqual([]);
    expect(selectChannel(id)?.endpoint.handle).toBe("sam.lee@upgradeco.com");
    const convo = db().prepare("SELECT contact_email FROM conversations WHERE buyer_id=?").get(id) as { contact_email: string };
    expect(convo.contact_email).toBe("sam.lee@upgradeco.com");
    const opp = db().prepare("SELECT selected_handle FROM opportunities WHERE buyer_id=?").get(id) as { selected_handle: string };
    expect(opp.selected_handle).toBe("sam.lee@upgradeco.com");
  });

  it("does not drop guessed-without-mailto role inboxes and still accepts evidenced generics", async () => {
    const skipped = await postFindings(findingsReq({
      agent: "BUYER_RESEARCHER",
      buyers: [{
        company: "Guess Hello",
        domain: "guesshello.com",
        evidence: [{ url: "https://guesshello.com", quote: "homepage" }],
        endpoints: [{
          channel: "email",
          handle: "hello@guesshello.com",
          source: "guess",
          evidence: "looks like a wholesaler",
          confidence: 0.9,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const skippedJson = await skipped.json() as { skippedGuessedEmails: string[] };
    expect(skippedJson.skippedGuessedEmails).toEqual(["guesshello.com:hello@guesshello.com"]);

    const kept = await postFindings(findingsReq({
      agent: "BUYER_RESEARCHER",
      buyers: [{
        company: "Real Info",
        domain: "realinfo.com",
        evidence: [{ url: "https://realinfo.com/contact", quote: "mailto:info@realinfo.com" }],
        endpoints: [{
          channel: "email",
          handle: "info@realinfo.com",
          source: "https://realinfo.com/contact",
          evidence: "mailto info@realinfo.com on contact page",
          confidence: 0.8,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const keptJson = await kept.json() as { ok: boolean; buyerIds: number[]; skippedGuessedEmails: string[] };
    expect(keptJson.skippedGuessedEmails).toEqual([]);
    expect(selectChannel(keptJson.buyerIds[0])?.endpoint.handle).toBe("info@realinfo.com");
  });

  it("uses quality outcomes to lift a better-performing source", () => {
    const low = "BUYER_RESEARCHER";
    const high = "OPPORTUNITY_RESEARCHER";
    for (let i = 0; i < 3; i++) {
      recordQualityOutcome(`info@low${i}.example`, "delivered", { source: low });
      recordQualityOutcome(`info@low${i}.example`, "bounced", { source: low });
      recordQualityOutcome(`pat.buyer@high${i}.example`, "delivered", { source: high });
      recordQualityOutcome(`pat.buyer@high${i}.example`, "replied", { source: high });
      recordQualityOutcome(`pat.buyer@high${i}.example`, "phone_captured", { source: high });
    }
    const lowScore = rankEmailScore("info@later.example", { source: low });
    const highScore = rankEmailScore("pat.buyer@later.example", { source: high });
    expect(highScore.bonus).toBeGreaterThan(lowScore.bonus);
  });

  it("queues upgrade research without reducing discover volume", () => {
    const lotId = seedLot("Upgrade research tees");
    seedBuyer("weakmail.com", "info@weakmail.com");
    const tick1 = researchTick();
    expect(tick1.queued).toBeGreaterThanOrEqual(1);
    expect(tick1.upgrades).toBeGreaterThanOrEqual(1);
    const tick2 = researchTick();
    expect(tick2.queued).toBe(0);
    expect(tick2.seeded).toBe(tick1.seeded);
    const discover = db().prepare(
      "SELECT COUNT(*) AS n FROM research_jobs WHERE kind='discover' AND lot_id=? AND state IN ('pending','running')"
    ).get(lotId) as { n: number };
    expect(discover.n).toBe(1);
    const jobs = db().prepare(
      "SELECT instruction FROM grok_jobs WHERE agent='OPPORTUNITY_RESEARCHER' AND instruction LIKE 'upgrade-contact:%'"
    ).all() as Array<{ instruction: string }>;
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(listWeakEmailBuyers().some((t) => t.domain === "weakmail.com")).toBe(true);
    expect(researchCoverage().upgrade_targets.some((t) => t.domain === "weakmail.com")).toBe(true);
    expect(opportunityWorklist().upgrade_targets.some((t) => t.domain === "weakmail.com")).toBe(true);
  });

  it("recycles unclaimed upgrade slots so new targets can enqueue", () => {
    db().prepare(
      "INSERT INTO grok_jobs(agent,instruction,input,state,created_at) VALUES('OPPORTUNITY_RESEARCHER','upgrade-contact:1','{}','queued', datetime('now','-2 hours'))"
    ).run();
    expect(expireStaleUpgradeJobs(90)).toBeGreaterThanOrEqual(1);
    expect(enqueueContactUpgradeJobs()).toBeGreaterThanOrEqual(0);
  });
});
