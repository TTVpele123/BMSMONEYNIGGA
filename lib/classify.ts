import { z } from "zod";
import { looksLikeSenderLimit } from "./email/bounce";

export const CLASSIFICATIONS = [
  "positive_interest", "information_request", "request_call", "counterprice",
  "not_interested", "wrong_contact", "referral_to_colleague", "out_of_office",
  "bounce", "send_limit", "unsubscribe", "suspicious", "unknown", "request_photos",
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

const NANP = /(?:\+?1[-.\s])?(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b/g;
const COMPACT_NANP = /\b([2-9]\d{9})\b/g;
const OUR_LINE = /818[-.\s]?406[-.\s]?8612/;
const MOBILE_LABEL = /(?:^|\n)\s*(?:m|c|cell|mobile|direct|whatsapp)\s*[:.\-]?\s*((?:\+?1[-.\s])?(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s](?:\(?0\)?[-.\s]?)?\d{2,4}[-.\s]\d{3,4}[-.\s]?\d{3,4})/i;
const FAX_LABEL = /(?:^|\n|[|\s])(?:f|fax)\s*[:.\-]?\s*((?:\+?1[-.\s])?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4})/i;

function cleanPhone(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

function looksLikeEmbeddedId(text: string, phone: string): boolean {
  const d = phoneDigits(phone);
  if (d.length < 10) return false;
  const longs = text.match(/\d{12,}/g) ?? [];
  if (longs.some((n) => n.includes(d))) return true;
  return new RegExp(`\\[\\d*${d}\\d*\\]`).test(text);
}

/** Authored reply + signature. Prefer a labeled mobile/direct line; never return our own number or a fax. */
export function extractPhone(text: string): string | null {
  const hay = buyerAuthoredReply(text) || text;
  const fax = new Set((hay.match(new RegExp(FAX_LABEL, "gi")) ?? []).map((m) => phoneDigits(m)));
  const labeled = hay.match(MOBILE_LABEL);
  if (labeled?.[1] && !OUR_LINE.test(labeled[1]) && !fax.has(phoneDigits(labeled[1])) && !looksLikeEmbeddedId(hay, labeled[1])) {
    return cleanPhone(labeled[1]);
  }
  const all = [...(hay.match(NANP) ?? []), ...(hay.match(COMPACT_NANP) ?? [])];
  const picked = all.find((p) => !OUR_LINE.test(p) && !fax.has(phoneDigits(p)) && !looksLikeEmbeddedId(hay, p));
  return picked ? cleanPhone(picked) : null;
}

/** Thank-you / ticket / forwarded acks are not buyer interest. */
export function looksLikeAutoAck(raw: string): boolean {
  const t = buyerAuthoredReply(raw).toLowerCase();
  return /thank you for (contacting|reaching out|your (email|inquiry|request))/.test(t)
    || /we('ve| have) received your (request|email|inquiry)/.test(t)
    || /forwarded your (inquiry|email|request)/.test(t)
    || /you('ll| will) hear from/.test(t)
    || /this is an automatic/.test(t)
    || /do not reply to this/.test(t);
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

  if (looksLikeSenderLimit(raw)) {
    set("send_limit", 0.98);
    base.interestLevel = "none";
    base.phone = null;
    return ReplyAnalysis.parse(base);
  }
  if (meta?.bounced || /delivery (status notification|failed)|address not found|user unknown|unknown user|recipient rejected|mailbox (not found|unavailable)|550 |5\.1\.\d|5\.4\.1|5\.2\.\d|message blocked|blocked as spam|suspicious|couldn.?t be delivered|undeliverable/.test(t)) {
    set("bounce", 0.95);
    base.interestLevel = "none";
    base.phone = null;
    return ReplyAnalysis.parse(base);
  }
  if (/unsubscribe|remove me|stop (emailing|contacting)|do( |-)?n['’o]?t (contact|email)|\bplease stop\b|^stop\.?$/im.test(t)) {
    set("unsubscribe", 0.98);
    base.interestLevel = "none";
    return ReplyAnalysis.parse(base);
  }
  if (meta?.autoReplyHeader || /out of (the )?office|on vacation|auto-?reply|automatic reply/.test(t)
    || (looksLikeAutoAck(text) && !/\?/.test(text))) {
    set("out_of_office", 0.9);
    base.phone = null;
    return ReplyAnalysis.parse(base);
  }
  if (/western union|crypto wallet|advance fee|gift cards?/.test(t)) {
    set("suspicious", 0.85);
    return ReplyAnalysis.parse(base);
  }
  if (/not (for us|interested)|no thank|we pass\b|is a pass|that'?s a pass|pass on (the|this|that)|have to decline|don['’]?t have a need|do not have a need|\bno need\b/.test(t)) {
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
  if (/\?|(please |can you |could you )(provide|confirm|send|share)|what(?:'s| is) the|how many|unit price|wholesale price|composition|fabric|gsm|size break|pre-?pack/.test(t)
    && base.classification === "unknown") {
    set("information_request", 0.8);
  }
  if (["positive_interest", "request_call", "counterprice", "information_request"].includes(base.classification)) {
    base.interestLevel = "high";
  }
  return ReplyAnalysis.parse(base);
}

function isTollFree(phone: string): boolean {
  const d = phone.replace(/\D/g, "");
  return /^1?8(00|88|77|66|55)/.test(d);
}

/** Stored mobile/direct only — never our line, never toll-free, never invented. */
export function usableDirectPhone(phone: string | null | undefined): string | null {
  if (!phone || !String(phone).trim()) return null;
  const clean = String(phone).replace(/\s+/g, " ").trim();
  if (OUR_LINE.test(clean) || isTollFree(clean)) return null;
  return clean;
}

/** Oliver handoff only after a real buyer phone — never bounce/OOO/ack/pass/toll-free. */
export function isHotLead(a: ReplyAnalysisT): boolean {
  if (["bounce", "send_limit", "out_of_office", "unsubscribe", "suspicious", "not_interested"].includes(a.classification)) return false;
  if (!usableDirectPhone(a.phone)) return false;
  return true;
}
