import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFormResult } from "../lib/channels/form-exec";
import { classifyFormHandle, interpretFormResult } from "../lib/channels/form";
import { listOperators } from "../lib/channels/registry";
import { recordEndpoint, selectChannel, selectChannels } from "../lib/channels/select";
import { db, setSetting } from "../lib/db";
import { buyerLotAlreadyTouched, markBounced, recordSend } from "../lib/ledger";
import { createOpportunity, dispatchOpportunity } from "../lib/opportunity";
import { GET as getGrokJobs } from "../app/api/grok/jobs/route";
import { claimGrokJobs, enqueueGrokJob, enrollBuyer, peekGrokJobs } from "../lib/research";
import { writeBounce } from "../lib/suppression";
import { writeTestPng } from "./png";

function seedMedia(lotId: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmsm-form-"));
  const photo = path.join(dir, `lot-${lotId}.png`);
  writeTestPng(photo, 400 + lotId, 280);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(photo)).digest("hex");
  db().prepare(
    `INSERT INTO lot_media(lot_id,oliver_message_id,sha256,path,filename,mime,classification,outreach_safe,association_certain)
     VALUES(?,?,?,?,?,'image/png','clean_product_photo',1,1)`
  ).run(lotId, `wa-form-${lotId}-${sha.slice(0, 8)}`, sha, photo, path.basename(photo));
}

function buyer(domain: string, outreach = "unknown") {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel",
    verification_status: "verified",
    outreach_channel: outreach,
  });
  db().prepare("UPDATE buyers SET geography='domestic', txn_capacity_usd=2000000 WHERE id=?").run(buyerId);
  return buyerId;
}

