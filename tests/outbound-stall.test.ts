import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as getHealth } from "../app/api/health/route";
import { recordEndpoint } from "../lib/channels/select";
import { runMatching } from "../lib/conversations";
import { db, setSetting } from "../lib/db";
import { AUTHORIZED_SENDER } from "../lib/email/address";
import { setGmailClient } from "../lib/email/provider";
import { emit, markProcessed, unprocessedEvents } from "../lib/events";
import { ingestWhatsApp } from "../lib/intake";
import { recordSend } from "../lib/ledger";
import { enqueueEligibleLotMatches, runSchedulerCycle, schedulerHealth, tick } from "../lib/orchestrator";
import { assessOutboundProgress, recoverIfOutboundStalled, STALL_MINUTES } from "../lib/outbound-stall";
import { enrollBuyer, recordMandate, researchTick } from "../lib/research";
import { writeTestPng } from "./png";

function seedLot(title: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-stall-"));
  const photo = path.join(dir, `${title.replace(/\s+/g, "-")}.png`);
  writeTestPng(photo, 420, 240);
  const ingested = ingestWhatsApp({
    chat: "oliver",
    scanned_at: new Date().toISOString(),
    messages: [{
      id: `wa-stall-${title}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      text: `${title} 1000 units $4`,
      media: [{ filename: path.basename(photo), path: photo }],
    }],
  });
  const lotId = ingested.lotsTouched[0];
  db().prepare("UPDATE lots SET state='outreach_active', updated_at=datetime('now','-20 minutes') WHERE id=?").run(lotId);
  return lotId;
}

function seedBuyer(domain: string, email = `buy@${domain}`) {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel",
    verification_status: "verified",
    outreach_channel: "email",
  });
  db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=5000000 WHERE id=?").run(buyerId);
  db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, email);
  recordMandate({
    buyerId,
    category: "apparel-basic",
    stance: "accepts",
    origin: "operator",
    sourceUrl: `https://${domain}/buy`,
    sourceQuote: "We buy apparel closeouts",
  });
  return buyerId;
}

function confirmOldSend(buyerId: number, lotId: number, email: string, minutesAgo = 16) {
  const convoId = Number(db().prepare(
    "INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'queued','email',?)"
  ).run(buyerId, email).lastInsertRowid);
  db().prepare("INSERT OR REPLACE INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,1)").run(convoId, lotId);
  db().prepare(
    `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id,created_at)
     VALUES(?,?,?,'[]','','','[]','sent','provider accepted',?,? ,datetime('now', ?))`
  ).run(convoId, buyerId, "email", `stall-prior-${buyerId}`, `gmail-prior-${buyerId}`, `-${minutesAgo} minutes`);
  db().prepare(
    `UPDATE outreach_attempts SET lot_ids=? WHERE idempotency_key=?`
  ).run(JSON.stringify([lotId]), `stall-prior-${buyerId}`);
  recordSend(email, lotId, buyerId);
  return convoId;
}

function liveGmail() {
  setSetting("outbound_mode", "live");
  setSetting("kill_switch", "false");
  const sent: string[] = [];
  setGmailClient({
    profile: async () => ({ emailAddress: AUTHORIZED_SENDER }),
    send: async (input) => {
      sent.push(input.to);
      return { ok: true, id: `gmail-${sent.length}-${Date.now()}` };
    },
    listInbox: async () => ({ messages: [], historyId: "1" }),
  });
  return sent;
}

function drainEvents() {
  for (const ev of unprocessedEvents(200)) markProcessed(ev.id);
}

describe("outbound stall watchdog", () => {
  it("reproduces drained match queue: scheduler ticks, watchdog rematches, remaining buyers stay sendable", async () => {
    const lotId = seedLot("Stall tees");
    const first = seedBuyer("stallfirst.com");
    const second = seedBuyer("stallsecond.com");
    const third = seedBuyer("stallthird.com");
    confirmOldSend(first, lotId, "buy@stallfirst.com", 16);
    const firstWave = emit("match.requested", { lotId }, "match.requested:first-wave");
    markProcessed(firstWave);
    drainEvents();

    const sent = liveGmail();
    const beforeTick = assessOutboundProgress();
    expect(beforeTick.eligibleActiveLotCount).toBe(1);
    expect(beforeTick.eligibleUntouchedBuyerCount).toBeGreaterThanOrEqual(2);
    expect(beforeTick.pendingMatchCount).toBe(0);
    expect(beforeTick.minutesSinceLastConfirmedSend).toBeGreaterThanOrEqual(STALL_MINUTES);
    expect(beforeTick.outbound_stalled).toBe(true);
    expect(beforeTick.stall_reason).toBe("no_confirmed_send_15m");

    researchTick();
    const idle = await tick();
    expect(idle.details.every((d) => !d.startsWith("match.requested"))).toBe(true);
    expect(assessOutboundProgress().outbound_stalled).toBe(true);
    expect((db().prepare(
      `SELECT COUNT(*) AS n FROM outreach_attempts
        WHERE status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''`
    ).get() as { n: number }).n).toBe(1);
    expect(sent).toHaveLength(0);

    const sched = enqueueEligibleLotMatches();
    expect(sched).toBeGreaterThanOrEqual(1);
    drainEvents();
    expect(enqueueEligibleLotMatches()).toBe(0);
    expect(assessOutboundProgress().outbound_stalled).toBe(true);
    expect(assessOutboundProgress().pendingMatchCount).toBe(0);

    const recovery = await recoverIfOutboundStalled({
      rematch: () => enqueueEligibleLotMatches({ source: "watchdog" }),
      process: tick,
    });
    expect(recovery).not.toBeNull();
    expect(recovery!.snapshot.outbound_stalled).toBe(true);
    expect(recovery!.rematch).toBeGreaterThanOrEqual(1);
    expect(recovery!.sendVerified).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent).not.toContain("buy@stallfirst.com");
    expect(sent.some((to) => to === "buy@stallsecond.com" || to === "buy@stallthird.com")).toBe(true);

    const firstSends = db().prepare(
      `SELECT COUNT(*) AS n FROM outreach_attempts
        WHERE buyer_id=? AND status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''`
    ).get(first) as { n: number };
    expect(firstSends.n).toBe(1);

    const after = assessOutboundProgress();
    expect(after.outbound_stalled).toBe(false);
    expect(after.lastConfirmedSendAt).not.toBe(beforeTick.lastConfirmedSendAt);
    expect(third).toBeGreaterThan(0);
  });

  it("does not treat kill switch, dry_run, missing Gmail, or a recent send as a stall", async () => {
    const lotId = seedLot("Healthy tees");
    const buyerId = seedBuyer("healthy.com");
    seedBuyer("healthypool.com");
    confirmOldSend(buyerId, lotId, "buy@healthy.com", 16);
    liveGmail();

    setSetting("kill_switch", "true");
    expect(assessOutboundProgress()).toMatchObject({ outbound_stalled: false, stall_reason: "kill_switch" });
    expect(await recoverIfOutboundStalled({ rematch: () => 99, process: async () => ({ processed: 0, failed: 0 }) })).toBeNull();

    setSetting("kill_switch", "false");
    setSetting("outbound_mode", "dry_run");
    expect(assessOutboundProgress()).toMatchObject({ outbound_stalled: false, stall_reason: "outbound_mode_not_live" });

    setSetting("outbound_mode", "live");
    setGmailClient(null);
    expect(assessOutboundProgress()).toMatchObject({ outbound_stalled: false, stall_reason: "gmail_not_connected" });

    liveGmail();
    db().prepare(
      `UPDATE outreach_attempts SET created_at=datetime('now','-3 minutes')
        WHERE idempotency_key=?`
    ).run(`stall-prior-${buyerId}`);
    const recent = assessOutboundProgress();
    expect(recent.outbound_stalled).toBe(false);
    expect(recent.stall_reason).toBeNull();
    expect(recent.minutesSinceLastConfirmedSend).toBeLessThan(STALL_MINUTES);
  });

  it("does not treat one-touch exhaustion as a stall", async () => {
    const lotId = seedLot("Touched tees");
    const only = seedBuyer("alltouched.com");
    confirmOldSend(only, lotId, "buy@alltouched.com", 20);
    liveGmail();
    const snap = assessOutboundProgress();
    expect(snap.eligibleUntouchedBuyerCount).toBe(0);
    expect(snap.outbound_stalled).toBe(false);
    expect(snap.stall_reason).toBe("no_eligible_untouched_buyers");
  });

  it("keeps a buyer sendable for an untouched lot after a send on a different lot", async () => {
    const hoodies = seedLot("One-touch hoodies");
    seedLot("Lithium-Ion Drill Tool Set");
    const buyerId = seedBuyer("secondlot.com");
    confirmOldSend(buyerId, hoodies, "buy@secondlot.com", 20);
    liveGmail();
    const snap = assessOutboundProgress();
    expect(snap.emailSendableBuyerCount).toBeGreaterThanOrEqual(1);
    expect(snap.eligibleUntouchedBuyerCount).toBeGreaterThanOrEqual(1);
    expect(snap.stall_reason).not.toBe("no_email_sendable_buyers");
  });

  it("exposes stall fields on /api/health and runSchedulerCycle recovers a drained queue", async () => {
    const lotId = seedLot("Health tees");
    const first = seedBuyer("healthfirst.com");
    seedBuyer("healthsecond.com");
    confirmOldSend(first, lotId, "buy@healthfirst.com", 18);
    drainEvents();
    const sent = liveGmail();

    const res = await getHealth();
    const body = await res.json() as {
      outbound_stalled: boolean;
      stall_reason: string | null;
      lastConfirmedSendAt: string | null;
      minutesSinceLastConfirmedSend: number | null;
      eligibleUntouchedBuyerCount: number;
      eligibleActiveLotCount: number;
      pendingMatchCount: number;
      scheduler_unhealthy: boolean;
      schedulerVersion: string;
    };
    expect(body.outbound_stalled).toBe(true);
    expect(body.stall_reason).toBe("no_confirmed_send_15m");
    expect(body.lastConfirmedSendAt).toBeTruthy();
    expect(body.minutesSinceLastConfirmedSend).toBeGreaterThanOrEqual(STALL_MINUTES);
    expect(body.eligibleUntouchedBuyerCount).toBeGreaterThanOrEqual(1);
    expect(body.eligibleActiveLotCount).toBe(1);
    expect(body.pendingMatchCount).toBe(0);
    expect(body.scheduler_unhealthy).toBe(false);
    expect(body.schedulerVersion).toMatch(/runSchedulerCycle/);

    const cycle = await runSchedulerCycle();
    expect(cycle.watchdog.outbound_stalled).toBe(false);
    expect(cycle.recovery?.sendVerified === true || sent.length > 0).toBe(true);
    expect(sent).not.toContain("buy@healthfirst.com");
    const after = schedulerHealth();
    expect(after.scheduler_unhealthy).toBe(false);
    expect(after.lastSuccessfulSchedulerCycleAt).toBeTruthy();
  });

  it("marks scheduler_unhealthy independently of outbound_stalled", () => {
    process.env.BMSM_DISABLE_SCHEDULER = "";
    db().prepare(
      `INSERT INTO audit_log(at,actor,action,ok,detail) VALUES(datetime('now','-20 minutes'),'orchestrator','scheduler_cycle',1,'{}')`
    ).run();
    const sched = schedulerHealth();
    expect(sched.scheduler_unhealthy).toBe(true);
    expect(sched.scheduler_unhealthy_reason).toBe("scheduler_cycle_stale");
    expect(assessOutboundProgress().outbound_stalled).toBe(false);
    process.env.BMSM_DISABLE_SCHEDULER = "1";
  });

  it("extracts a single email from contact blobs and does not let form-deferred consume the match window", async () => {
    const lotId = seedLot("Blob window tees");
    const formOnly = seedBuyer("formonly.com");
    db().prepare("DELETE FROM buyer_contacts WHERE buyer_id=?").run(formOnly);
    db().prepare("DELETE FROM buyer_channel_endpoints WHERE buyer_id=?").run(formOnly);
    recordEndpoint({ buyerId: formOnly, channel: "form", handle: "https://formonly.com/contact", confidence: 0.95, verified: true });

    const blob = seedBuyer("blobmail.com");
    db().prepare("UPDATE buyer_contacts SET email=? WHERE buyer_id=?").run(
      "buy@blobmail.com; 818-555-0199; https://blobmail.com/sell",
      blob,
    );
    recordEndpoint({ buyerId: blob, channel: "form", handle: "https://blobmail.com/form", confidence: 0.99, verified: true });

    const sent = liveGmail();
    const matched = await runMatching(lotId);
    expect(matched.queued).toBeGreaterThanOrEqual(1);
    expect(sent).toContain("buy@blobmail.com");
    const blobSends = db().prepare(
      `SELECT COUNT(*) AS n FROM outreach_attempts
        WHERE buyer_id=? AND status='sent' AND provider_message_id IS NOT NULL AND trim(provider_message_id)!=''`
    ).get(blob) as { n: number };
    expect(blobSends.n).toBe(1);
  });

  it("skips an already-queued form buyer and still emails the next match", async () => {
    const lotId = seedLot("Pending form then email");
    const formOnly = seedBuyer("queuedform.com");
    db().prepare("DELETE FROM buyer_contacts WHERE buyer_id=?").run(formOnly);
    db().prepare("DELETE FROM buyer_channel_endpoints WHERE buyer_id=?").run(formOnly);
    recordEndpoint({ buyerId: formOnly, channel: "form", handle: "https://queuedform.com/contact", confidence: 0.99, verified: true });
    db().prepare(
      "INSERT INTO grok_jobs(agent,instruction,input,state) VALUES('FORM_OPERATOR','fill',?,'queued')"
    ).run(JSON.stringify({ buyerId: formOnly }));

    const next = seedBuyer("stillmail.com");
    const sent = liveGmail();
    const matched = await runMatching(lotId);
    expect(matched.queued).toBeGreaterThanOrEqual(1);
    expect(sent).toContain("buy@stillmail.com");
    const formAttempts = db().prepare(
      "SELECT COUNT(*) AS n FROM outreach_attempts WHERE buyer_id=? AND channel='form'"
    ).get(formOnly) as { n: number };
    expect(formAttempts.n).toBe(0);
  });
});
