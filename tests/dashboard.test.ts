import { describe, expect, it } from "vitest";
import { LIVE_DOMAIN_CAP } from "../lib/caps";
import { dealDashboard } from "../lib/dashboard";
import { db, setSetting } from "../lib/db";
import { enrollBuyer } from "../lib/research";

function seedBuyer(domain: string) {
  const { buyerId } = enrollBuyer({
    company: domain,
    domain,
    categories: "closeout",
    verification_status: "verified",
    outreach_channel: "email",
  });
  const conversationId = Number(
    db().prepare("INSERT INTO conversations(buyer_id,state,channel,contact_email) VALUES(?,'idle','email',?)")
      .run(buyerId, `buy@${domain}`).lastInsertRowid,
  );
  return { buyerId, conversationId };
}

describe("deal dashboard counts", () => {
  it("counts only provider-confirmed sends and delivered Oliver jobs", () => {
    setSetting("outbound_mode", "live");
    const { buyerId, conversationId } = seedBuyer("dashsend.com");
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,'email','[1]','','','[]','failed','gmail 429','dash-fail')`,
    ).run(conversationId, buyerId);
    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
       VALUES(?,?,'email','[1]','','','[]','logged','queued','dash-queued')`,
    ).run(conversationId, buyerId);
    const before = dealDashboard();
    expect(before.today.sends).toBe(0);

    db().prepare(
      `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key,provider_message_id)
       VALUES(?,?,'email','[1]','','','[]','sent','provider accepted','dash-sent','gmail-real-1')`,
    ).run(conversationId, buyerId);
    db().prepare(
      `INSERT INTO grok_jobs(agent,instruction,input,state) VALUES('INBOUND_ANALYST','oliver_handoff:1','{}','queued')`,
    ).run();
    const mid = dealDashboard();
    expect(mid.today.sends).toBe(1);
    expect(mid.today.oliverDelivered).toBe(0);
    expect(mid.today.oliverQueued).toBe(1);

    db().prepare(
      `INSERT INTO grok_jobs(agent,instruction,input,state,finished_at) VALUES('INBOUND_ANALYST','oliver_handoff:2','{}','done',datetime('now'))`,
    ).run();
    const after = dealDashboard();
    expect(after.today.sends).toBe(1);
    expect(after.today.oliverDelivered).toBe(1);
    expect(after.pipeline.stages.find((s) => s.key === "oliver")?.n).toBe(1);
    expect(after.system.domainCap).toBe(LIVE_DOMAIN_CAP);
    expect(after.system.domainCap).toBe(4);
    expect(typeof after.system.emailSendable).toBe("number");
    expect(after.system.senders?.length).toBeGreaterThanOrEqual(2);
    expect(after.system.sender).toBeTruthy();
  });

  it("counts today replies and phones, not bounces as replies", () => {
    const { buyerId } = seedBuyer("dashreply.com");
    db().prepare(
      `INSERT INTO inbound_events(buyer_id,from_address,classification,interest_level,phone,raw_text)
       VALUES(?,'buy@dashreply.com','positive_interest','high','415-555-0100','call me')`,
    ).run(buyerId);
    db().prepare(
      `INSERT INTO inbound_events(buyer_id,from_address,classification,interest_level,raw_text)
       VALUES(?,'dead@dashreply.com','bounce','none','550 address not found')`,
    ).run(buyerId);
    db().prepare(
      `INSERT INTO inbound_events(from_address,classification,interest_level,raw_text)
       VALUES('mailer-daemon@googlemail.com','bounce','none','You have reached a limit for sending mail. Your message was not sent.')`,
    ).run();
    db().prepare(
      `INSERT INTO inbound_events(from_address,classification,interest_level,raw_text)
       VALUES('mailer-daemon@googlemail.com','send_limit','none','You have reached a limit for sending mail. Your message was not sent.')`,
    ).run();
    const d = dealDashboard();
    expect(d.today.replies).toBe(1);
    expect(d.today.phones).toBe(1);
    expect(d.today.bounces).toBe(1);
    expect(d.today.warm).toBe(1);
    expect(d.warmest.length).toBeLessThanOrEqual(3);
    expect(d.warmest.some((w) => w.domain === "dashreply.com" && w.phone?.includes("415"))).toBe(true);
    expect(d.warmest.every((w) => w.classification !== "bounce")).toBe(true);
    expect(d.warmest.find((w) => w.domain === "dashreply.com")?.nextAction).toMatch(/Oliver|phone/i);
  });
});
