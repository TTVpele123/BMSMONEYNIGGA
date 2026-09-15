import { z } from "zod";
import { recordEndpoint } from "@/lib/channels/select";
import type { ChannelId } from "@/lib/channels/types";
import { CHANNEL_IDS } from "@/lib/channels/types";
import { audit } from "@/lib/db";
import { emit } from "@/lib/events";
import { enrollBuyer, lotEligibleForResearch, recordContact, recordMandate } from "@/lib/research";
import { applyBetterContact, isGuessedRoleEmail } from "@/lib/targeting";

const Finding = z.object({
  agent: z.string(),
  lotId: z.number().optional(),
  buyers: z.array(z.object({
    company: z.string(),
    domain: z.string(),
    website: z.string().optional(),
    categories: z.string().optional(),
    verification: z.string().optional(),
    evidence: z.array(z.object({ url: z.string(), quote: z.string() })).default([]),
    endpoints: z.array(z.object({
      channel: z.enum(CHANNEL_IDS),
      handle: z.string(),
      source: z.string(),
      evidence: z.string(),
      name: z.string().optional(),
      title: z.string().optional(),
      confidence: z.number().min(0).max(1),
      discovered_at: z.string().optional(),
      outreach_permitted: z.boolean().default(true),
      executable: z.boolean().default(false),
    })).default([]),
    mandate: z.object({
      category: z.string(),
      stance: z.enum(["accepts", "rejects", "unknown"]),
      sourceUrl: z.string(),
      sourceQuote: z.string(),
    }).optional(),
  })),
});

export async function POST(req: Request) {
  try {
    const body = Finding.parse(await req.json());
    const enrolled: number[] = [];
    const skippedGuessedEmails: string[] = [];
    for (const b of body.buyers) {
      const { buyerId } = enrollBuyer({
        company: b.company,
        domain: b.domain,
        website: b.website,
        categories: b.categories,
        source_evidence: b.evidence.map((e) => `${e.url} :: ${e.quote}`).join(" | ") || undefined,
        verification_status: b.verification ?? "unverified",
      });
      for (const ep of b.endpoints) {
        if (!ep.outreach_permitted) continue;
        if (ep.channel === "email" && isGuessedRoleEmail(ep.handle, ep.evidence)) {
          skippedGuessedEmails.push(`${b.domain}:${ep.handle}`);
          continue;
        }
        recordEndpoint({
          buyerId,
          channel: ep.channel as ChannelId,
          handle: ep.handle,
          confidence: ep.confidence,
          verified: ep.executable && ep.confidence >= 0.8,
          source: `${body.agent}:${ep.source}`,
        });
        if (ep.channel === "email") {
          recordContact({
            buyerId,
            email: ep.handle,
            name: ep.name,
            title: ep.title,
            verification: ep.executable && ep.confidence >= 0.8 ? "verified" : (b.verification ?? "unverified"),
          });
          applyBetterContact(buyerId, ep.handle);
        }
      }
      if (b.mandate) {
        recordMandate({
          buyerId,
          category: b.mandate.category,
          stance: b.mandate.stance,
          origin: "research",
          sourceUrl: b.mandate.sourceUrl,
          sourceQuote: b.mandate.sourceQuote,
        });
      }
      enrolled.push(buyerId);
    }
    if (body.lotId != null && lotEligibleForResearch(body.lotId)) {
      emit("match.requested", { lotId: body.lotId }, `match.requested:findings:${body.lotId}:${enrolled.join(",") || "none"}`);
    }
    audit("research", "findings_ingested", { detail: { agent: body.agent, lotId: body.lotId, buyers: enrolled, skippedGuessedEmails } });
    return Response.json({ ok: true, buyerIds: enrolled, skippedGuessedEmails });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
