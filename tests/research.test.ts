import { describe, expect, it } from "vitest";
import { POST as postFindings } from "../app/api/research/findings/route";
import { db } from "../lib/db";
import { funnel, opportunityWorklist, researchCoverage } from "../lib/metrics";
import { enrollBuyer } from "../lib/research";

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

  it("lists known domains so research can skip rediscovery", () => {
    enrollBuyer({ company: "Known Co", domain: "knownco.com", categories: "apparel" });
    const cov = researchCoverage();
    expect(cov.mode).toBe("dry_run");
    expect(cov.kill).toBe(false);
    expect(cov.known_domains).toContain("knownco.com");
    expect(cov.buyer_counts.total).toBeGreaterThanOrEqual(1);
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
  });
});
