import { describe, expect, it } from "vitest";
import { POST as postFindings } from "../app/api/research/findings/route";
import { db } from "../lib/db";
import { funnel } from "../lib/metrics";

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

  it("exposes the north-star funnel keys", () => {
    const f = funnel();
    expect(f.north_star).toBeDefined();
    expect(f.lots_received).toBe(0);
    expect(f.live_sends).toBe(0);
    expect(f.revenue).toBeNull();
    expect(f.opportunities_by_channel).toEqual([]);
  });
});
