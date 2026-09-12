import { describe, expect, it } from "vitest";
import { listOperators } from "../lib/channels/registry";
import { recordEndpoint, selectChannel } from "../lib/channels/select";
import { db } from "../lib/db";
import { createOpportunity, dispatchOpportunity } from "../lib/opportunity";
import { enrollBuyer } from "../lib/research";

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
    expect(selectChannel(c)?.endpoint.channel).toBe("instagram");

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
    expect(result.status).toBe("deferred");
    const row = db().prepare("SELECT stage FROM opportunities WHERE id=?").get(oppId) as { stage: string };
    expect(row.stage).toBe("deferred");
  });

  it("keeps operators separate and email as the only live adapter", () => {
    const ops = listOperators();
    expect(ops.map((o) => o.id).sort()).toEqual([
      "application", "email", "form", "instagram", "linkedin", "marketplace", "other", "phone",
    ].sort());
    expect(ops.filter((o) => o.liveExecution).map((o) => o.id)).toEqual(["email"]);
    expect(new Set(ops.map((o) => o.id)).size).toBe(ops.length);
  });
});
