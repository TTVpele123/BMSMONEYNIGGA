import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMatching } from "../lib/conversations";
import { db } from "../lib/db";
import { processInbound } from "../lib/inbound";
import { ingestWhatsApp } from "../lib/intake";
import { tick } from "../lib/orchestrator";
import { enrollBuyer, recordMandate, researchTick } from "../lib/research";
import { writeTestPng } from "../tests/png";

process.env.OUTBOUND_MODE = process.env.OUTBOUND_MODE ?? "dry_run";

const { buyerId } = enrollBuyer({
  company: "Demo Wholesale",
  domain: "demowholesale.example",
  categories: "licensed,apparel,closeout",
  verification_status: "verified",
  outreach_channel: "email",
});
db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=8000000 WHERE id=?").run(buyerId);
db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, "buy@demowholesale.example");
recordMandate({
  buyerId,
  category: "apparel-licensed",
  stance: "accepts",
  origin: "operator",
  sourceUrl: "https://demowholesale.example/buy",
  sourceQuote: "We buy licensed apparel",
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-dry-"));
const photo = path.join(dir, "lot.jpg");
writeTestPng(photo);

const ingested = ingestWhatsApp({
  chat: "oliver",
  scanned_at: new Date().toISOString(),
  messages: [{
    id: `dry-${Date.now()}`,
    at: new Date().toISOString(),
    text: "Licensed NFL apparel 12400 units new $4.10 mixed sizes",
    media: [{ filename: "lot.jpg", path: photo }],
  }],
});
const lotId = ingested.lotsTouched[0];
const matched = await runMatching(lotId);
const orch = await tick();
researchTick();
const inbound = processInbound({
  from: "buy@demowholesale.example",
  text: "Interested. Call 818-555-0199.",
  providerMessageId: `dry-in-${Date.now()}`,
});

console.log(JSON.stringify({ ingested, matched, orch, inbound, attempts: db().prepare("SELECT status, reason FROM outreach_attempts").all() }, null, 2));
