import { describe, expect, it } from "vitest";
import { POST as postFindings } from "../app/api/research/findings/route";
import { db } from "../lib/db";
import { funnel, opportunityWorklist, researchCoverage } from "../lib/metrics";
import { suppressBouncedAddress } from "../lib/inbound";
import { enrollBuyer, recordContact } from "../lib/research";
import { writeBounce } from "../lib/suppression";

function req(body: unknown) {
  return new Request("http://localhost:3222/api/research/findings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("research findings + north-star", () => {
  it("rejects guessed purchasing@ without mailto evidence", async () => {
    const res = await postFindings(req({
      agent: "BUYER_RESEARCHER",
      lotId: 1,
      buyers: [{
        company: "Guess Co",
        domain: "guessco.com",
        categories: "apparel",
        evidence: [{ url: "https://guessco.com", quote: "homepage only" }],
        endpoints: [{
          channel: "email",
          handle: "purchasing@guessco.com",
          source: "guess",
          evidence: "looks like a wholesaler",
          confidence: 0.9,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const json = await res.json() as { ok: boolean; buyerIds: number[]; skippedGuessedEmails: string[] };
    expect(json.ok).toBe(true);
    expect(json.skippedGuessedEmails).toEqual(["guessco.com:purchasing@guessco.com"]);
    const eps = db().prepare("SELECT handle FROM buyer_channel_endpoints WHERE buyer_id=?").all(json.buyerIds[0]);
    expect(eps).toEqual([]);
  });

  it("records an evidenced mailto and a deferred form", async () => {
    const res = await postFindings(req({
      agent: "OPPORTUNITY_RESEARCHER",
      buyers: [{
        company: "Real Wholesale",
        domain: "realwholesale.com",
        evidence: [{ url: "https://realwholesale.com/contact", quote: "mailto:jane@realwholesale.com" }],
        endpoints: [
          {
            channel: "email",
            handle: "jane@realwholesale.com",
            source: "https://realwholesale.com/contact",
            evidence: "mailto jane@realwholesale.com on contact page",
            confidence: 0.85,
            outreach_permitted: true,
            executable: true,
          },
          {
            channel: "form",
            handle: "https://realwholesale.com/vendors",
            source: "https://realwholesale.com/vendors",
            evidence: "public vendor intake form",
            confidence: 0.7,
            outreach_permitted: true,
            executable: false,
          },
        ],
        mandate: {
          category: "apparel-licensed",
          stance: "accepts",
          sourceUrl: "https://realwholesale.com/vendors",
          sourceQuote: "We buy licensed apparel closeouts",
        },
      }],
    }));
    const json = await res.json() as { ok: boolean; buyerIds: number[]; skippedGuessedEmails: string[] };
    expect(json.ok).toBe(true);
    expect(json.skippedGuessedEmails).toEqual([]);
    const channels = db().prepare(
      "SELECT channel, handle FROM buyer_channel_endpoints WHERE buyer_id=? ORDER BY channel"
    ).all(json.buyerIds[0]) as { channel: string; handle: string }[];
    expect(channels.map((c) => c.channel)).toEqual(["email", "form"]);
    const mandate = db().prepare("SELECT stance, source_quote FROM buyer_mandates WHERE buyer_id=?").get(json.buyerIds[0]) as { stance: string; source_quote: string };
    expect(mandate.stance).toBe("accepts");
    expect(mandate.source_quote).toContain("licensed apparel");
  });

  it("enriches the same buyer with people instead of creating a second company", async () => {
    const first = await postFindings(req({
      agent: "BUYER_RESEARCHER",
      buyers: [{
        company: "People Co",
        domain: "peopleco.com",
        categories: "apparel",
        endpoints: [{
          channel: "form",
          handle: "https://peopleco.com/contact",
          source: "site",
          evidence: "public contact form",
          confidence: 0.7,
          outreach_permitted: true,
          executable: false,
        }],
      }],
    }));
    const a = await first.json() as { buyerIds: number[] };
    const second = await postFindings(req({
      agent: "BUYER_RESEARCHER",
      buyers: [{
        company: "People Co",
        domain: "peopleco.com",
        categories: "closeout",
        people: [{
          name: "Pat Buyer",
          title: "Purchasing",
          email: "pat@peopleco.com",
          linkedin: "https://linkedin.com/in/patbuyer",
        }],
      }],
    }));
    const b = await second.json() as { buyerIds: number[] };
    expect(b.buyerIds[0]).toBe(a.buyerIds[0]);
    expect((db().prepare("SELECT COUNT(*) AS n FROM buyers WHERE domain='peopleco.com'").get() as { n: number }).n).toBe(1);
    const contact = db().prepare("SELECT name, email FROM buyer_contacts WHERE buyer_id=?").get(a.buyerIds[0]) as { name: string; email: string };
    expect(contact).toMatchObject({ name: "Pat Buyer", email: "pat@peopleco.com" });
    const cats = db().prepare("SELECT categories FROM buyers WHERE id=?").get(a.buyerIds[0]) as { categories: string };
    expect(cats.categories).toContain("apparel");
    expect(cats.categories).toContain("closeout");
  });

  it("lists known domains so research can skip rediscovery", () => {
    const { buyerId } = enrollBuyer({ company: "Known Co", domain: "knownco.com", categories: "apparel" });
    recordContact({ buyerId, email: "buy@knownco.com", verification: "verified" });
    const cov = researchCoverage();
    expect(cov.mode).toBe("dry_run");
    expect(cov.kill).toBe(false);
    expect(cov.known_domains).toContain("knownco.com");
    expect(cov.buyer_counts.total).toBeGreaterThanOrEqual(1);
  });

  it("does not treat a hard-bounced mailbox as email-ready", async () => {
    const { buyerId } = enrollBuyer({ company: "Bounce Ready", domain: "bounceready.com", categories: "apparel" });
    recordContact({ buyerId, email: "dead@bounceready.com", verification: "verified" });
    recordContact({ buyerId, email: "alive@bounceready.com", verification: "verified" });
    writeBounce("dead@bounceready.com");
    const cov = researchCoverage();
    expect(cov.known_domains).toContain("bounceready.com");
    expect(cov.buyer_counts.with_email).toBeGreaterThanOrEqual(1);
    const bouncedOnly = enrollBuyer({ company: "Dead Mail", domain: "deadmail.co", categories: "apparel" });
    recordContact({ buyerId: bouncedOnly.buyerId, email: "gone@deadmail.co", verification: "verified" });
    suppressBouncedAddress("gone@deadmail.co");
    const after = researchCoverage();
    expect(after.known_domains).not.toContain("deadmail.co");
    expect(after.bounced_domains).toContain("deadmail.co");
    expect(after.buyer_counts.with_email).toBe(cov.buyer_counts.with_email);
    const res = await postFindings(req({
      agent: "BUYER_RESEARCHER",
      buyers: [{
        company: "Dead Mail",
        domain: "deadmail.co",
        people: [{ email: "gone@deadmail.co", name: "Gone" }],
        endpoints: [{
          channel: "email",
          handle: "gone@deadmail.co",
          source: "old page",
          evidence: "mailto gone@deadmail.co",
          confidence: 0.9,
          outreach_permitted: true,
          executable: true,
        }],
      }],
    }));
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
    const eps = db().prepare(
      "SELECT handle FROM buyer_channel_endpoints WHERE buyer_id=? AND channel='email'"
    ).all(bouncedOnly.buyerId) as { handle: string }[];
    expect(eps.map((e) => e.handle)).not.toContain("gone@deadmail.co");
  });

  it("worklist exposes company/domain so Grok can rank a pair", () => {
    const { buyerId } = enrollBuyer({ company: "Path Co", domain: "pathco.com", categories: "apparel" });
    db().prepare(
      "INSERT INTO opportunities(buyer_id,lot_ids,stage,reason) VALUES(?,'[1]','blocked','no legitimate channel endpoint')"
    ).run(buyerId);
    const w = opportunityWorklist();
    expect(w.mode).toBe("dry_run");
    expect(w.kill).toBe(false);
    const pair = w.pairs.find((p) => p.buyer.domain === "pathco.com");
    expect(pair?.buyer.company).toBe("Path Co");
    expect(pair?.stage).toBe("blocked");
    expect(pair?.buyer.suppressed).toBe(false);
  });

  it("exposes the north-star funnel keys", () => {
    const f = funnel();
    expect(f.north_star).toBeDefined();
    expect(f.lots_received).toBe(0);
    expect(f.live_sends).toBe(0);
    expect(f.revenue).toBeNull();
    expect(f.opportunities_by_channel).toEqual([]);
    expect(f.channel_board.researched_buyers).toBe(0);
    expect(f.channel_board.channel_ready).toBe(0);
  });
});
