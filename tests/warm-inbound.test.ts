import { describe, expect, it } from "vitest";
import { classifyReply, extractPhone, looksLikeAutoAck } from "../lib/classify";
import { db } from "../lib/db";
import { createEscalation, refreshOpenHandoffLots } from "../lib/escalate";
import { continueMissedPhoneHandoffs, continueWarmInbound, processInbound } from "../lib/inbound";
import { enrollBuyer } from "../lib/research";
import { applyOliverHandoffResult, answerFromVerified, composeWarmReply } from "../lib/warm-inbound";

function seedBuyer(domain: string, email = `buy@${domain}`) {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout,apparel",
    verification_status: "verified",
    outreach_channel: "email",
  });
  db().prepare("INSERT OR IGNORE INTO buyer_contacts(buyer_id,email,verification) VALUES(?,?,'verified')").run(buyerId, email);
  return buyerId;
}

describe("warm inbound", () => {
  it("does not treat bounce message ids as phones", () => {
    expect(extractPhone("call me at 312-555-0199")).toContain("312");
    expect(extractPhone("The response was:\n1785690644 technical id")).toBeNull();
    expect(extractPhone("Arielle Manz\n[1726676841509]\n24600 Main Street")).toBeNull();
    expect(extractPhone("6476794051")).toBe("6476794051");
    expect(extractPhone("I am interested.\nO: 952.897.1460\nM: 952.221.7119\n\nFrom: Bailey Saevitzon\n818-406-8612")).toContain("952.221.7119");
    expect(extractPhone("Do you have tables?\nP: 805.644.4496 | F: 805.644.4574")).toContain("805.644.4496");
    expect(extractPhone("Do you have tables?\nP: 805.644.4496 | F: 805.644.4574")).not.toContain("4574");
    expect(extractPhone("Arielle Manz\nAssociate Buyer\n(310)834-0004 ext. 256")).toContain("310");
    expect(extractPhone("Mobile    +49 173 690 1124")).toMatch(/173|49/);
    expect(classifyReply("Thanks for the offer. I just don’t have a need.").classification).toBe("not_interested");
  });

  it("links a same-company colleague reply by domain and captures a signature phone", async () => {
    const buyerId = seedBuyer("closeoutcanada.com", "suppliers@closeoutcanada.com");
    const r = await processInbound({
      from: "raj@closeoutcanada.com",
      text: [
        "Can I please get the UPC for this drill?",
        "",
        "Raj Dhanasar",
        "Ph: 416-452-1239",
        "raj@closeoutcanada.com",
        "",
        "On 2026-09-14, Bailey Saevitzon wrote:",
        "> Hi Closeout Canada team,",
      ].join("\n"),
      providerMessageId: "raj-canada-1",
    });
    expect(r.escalated).toBe(true);
    expect(r.replied).toBe(false);
    const inbound = db().prepare("SELECT buyer_id, phone FROM inbound_events WHERE provider_message_id='raj-canada-1'").get() as { buyer_id: number; phone: string };
    expect(inbound.buyer_id).toBe(buyerId);
    expect(inbound.phone).toContain("416-452-1239");
  });

  it("links a German An: colleague reply and hands the labeled mobile to Oliver", async () => {
    const buyerId = seedBuyer("fair-collect.de", "shanner@glaeser-textil-ulm.de");
    const r = await processInbound({
      from: "mwollnik@glaeser-textil-ulm.de",
      text: [
        "Hello,",
        "",
        "Thank you for your offer. Where in Germany are the goods ready for pickup?",
        "",
        "Malgorzata Wollnik",
        "Mobile    +49 173 690 1124",
        "",
        "Von: Bailey Saevitzon <saefamoverstock@gmail.com>",
        "An: Hanner Simon <SHanner@glaeser-textil-ulm.de>",
        "Betreff: Wholesale availability — Hoodies",
      ].join("\n"),
      providerMessageId: "glaeser-an-1",
    });
    expect(r.escalated).toBe(true);
    const inbound = db().prepare("SELECT buyer_id, phone FROM inbound_events WHERE provider_message_id='glaeser-an-1'").get() as { buyer_id: number; phone: string };
    expect(inbound.buyer_id).toBe(buyerId);
    expect(inbound.phone).toMatch(/173|49/);
  });

  it("links a personal-mailbox reply to the quoted To: buyer and hands a signature mobile to Oliver", async () => {
    const buyerId = seedBuyer("overstock-closeouts.com", "info@overstock-closeouts.com");
    const r = await processInbound({
      from: "rksluke@aol.com",
      text: [
        "I am interested … can you share more product information and FOB: Point? Thank you.",
        "",
        "Luke Martinson, VP of Purchasing & Sales",
        "O: 952.897.1460",
        "M: 952.221.7119",
        "",
        "From: Bailey Saevitzon <saefamoverstock@gmail.com>",
        "To: info@overstock-closeouts.com",
        "Subject: Wholesale availability — Lithium-Ion Drill Tool Set",
        "818-406-8612",
      ].join("\n"),
      providerMessageId: "rks-luke-1",
    });
    expect(r.classification).toBe("positive_interest");
    expect(r.escalated).toBe(true);
    expect(r.replied).toBe(false);
    const inbound = db().prepare("SELECT buyer_id, phone FROM inbound_events WHERE provider_message_id='rks-luke-1'").get() as { buyer_id: number; phone: string };
    expect(inbound.buyer_id).toBe(buyerId);
    expect(inbound.phone).toContain("952.221.7119");
    const job = db().prepare("SELECT instruction, input FROM grok_jobs WHERE agent='INBOUND_ANALYST'").get() as { instruction: string; input: string };
    expect(job.instruction).toMatch(/Oliver on WhatsApp|Oliver's WhatsApp/);
    expect(job.input).toContain("952.221.7119");
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE buyer_id=?").get(buyerId) as { n: number }).n).toBe(0);
  });

  it("classifies questions and auto-acks without inventing interest", () => {
    const q = classifyReply("Could you please provide the wholesale price per unit for the 8,000 hoodies?");
    expect(q.classification).toBe("information_request");
    expect(q.phone).toBeNull();
    const ack = classifyReply("Thanks for reaching out! I've forwarded your inquiry to Rob. He'll be in touch.");
    expect(ack.classification).toBe("out_of_office");
    expect(looksLikeAutoAck("We've received your request and you’ll hear from one of us personally soon.")).toBe(true);
  });

  it("answers only verified lot facts and asks for a phone when facts are missing", () => {
    const out = answerFromVerified(
      "wholesale price, fabric composition, GSM, size breakdown, pre-packed, 8000 hoodies?",
      [{ id: 55, title: "Hoodies", quantity: 8000, unitPrice: null, brand: null, extra: {} }],
    );
    expect(out.answered.join(" ")).toMatch(/8,000/);
    expect(out.missing).toEqual(expect.arrayContaining(["unit price", "fabric composition / GSM", "size breakdown / pre-pack"]));
    const body = composeWarmReply({
      company: "Joniclo LLC",
      subject: "Re: Wholesale availability — Hoodies",
      answered: out.answered,
      missing: out.missing,
      alreadyHasPhone: false,
    });
    expect(body?.body).toContain("What's the best phone number to reach you at?");
    expect(body?.body).not.toMatch(/100% cotton|\$\d+\/unit/);
    expect(composeWarmReply({
      company: "X", subject: "Re: lot", answered: [], missing: [], alreadyHasPhone: true,
    })).toBeNull();
  });

  it("sends a dry-run warm reply for a question and does not escalate without a phone", async () => {
    const buyerId = seedBuyer("askco.com");
    db().prepare("INSERT INTO lots(external_key,title,category,quantity,state,availability) VALUES('wi-1','Hoodies','apparel-basic',8000,'outreach_active','active')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='wi-1'").get() as { id: number };
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'outreach_sent','email','buy@askco.com')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,1)").run(convoId, lot.id);

    const r = await processInbound({
      from: "buy@askco.com",
      text: "Could you please provide the wholesale price per unit and fabric composition?",
      providerMessageId: "warm-q-1",
    });
    expect(r.classification).toBe("information_request");
    expect(r.escalated).toBe(false);
    expect(r.replied).toBe(true);
    const inboundId = (db().prepare("SELECT id FROM inbound_events WHERE provider_message_id='warm-q-1'").get() as { id: number }).id;
    const attempt = db().prepare("SELECT status, body, reason FROM outreach_attempts WHERE idempotency_key=?").get(`warm-reply:${inboundId}`) as { status: string; body: string; reason: string };
    expect(attempt.status).toBe("dry_run");
    expect(attempt.body).toContain("What's the best phone number to reach you at?");
    expect(attempt.body).toContain("I don't have verified");
    expect((db().prepare("SELECT COUNT(*) AS n FROM escalations WHERE buyer_id=?").get(buyerId) as { n: number }).n).toBe(0);
  });

  it("escalates a phone reply, queues the Oliver WhatsApp job, and does not ask for the number again", async () => {
    const buyerId = seedBuyer("phoneco.com");
    const r = await processInbound({
      from: "buy@phoneco.com",
      text: "Interested. My cell is 415-555-0100. Can you confirm qty?",
      providerMessageId: "warm-p-1",
    });
    expect(r.escalated).toBe(true);
    expect(r.replied).toBe(false);
    const esc = db().prepare("SELECT packet, phone FROM escalations WHERE buyer_id=?").get(buyerId) as { packet: string; phone: string };
    expect(esc.phone).toContain("415");
    expect(esc.packet).toContain("415-555-0100");
    expect(esc.packet.split("\n")).toHaveLength(3);
    const job = db().prepare("SELECT id, instruction, input FROM grok_jobs WHERE agent='INBOUND_ANALYST'").get() as { id: number; instruction: string; input: string };
    expect(job.instruction).toMatch(/Oliver on WhatsApp|Oliver's WhatsApp/);
    expect(job.input).toContain("415");
    applyOliverHandoffResult(job.id, true);
    expect((db().prepare("SELECT state FROM escalations WHERE buyer_id=?").get(buyerId) as { state: string }).state).toBe("handed_to_oliver");
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE buyer_id=? AND reason LIKE '%warm%'").get(buyerId) as { n: number }).n).toBe(0);
  });

  it("continues a stored question that was ingested before the warm reply existed", async () => {
    const buyerId = seedBuyer("laterco.com");
    db().prepare("INSERT INTO lots(external_key,title,category,quantity,state,availability) VALUES('wi-2','Hoodies','apparel-basic',8000,'outreach_active','active')").run();
    const lot = db().prepare("SELECT id FROM lots WHERE external_key='wi-2'").get() as { id: number };
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'replied','email','buy@laterco.com')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,1)").run(convoId, lot.id);
    const inbound = db().prepare(
      `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,provider_message_id,classification,interest_level,raw_text)
       VALUES(?,?,'buy@laterco.com','warm-later-1','unknown','unknown',?)`
    ).run(convoId, buyerId, "Could you confirm the wholesale price and quantity for the hoodies?");
    const inboundId = Number(inbound.lastInsertRowid);
    const result = await continueWarmInbound(inboundId);
    expect(result.reason).toBe("dry_run — not sent");
    const attempt = db().prepare("SELECT body FROM outreach_attempts WHERE idempotency_key=?").get(`warm-reply:${inboundId}`) as { body: string };
    expect(attempt.body).toContain("8,000");
    expect(attempt.body).toContain("What's the best phone number to reach you at?");
  });

  it("repairs a phone reply that was stored as a false bounce and does not email again", () => {
    const buyerId = seedBuyer("joniclofix.com", "buying@joniclofix.com");
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'replied','email','buying@joniclofix.com')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare(
      `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,provider_message_id,classification,interest_level,raw_text)
       VALUES(?,?,'mira@joniclofix.com','prior-mira','unknown','unknown','Could you confirm qty?')`
    ).run(convoId, buyerId);
    const text = [
      "Here is the information.",
      "",
      "Jonathan Tala +1 (310) 402-4554",
      "Mira Basilio",
      "",
      "From: Bailey Saevitzon <saefamoverstock@gmail.com>",
      "Subject: Re: Wholesale availability — Hoodies",
      "What's the best phone number to reach you at?",
    ].join("\n");
    db().prepare(
      `INSERT INTO inbound_events(from_address,provider_message_id,classification,interest_level,raw_text)
       VALUES('mira@joniclofix.com','false-bounce-phone','bounce','none',?)`
    ).run(text);
    db().prepare(
      "INSERT INTO suppressions(address_or_domain,reason,source) VALUES('mira@joniclofix.com','hard bounce — address only','bounce')"
    ).run();

    expect(continueMissedPhoneHandoffs()).toBe(1);
    const inbound = db().prepare("SELECT buyer_id, classification, phone FROM inbound_events WHERE provider_message_id='false-bounce-phone'").get() as { buyer_id: number; classification: string; phone: string };
    expect(inbound.buyer_id).toBe(buyerId);
    expect(inbound.phone).toContain("310");
    expect(inbound.classification).not.toBe("bounce");
    const esc = db().prepare("SELECT phone, packet FROM escalations WHERE buyer_id=?").get(buyerId) as { phone: string; packet: string };
    expect(esc.phone).toContain("310");
    expect(esc.packet).toContain("310");
    const job = db().prepare("SELECT instruction FROM grok_jobs WHERE agent='INBOUND_ANALYST'").get() as { instruction: string };
    expect(job.instruction).toMatch(/Oliver on WhatsApp|Oliver's WhatsApp/);
    expect((db().prepare("SELECT COUNT(*) AS n FROM suppressions WHERE address_or_domain='mira@joniclofix.com'").get() as { n: number }).n).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM outreach_attempts WHERE buyer_id=?").get(buyerId) as { n: number }).n).toBe(0);
    expect(continueMissedPhoneHandoffs()).toBe(0);
  });

  it("escalates the originating send lots, never a paused Bailey lot on the conversation", async () => {
    const buyerId = seedBuyer("drillreply.com");
    db().prepare("INSERT INTO lots(external_key,title,category,state,availability,project_gate) VALUES('esc-drill','Lithium-Ion Drill Tool Set','tools-hardware','outreach_active','active','AMBER')").run();
    db().prepare("INSERT INTO lots(external_key,title,category,state,availability,project_gate) VALUES('esc-bailey','Available Inventory','footwear-other','paused','paused','DO_NOT_MARKET')").run();
    const drill = db().prepare("SELECT id FROM lots WHERE external_key='esc-drill'").get() as { id: number };
    const bailey = db().prepare("SELECT id FROM lots WHERE external_key='esc-bailey'").get() as { id: number };
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'replied','email','buy@drillreply.com')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,1)").run(convoId, bailey.id);
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,'email',?,'Wholesale availability — Lithium-Ion Drill Tool Set','hi','[]','sent','provider accepted','esc-origin-1')`
    ).run(convoId, buyerId, JSON.stringify([drill.id]));

    const r = await processInbound({
      from: "buy@drillreply.com",
      text: "I am interested. Call me at 415-555-0144.",
      providerMessageId: "esc-lot-1",
    });
    expect(r.escalated).toBe(true);
    const esc = db().prepare("SELECT lot_ids, packet FROM escalations WHERE buyer_id=?").get(buyerId) as { lot_ids: string; packet: string };
    expect(JSON.parse(esc.lot_ids)).toEqual([drill.id]);
    expect(esc.packet).toContain("drill");
    expect(esc.packet).not.toContain("Available Inventory");
  });

  it("rewrites an already-queued handoff that still points at a paused lot", () => {
    const buyerId = seedBuyer("stalehandoff.com");
    db().prepare("INSERT INTO lots(external_key,title,category,state,availability,project_gate) VALUES('esc-drill-2','Lithium-Ion Drill Tool Set','tools-hardware','outreach_active','active','AMBER')").run();
    db().prepare("INSERT INTO lots(external_key,title,category,state,availability,project_gate) VALUES('esc-bailey-2','Available Inventory','footwear-other','paused','paused','DO_NOT_MARKET')").run();
    const drill = db().prepare("SELECT id FROM lots WHERE external_key='esc-drill-2'").get() as { id: number };
    const bailey = db().prepare("SELECT id FROM lots WHERE external_key='esc-bailey-2'").get() as { id: number };
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'escalated','email')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    db().prepare("INSERT INTO conversation_lots(conversation_id,lot_id,rank) VALUES(?,?,1)").run(convoId, bailey.id);
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,'email',?,'Wholesale availability — Lithium-Ion Drill Tool Set','hi','[]','sent','provider accepted','esc-origin-2')`
    ).run(convoId, buyerId, JSON.stringify([drill.id]));
    const text = "I am interested in the drill. Direct Dial: 818.848.6111";
    db().prepare(
      `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,classification,interest_level,phone,raw_text)
       VALUES(?,?,'buy@stalehandoff.com','positive_interest','high','818.848.6111',?)`
    ).run(convoId, buyerId, text);
    const escalationId = createEscalation({
      buyerId,
      conversationId: convoId,
      reason: "phone captured",
      phone: "818.848.6111",
      analysis: classifyReply(text),
      question: text,
    });
    db().prepare("UPDATE escalations SET lot_ids=?, packet=? WHERE id=?").run(
      JSON.stringify([bailey.id]),
      `stalehandoff.com — 818.848.6111 — Available Inventory\nLots: Available Inventory (${bailey.id})`,
      escalationId,
    );
    db().prepare(
      "INSERT INTO grok_jobs(agent,instruction,input) VALUES('INBOUND_ANALYST',?,?)"
    ).run(`oliver_handoff:${escalationId}`, JSON.stringify({ escalationId, packet: "old", phone: "818.848.6111" }));

    expect(refreshOpenHandoffLots()).toBe(1);
    const esc = db().prepare("SELECT lot_ids, packet FROM escalations WHERE id=?").get(escalationId) as { lot_ids: string; packet: string };
    expect(JSON.parse(esc.lot_ids)).toEqual([drill.id]);
    expect(esc.packet).toContain("drill");
    expect(esc.packet).not.toContain("Available Inventory");
    const job = db().prepare("SELECT input FROM grok_jobs WHERE instruction LIKE ?").get(`%oliver_handoff:${escalationId}%`) as { input: string };
    expect(job.input).toContain("drill");
    expect(job.input).toContain("\"photos\":[]");
    expect(job.input).not.toContain(`(${bailey.id})`);
  });

  it("does not hand a pass + signature phone to Oliver", async () => {
    seedBuyer("olliepass.com");
    const r = await processInbound({
      from: "buyer@olliepass.com",
      text: "Thanks the apparel is a pass\n\nKevin Albert\nSenior Buyer\n717-657-2300",
      providerMessageId: "pass-sig-1",
    });
    expect(r.escalated).toBe(false);
    expect(r.classification).toBe("not_interested");
    expect((db().prepare("SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST'").get() as { n: number }).n).toBe(0);
  });

  it("queues a missing Oliver job for an already-open genuine phone escalation", () => {
    const buyerId = seedBuyer("missedjob.com");
    const convo = db().prepare("INSERT INTO conversations(buyer_id,state,channel) VALUES(?,'replied','email')").run(buyerId);
    const convoId = Number(convo.lastInsertRowid);
    const text = "Interested. Call me at 415-555-0199.";
    db().prepare(
      `INSERT INTO inbound_events(conversation_id,buyer_id,from_address,classification,interest_level,phone,raw_text)
       VALUES(?,?,'buy@missedjob.com','request_call','high','415-555-0199',?)`
    ).run(convoId, buyerId, text);
    createEscalation({
      buyerId,
      conversationId: convoId,
      reason: "phone captured",
      phone: "415-555-0199",
      analysis: classifyReply(text),
      question: text,
    });
    expect(db().prepare("SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST'").get() as { n: number }).toEqual({ n: 0 });
    expect(continueMissedPhoneHandoffs()).toBeGreaterThanOrEqual(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM grok_jobs WHERE agent='INBOUND_ANALYST' AND instruction LIKE '%oliver_handoff:%'").get() as { n: number }).n).toBeGreaterThanOrEqual(1);
  });

  it("does not hand bounce DSNs to Oliver", async () => {
    const buyerId = seedBuyer("dsnco.com");
    const r = await processInbound({
      from: "mailer-daemon@google.com",
      text: "Address not found. 550 5.1.1 The email account does not exist. id 1785690644",
      providerMessageId: "warm-b-1",
      bounced: true,
    });
    expect(r.classification).toBe("bounce");
    expect(r.escalated).toBe(false);
    expect((db().prepare("SELECT COUNT(*) AS n FROM escalations WHERE buyer_id=?").get(buyerId) as { n: number }).n).toBe(0);
  });
});
