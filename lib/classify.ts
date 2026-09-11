import { z } from "zod";

export const CLASSIFICATIONS = [
  "positive_interest", "information_request", "request_call", "counterprice",
  "not_interested", "wrong_contact", "referral_to_colleague", "out_of_office",
  "bounce", "unsubscribe", "suspicious", "unknown", "request_photos",
  "request_manifest", "pallet_only", "insufficient_capacity",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const ReplyAnalysis = z.object({
  classification: z.enum(CLASSIFICATIONS),
  interestLevel: z.enum(["high", "medium", "low", "none", "unknown"]),
  targetQuantity: z.string().nullable(),
  targetPrice: z.number().nullable(),
  phone: z.string().nullable(),
  requestedDocuments: z.array(z.string()),
  objections: z.array(z.string()),
  contactReferral: z.string().nullable(),
  confidence: z.number(),
  snippets: z.array(z.string()),
});
export type ReplyAnalysisT = z.infer<typeof ReplyAnalysis>;

export function extractPhone(text: string): string | null {
  const m = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

export function buyerAuthoredReply(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const boundaries = [/^On .+wrote:\s*$/im, /^From:\s.+$/im, /^-{2,}\s*Original Message/im];
  const cut = Math.min(...boundaries.map((re) => re.exec(normalized)?.index ?? normalized.length));
  return normalized.slice(0, cut).split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();
}

export function classifyReply(raw: string, meta?: { bounced?: boolean; autoReplyHeader?: boolean }): ReplyAnalysisT {
  const text = buyerAuthoredReply(raw).slice(0, 20000);
  const t = text.toLowerCase();
  const base: ReplyAnalysisT = {
    classification: "unknown",
    interestLevel: "unknown",
    targetQuantity: null,
    targetPrice: null,
    phone: extractPhone(text),
    requestedDocuments: [],
    objections: [],
    contactReferral: null,
    confidence: 0.4,
    snippets: [],
  };
  const set = (c: Classification, conf: number) => {
    base.classification = c;
    base.confidence = conf;
  };

  if (meta?.bounced || /delivery (status notification|failed)|address not found|550 /.test(t)) {
    set("bounce", 0.95);
    base.interestLevel = "none";
    return ReplyAnalysis.parse(base);
  }
  if (/unsubscribe|remove me|stop (emailing|contacting)|do( |-)?n['’o]?t (contact|email)|\bplease stop\b|^stop\.?$/im.test(t)) {
    set("unsubscribe", 0.98);
    base.interestLevel = "none";
    return ReplyAnalysis.parse(base);
  }
  if (meta?.autoReplyHeader || /out of (the )?office|on vacation|auto-?reply|automatic reply/.test(t)) {
    set("out_of_office", 0.9);
    return ReplyAnalysis.parse(base);
  }
  if (/western union|crypto wallet|advance fee|gift cards?/.test(t)) {
    set("suspicious", 0.85);
    return ReplyAnalysis.parse(base);
  }
  if (/not (for us|interested)|no thank|we pass\b|have to decline/.test(t)) {
    set("not_interested", 0.85);
    base.interestLevel = "none";
    base.objections.push("not_interested");
  }
  if (/call|phone|zoom|meet/.test(t) && /can we|let'?s|schedule|available|give me/.test(t)) {
    if (base.classification === "unknown") set("request_call", 0.85);
    base.interestLevel = "high";
  }
  const counter = text.match(/(?:we'?d be at|could do|offer(?:ing)?|max(?:imum)?)\s*\$\s?(\d[\d,]*(?:k)?)/i);
  if (counter) {
    const v = counter[1].replace(/,/g, "");
    base.targetPrice = v.endsWith("k") ? Number(v.slice(0, -1)) * 1000 : Number(v);
    set("counterprice", 0.85);
    base.interestLevel = "high";
  }
  if (/interested|sounds (good|interesting)|send (it|over|details)|yes,? (we|that)/.test(t) && base.classification === "unknown") {
    set("positive_interest", 0.8);
    base.interestLevel = "high";
  }
  if (/manifest|item list|sku list/.test(t)) {
    base.requestedDocuments.push("manifest");
    if (base.classification === "unknown") set("request_manifest", 0.8);
  }
  if (/photos?|pictures?/.test(t) && /send|share|see|need/.test(t)) {
    base.requestedDocuments.push("photos");
    if (base.classification === "unknown") set("request_photos", 0.8);
  }
  const qty = text.match(/(\d{1,3}(?:,\d{3})*)\s*(?:pairs|units|pcs)/i);
  if (qty) base.targetQuantity = `${qty[1]} units`;
  if (["positive_interest", "request_call", "counterprice", "information_request"].includes(base.classification)) {
    base.interestLevel = "high";
  }
  return ReplyAnalysis.parse(base);
}

export function isHotLead(a: ReplyAnalysisT): boolean {
  return a.interestLevel === "high" || !!a.phone || a.classification === "request_call" || a.classification === "counterprice";
}