describe("channel router", () => {
  it("routes verified email first, form when no email, social when that is all we have", () => {
    const a = buyer("a.com", "email");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@a.com','verified')").run(a);
    expect(selectChannel(a)?.endpoint.channel).toBe("email");

    const b = buyer("b.com");
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://b.com/wholesale", confidence: 0.8, verified: true, source: "test" });
    expect(selectChannel(b)?.endpoint.channel).toBe("form");

    const c = buyer("c.com");
    recordEndpoint({ buyerId: c, channel: "instagram", handle: "@cwholesale", confidence: 0.7, source: "test" });
    expect(selectChannel(c)).toBeNull();

    const d = buyer("d.com");
    recordEndpoint({ buyerId: d, channel: "linkedin", handle: "https://linkedin.com/in/dbuyer", confidence: 0.7, source: "test" });
    expect(selectChannel(d)?.endpoint.channel).toBe("linkedin");
  });

  it("picks the highest-confidence lowest-friction route when several exist", () => {
    const e = buyer("e.com");
    recordEndpoint({ buyerId: e, channel: "instagram", handle: "@e", confidence: 0.9, source: "test" });
    recordEndpoint({ buyerId: e, channel: "form", handle: "https://e.com/contact", confidence: 0.7, verified: true, source: "test" });
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@e.com','verified')").run(e);
    expect(selectChannel(e)?.endpoint.channel).toBe("email");
  });

  it("never invents purchasing@domain", () => {
    const f = buyer("noinbox.com");
    expect(selectChannel(f)).toBeNull();
  });

  it("defers non-email operators instead of executing them", async () => {
    const b = buyer("formonly.com");
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://formonly.com/buy", confidence: 0.85, verified: true, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','form')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-1','tees','apparel-licensed','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-1'").get() as { id: number };
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Form Only",
      domain: "formonly.com",
      lots: [{ id: lot.id, title: "tees", category: "apparel-licensed", quantity: 100, unit_price: 4, brand: null }],
    });
    expect(result.channel).toBe("form");
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/media/i);
  });

  it("ranks every legitimate route instead of email-only", () => {
    const e = buyer("multi.com");
    recordEndpoint({ buyerId: e, channel: "form", handle: "https://multi.com/wholesale", confidence: 0.8, verified: true, source: "test" });
    recordEndpoint({ buyerId: e, channel: "linkedin", handle: "https://linkedin.com/company/multi", confidence: 0.6, source: "test" });
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@multi.com','verified')").run(e);
    expect(selectChannels(e).map((r) => r.endpoint.channel)).toEqual(["email", "form", "linkedin"]);
  });

  it("executes only the primary route and records secondaries without live form submit", async () => {
    const b = buyer("emailplusform.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@emailplusform.com','verified')").run(b);
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://emailplusform.com/wholesale", confidence: 0.8, verified: true, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','email')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-2','hoodies','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-2'").get() as { id: number };
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Email Plus Form",
      domain: "emailplusform.com",
      lots: [{ id: lot.id, title: "hoodies", category: "apparel-basic", quantity: 200, unit_price: 5, brand: null }],
    });
    expect(result.channel).toBe("email");
    expect(["dry_run", "blocked", "failed", "deferred"]).toContain(result.status);
    const routes = db().prepare(
      "SELECT channel, state FROM channel_routes WHERE opportunity_id=? ORDER BY channel"
    ).all(oppId) as Array<{ channel: string; state: string }>;
    expect(routes.map((r) => r.channel)).toEqual(["email", "form"]);
    expect(routes.find((r) => r.channel === "form")?.state).toBe("deferred");
    const formSent = db().prepare(
      "SELECT id FROM outreach_attempts WHERE buyer_id=? AND channel='form' AND status='sent'"
    ).get(b);
    expect(formSent).toBeUndefined();
  });

  it("falls back to form after email one-touch without consuming Gmail", async () => {
    const b = buyer("touched.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@touched.com','verified')").run(b);
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://touched.com/form", confidence: 0.8, verified: true, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','email')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-3','socks','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-3'").get() as { id: number };
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[${lot.id}]','s','b','[]','sent','provider accepted','touch-1')`
    ).run(convoId, b, "email");
    expect(buyerLotAlreadyTouched(b, [lot.id]).touched).toBe(true);
    seedMedia(lot.id);
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Touched",
      domain: "touched.com",
      lots: [{ id: lot.id, title: "socks", category: "apparel-basic", quantity: 50, unit_price: 2, brand: null }],
    });
    expect(result.channel).toBe("form");
    expect(result.status).toBe("dry_run");
    expect(result.reason).toMatch(/form/);
  });

  it("still blocks when email one-touch is exhausted and there is no form", async () => {
    const b = buyer("emailonly-touched.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@emailonly-touched.com','verified')").run(b);
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','email')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-3b','socks','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-3b'").get() as { id: number };
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[${lot.id}]','s','b','[]','sent','provider accepted','touch-email-only')`
    ).run(convoId, b, "email");
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Email Only",
      domain: "emailonly-touched.com",
      lots: [{ id: lot.id, title: "socks", category: "apparel-basic", quantity: 50, unit_price: 2, brand: null }],
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/one-touch/);
  });

  it("marks LinkedIn needs_human instead of submitting", async () => {
    const b = buyer("li.com");
    recordEndpoint({ buyerId: b, channel: "linkedin", handle: "https://linkedin.com/company/li", confidence: 0.8, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','linkedin')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-4','caps','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-4'").get() as { id: number };
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "LI Co",
      domain: "li.com",
      lots: [{ id: lot.id, title: "caps", category: "apparel-basic", quantity: 10, unit_price: 3, brand: null }],
    });
    expect(result.status).toBe("deferred");
    const route = db().prepare("SELECT state, blocker FROM channel_routes WHERE opportunity_id=?").get(oppId) as { state: string; blocker: string };
    expect(route.state).toBe("needs_human");
    expect(route.blocker).toMatch(/human-assisted last resort/);
  });

  it("prefers a named purchasing inbox over generic info@", () => {
    const b = buyer("named.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,name,title,email,verification) VALUES(?,'Pat Buyer','Purchasing','pat@named.com','verified')").run(b);
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'info@named.com','unverified')").run(b);
    expect(selectChannel(b)?.endpoint.handle).toBe("pat@named.com");
  });

  it("never reselects a hard-bounced inbox even if a leftover endpoint remains", () => {
    const b = buyer("deadinbox.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'gone@deadinbox.com','bounced')").run(b);
    db().prepare(
      "INSERT INTO buyer_channel_endpoints(buyer_id,channel,handle,confidence,verified,source) VALUES(?,'email','gone@deadinbox.com',0.9,1,'stale')"
    ).run(b);
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://deadinbox.com/form", confidence: 0.8, verified: true, source: "test" });
    expect(selectChannel(b)?.endpoint.channel).toBe("form");
    expect(selectChannel(b)?.endpoint.handle).not.toBe("gone@deadinbox.com");
    recordEndpoint({ buyerId: b, channel: "email", handle: "gone@deadinbox.com", source: "retry" });
    expect(selectChannels(b).some((r) => r.endpoint.handle === "gone@deadinbox.com")).toBe(false);
  });

  it("falls back to form after an address bounce, without one-touching the lot", async () => {
    const b = buyer("bounceform.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'dead@bounceform.com','verified')").run(b);
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://bounceform.com/wholesale", confidence: 0.8, verified: true, source: "test" });
    writeBounce("dead@bounceform.com");
    markBounced("dead@bounceform.com");
    expect(selectChannel(b)?.endpoint.channel).toBe("form");
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','email')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-5','tees','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-5'").get() as { id: number };
    db().prepare(
      `INSERT INTO outreach_ledger(contact_email,lot_id,buyer_id,status) VALUES('dead@bounceform.com',?,?,'bounced')`
    ).run(lot.id, b);
    expect(buyerLotAlreadyTouched(b, [lot.id]).touched).toBe(false);
    seedMedia(lot.id);
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Bounce Form",
      domain: "bounceform.com",
      lots: [{ id: lot.id, title: "tees", category: "apparel-basic", quantity: 20, unit_price: 3, brand: null }],
    });
    expect(result.channel).toBe("form");
    expect(result.status).toBe("dry_run");
  });

  it("keeps email and public-form as the only live adapters", () => {
    const ops = listOperators();
    expect(ops.map((o) => o.id).sort()).toEqual([
      "application", "email", "form", "instagram", "linkedin", "marketplace", "other", "phone",
    ].sort());
    expect(ops.filter((o) => o.liveExecution).map((o) => o.id).sort()).toEqual(["email", "form"]);
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
  });

  it("queues a live public form for GrokBot and confirms only with evidence", async () => {
    const b = buyer("liveform.com");
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://liveform.com/wholesale", confidence: 0.9, verified: true, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','form')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-6','hoodies','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-6'").get() as { id: number };
    seedMedia(lot.id);
    setSetting("outbound_mode", "live");
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Live Form",
      domain: "liveform.com",
      lots: [{ id: lot.id, title: "hoodies", category: "apparel-basic", quantity: 80, unit_price: 6, brand: null }],
    });
    expect(result.status).toBe("deferred");
    expect(result.reason).toMatch(/queued for GrokBot/);
    const job = db().prepare("SELECT id, input FROM grok_jobs WHERE agent='FORM_OPERATOR'").get() as { id: number; input: string };
    expect(job).toBeTruthy();
    const packet = JSON.parse(job.input) as { live: boolean; submit: boolean; url: string; idempotencyKey: string };
    expect(packet.live).toBe(true);
    expect(packet.submit).toBe(true);
    expect(packet.url).toBe("https://liveform.com/wholesale");
    const click = applyFormResult({ idempotencyKey: packet.idempotencyKey, submitted: true });
    expect(click.state).toBe("failed");
    const confirmed = applyFormResult({
      idempotencyKey: packet.idempotencyKey,
      submitted: true,
      confirmationText: "Thanks, we received your request. Ticket #88",
    });
    expect(confirmed.state).toBe("confirmed");
    const attempt = db().prepare("SELECT status, provider_message_id FROM outreach_attempts WHERE idempotency_key=?").get(packet.idempotencyKey) as { status: string; provider_message_id: string | null };
    expect(attempt.status).toBe("sent");
    expect(attempt.provider_message_id).toBeNull();
    expect(buyerLotAlreadyTouched(b, [lot.id]).touched).toBe(true);
  });

  it("marks CAPTCHA/login as needs_human and does not queue a submit", async () => {
    const b = buyer("gatedform.com");
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://gatedform.com/login/wholesale", confidence: 0.9, verified: true, source: "test" });
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','form')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-7','socks','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-7'").get() as { id: number };
    seedMedia(lot.id);
    setSetting("outbound_mode", "live");
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Gated Form",
      domain: "gatedform.com",
      lots: [{ id: lot.id, title: "socks", category: "apparel-basic", quantity: 10, unit_price: 2, brand: null }],
    });
    expect(result.status).toBe("deferred");
    expect(result.reason).toMatch(/login|CAPTCHA|MFA/i);
    const jobs = db().prepare("SELECT id FROM grok_jobs WHERE agent='FORM_OPERATOR'").all();
    expect(jobs).toEqual([]);
  });

  it("executes email before a higher-scoring form", async () => {
    const b = buyer("formfirst.com");
    db().prepare("INSERT INTO buyer_contacts(buyer_id,email,verification) VALUES(?,'buy@formfirst.com','unverified')").run(b);
    recordEndpoint({ buyerId: b, channel: "form", handle: "https://formfirst.com/wholesale", confidence: 0.99, verified: true, source: "test" });
    expect(selectChannel(b)?.endpoint.channel).toBe("email");
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','form')").run(b);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('ch-8','tees','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='ch-8'").get() as { id: number };
    const oppId = createOpportunity({ buyerId: b, conversationId: convoId, lotIds: [lot.id] });
    const result = await dispatchOpportunity({
      opportunityId: oppId,
      conversationId: convoId,
      buyerId: b,
      company: "Form First",
      domain: "formfirst.com",
      lots: [{ id: lot.id, title: "tees", category: "apparel-basic", quantity: 20, unit_price: 3, brand: null }],
    });
    expect(result.channel).toBe("email");
  });

  it("never treats a form click as confirmed without confirmation evidence", () => {
    expect(interpretFormResult({ submitted: true }).state).toBe("failed");
    expect(interpretFormResult({ submitted: true, confirmationText: "Thanks, we received your request. Ticket #88" }).state).toBe("confirmed");
    expect(interpretFormResult({ submitted: true, confirmationText: "Message Sent! We’ll get back to you soon." }).state).toBe("confirmed");
    expect(interpretFormResult({ submitted: true, confirmationText: "Successfully submitted!" }).state).toBe("confirmed");
    expect(interpretFormResult({ submitted: true, confirmationText: "Dziękujemy. Twoja wiadomość została wysłana." }).state).toBe("confirmed");
    expect(interpretFormResult({ submitted: true, confirmationText: "Thanks! We'll review your inquiry and get back to you within 1-2 business days." }).state).toBe("confirmed");
    expect(interpretFormResult({ submitted: false }).state).toBe("deferred");
    expect(classifyFormHandle("https://buyer.example/contact?cf=turnstile").kind).toBe("gated");
  });

  it("claiming FORM_OPERATOR keeps email-touched jobs and cancels confirmed form sends", () => {
    const emailed = buyer("staleform.com");
    const bounced = buyer("bounceformjob.com");
    const formed = buyer("formdone.com");
    db().prepare("INSERT INTO lots(external_key,title,category,state) VALUES('stale-lot','tees','apparel-basic','matchable')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='stale-lot'").get() as { id: number };
    recordSend("buy@staleform.com", lot.id, emailed);
    db().prepare(
      "INSERT INTO outreach_ledger(contact_email,lot_id,buyer_id,status) VALUES('dead@bounceformjob.com',?,?,'bounced')"
    ).run(lot.id, bounced);
    const formedConvo = Number(db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'idle','form')").run(formed).lastInsertRowid);
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,?,'[${lot.id}]','s','b','[]','sent','form confirmation recorded','form-done-1')`
    ).run(formedConvo, formed, "form");

    const emailTouchedId = enqueueGrokJob("FORM_OPERATOR", "fill", {
      buyerId: emailed, lots: [{ id: lot.id }], idempotencyKey: `opp:1:form:${lot.id}`,
    });
    const liveId = enqueueGrokJob("FORM_OPERATOR", "fill", {
      buyerId: bounced, lots: [{ id: lot.id }], idempotencyKey: `opp:2:form:${lot.id}`,
    });
    const formDoneId = enqueueGrokJob("FORM_OPERATOR", "fill", {
      buyerId: formed, lots: [{ id: lot.id }], idempotencyKey: `opp:3:form:${lot.id}`,
    });

    expect(claimGrokJobs()).toEqual([]);
    const claimed = claimGrokJobs("FORM_OPERATOR");
    expect(claimed.map((j) => j.id)).toEqual([emailTouchedId]);
    expect(claimGrokJobs("FORM_OPERATOR").map((j) => j.id)).toEqual([emailTouchedId]);
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(liveId)).toEqual({ state: "queued" });
    const stale = db().prepare("SELECT state, result FROM grok_jobs WHERE id=?").get(formDoneId) as { state: string; result: string };
    expect(stale.state).toBe("failed");
    expect(stale.result).toMatch(/form already sent/);
    expect(buyerLotAlreadyTouched(emailed, [lot.id]).touched).toBe(true);
    expect(buyerLotAlreadyTouched(bounced, [lot.id]).touched).toBe(false);
  });

  it("FORM_OPERATOR GET peeks unless claim=1 and resumes a claimed job", async () => {
    const a = enqueueGrokJob("FORM_OPERATOR", "fill", { url: "https://a.example/form", live: true, submit: true });
    const b = enqueueGrokJob("FORM_OPERATOR", "fill", { url: "https://b.example/form", live: true, submit: true });
    const peeked = await (await getGrokJobs(new Request("http://localhost:3222/api/grok/jobs?agent=FORM_OPERATOR"))).json() as {
      jobs: Array<{ id: number; input: { url?: string } }>;
    };
    expect(peeked.jobs.map((j) => j.id)).toEqual([a]);
    expect(peeked.jobs[0]?.input.url).toBe("https://a.example/form");
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(a)).toEqual({ state: "queued" });
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(b)).toEqual({ state: "queued" });

    const first = await (await getGrokJobs(new Request("http://localhost:3222/api/grok/jobs?agent=FORM_OPERATOR&claim=1"))).json() as { jobs: Array<{ id: number }> };
    expect(first.jobs.map((j) => j.id)).toEqual([a]);
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(a)).toEqual({ state: "claimed" });
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(b)).toEqual({ state: "queued" });

    const again = await (await getGrokJobs(new Request("http://localhost:3222/api/grok/jobs?agent=FORM_OPERATOR&claim=1"))).json() as { jobs: Array<{ id: number }> };
    expect(again.jobs.map((j) => j.id)).toEqual([a]);
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(b)).toEqual({ state: "queued" });
  });

  it("INBOUND_ANALYST GET peeks unless claim=1", async () => {
    const id = enqueueGrokJob("INBOUND_ANALYST", "oliver_handoff:peek", { packet: "Pat\n5551234567\ndrill" });
    const peeked = await (await getGrokJobs(new Request("http://localhost:3222/api/grok/jobs?agent=INBOUND_ANALYST"))).json() as { jobs: Array<{ id: number }> };
    expect(peeked.jobs.map((j) => j.id)).toEqual([id]);
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(id)).toEqual({ state: "queued" });
    expect(peekGrokJobs("INBOUND_ANALYST").map((j) => j.id)).toEqual([id]);

    const claimed = await (await getGrokJobs(new Request("http://localhost:3222/api/grok/jobs?agent=INBOUND_ANALYST&claim=1"))).json() as { jobs: Array<{ id: number }> };
    expect(claimed.jobs.map((j) => j.id)).toEqual([id]);
    expect(db().prepare("SELECT state FROM grok_jobs WHERE id=?").get(id)).toEqual({ state: "claimed" });
  });
});
