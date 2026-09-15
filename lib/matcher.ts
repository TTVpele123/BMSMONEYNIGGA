/**
 * Single canonical matcher.
 * Hard DQ + do-not-contact run first. No LLM may override a hard disqualifier.
 */

export const CATEGORIES = [
  "footwear-athletic", "footwear-other", "apparel-licensed", "apparel-basic", "apparel-kids",
  "electronics", "appliances", "home-goods", "furniture", "toys", "health-beauty",
  "tools-hardware", "food-beverage", "industrial-supplies", "hospitality-supplies",
  "crafts", "general-merchandise", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface LotLike {
  id: number;
  category: string;
  quantity: number | null;
  unit_price: number | null;
  total_price: number | null;
}

export interface BuyerLike {
  id: number;
  company: string;
  domain: string;
  channel: string;
  categories: string;
  txn_capacity_usd: number | null;
  geography: string;
  verification_status: string;
  source_evidence: string | null;
  confidence: number | null;
  disqualified_reason: string | null;
}

export interface MandateLike {
  id: number;
  buyer_id: number;
  category: string;
  stance: "accepts" | "rejects" | "unknown";
  min_units: number | null;
  max_units: number | null;
  superseded_by: number | null;
  confidence: number;
}

export interface CategoryStatLike {
  buyer_id: number;
  category: string;
  sends: number;
  replies: number;
  offers: number;
  closes: number;
  ignores: number;
  rejects: number;
}

export type MatchBucket = "explicit" | "historical" | "compatible" | "doNotContact";

export interface UnifiedMatch {
  buyerId: number;
  score: number;
  bucket: MatchBucket;
  capacityScore: number;
  productFitScore: number;
  geographyScore: number;
  historyScore: number;
  contactScore: number;
  rationale: string;
  hardDisqualified: string | null;
}

const GENERALIST = /^(closeouts?|liquidations?|overstock|excess|general|general merchandise)$/;

export function normalizeCategory(raw: string): Category {
  const s = (raw || "").toLowerCase();
  if (/athletic|sneaker|shoe|footwear|trainer|boot|sandal|slide|slipper|flip-?flop/.test(s)) {
    return /athletic|sneaker|trainer/.test(s) ? "footwear-athletic" : "footwear-other";
  }
  if (/appliance|refrigerator|washer|dryer|microwave|dishwasher/.test(s)) return "appliances";
  if (/drone|quadcopter|remote-?control/.test(s)) return "electronics";
  if (/electronic|monitor|\btv\b|television|laptop|computer|phone|audio/.test(s)) return "electronics";
  if (/toy|\bgame|puzzle/.test(s)) return "toys";
  if (/licen|character|disney|pokemon|marvel|nfl|nba|mlb/.test(s)) return "apparel-licensed";
  if (/kid|youth|infant|toddler/.test(s)) return "apparel-kids";
  if (/apparel|clothing|tee|fleece|hoodie|garment|sock|cardigan|sweater|knit/.test(s)) return "apparel-basic";
  if (/beauty|cosmetic|health|\bhba\b|skincare|fragrance/.test(s)) return "health-beauty";
  if (/tool|hardware|drill/.test(s)) return "tools-hardware";
  if (/hospitality|restaurant|hotel|foodservice/.test(s)) return "hospitality-supplies";
  if (/food|beverage|grocery|snack|drink/.test(s)) return "food-beverage";
  if (/industrial|\bmro\b|janitorial/.test(s)) return "industrial-supplies";
  if (/furniture|mattress|sofa/.test(s)) return "furniture";
  if (/\bcrafts?\b|\bhobby\b/.test(s)) return "crafts";
  if (/home|kitchen|bedding|houseware|decor/.test(s)) return "home-goods";
  if (/general|closeout|liquidation|surplus|overstock|merchandise|mixed|inventory|pallet/.test(s)) return "general-merchandise";
  return "other";
}

/** Title wins when it names a real category. Caption leftovers must not relabel a drill as apparel. */
export function inferLotCategory(title?: string | null, rawText?: string | null): Category {
  const fromTitle = normalizeCategory(title ?? "");
  if (fromTitle !== "other" && fromTitle !== "general-merchandise") return fromTitle;
  const fromBody = normalizeCategory(rawText ?? "");
  if (fromBody !== "other") return fromBody;
  return fromTitle;
}

export function lotDealValueUsd(lot: LotLike): number {
  return lot.total_price ?? ((lot.unit_price ?? 0) * (lot.quantity ?? 0));
}

export function validateMandateEvidence(input: { origin?: string; sourceUrl?: string | null; sourceQuote?: string | null }): void {
  const origin = input.origin ?? "research";
  if ((origin === "research" || origin === "inferred") && !(input.sourceUrl && input.sourceQuote)) {
    throw new Error(`mandate origin='${origin}' requires sourceUrl and sourceQuote`);
  }
}

function isGeneralist(categoriesCsv: string): boolean {
  return categoriesCsv.split(",").some((c) => GENERALIST.test(c.trim().toLowerCase()));
}

function categoryFamily(cat: Category): string {
  return cat.split("-")[0];
}

/** Canonical classes from a researcher CSV or prose blob. */
export function buyerNormalizedCategories(raw: string): Category[] {
  const out = new Set<Category>();
  if (!raw.trim()) return [];
  out.add(normalizeCategory(raw));
  for (const part of raw.split(/[,;/|]+/)) {
    const n = normalizeCategory(part.trim());
    if (n !== "other" || /\bother\b/i.test(part)) out.add(n);
  }
  return [...out];
}

export function categoryFitsLot(buyerCategories: string, lotCategory: string, mandateAccepts: string[] = []): boolean {
  if (!buyerCategories.trim() && !mandateAccepts.length) return true;
  if (isGeneralist(buyerCategories)) return true;
  const lotCat = normalizeCategory(lotCategory);
  const norms = buyerNormalizedCategories(buyerCategories);
  if (norms.includes(lotCat)) return true;
  if (norms.some((c) => c !== "other" && categoryFamily(c) === categoryFamily(lotCat))) return true;
  return mandateAccepts.some((m) => {
    const n = normalizeCategory(m);
    return n === lotCat || (n !== "other" && categoryFamily(n) === categoryFamily(lotCat));
  });
}

export function hardDisqualifier(buyer: BuyerLike, lot: LotLike, mandateAccepts: string[] = []): string | null {
  if (buyer.disqualified_reason) return `Previously disqualified: ${buyer.disqualified_reason}`;
  if (buyer.verification_status === "mismatch_rejected") return "Entity mismatch";
  if (buyer.channel === "institutional" || /donation/i.test(buyer.channel)) return "Donation-only channel";
  if (buyer.channel === "gov-primes" && /footwear|apparel/i.test(lot.category)) return "Government channel incompatible";

  if (buyer.categories && !categoryFitsLot(buyer.categories, lot.category, mandateAccepts)) {
    return "Wrong category";
  }

  const dealValue = lotDealValueUsd(lot);
  if (buyer.txn_capacity_usd != null && dealValue > 0 && buyer.txn_capacity_usd < dealValue * 0.5) {
    return `Capacity too small (~$${buyer.txn_capacity_usd} vs deal $${dealValue})`;
  }
  return null;
}

export function matchBuyerLot(
  buyer: BuyerLike,
  lot: LotLike,
  opts: {
    mandates?: MandateLike[];
    stats?: CategoryStatLike[];
    suppressedDomains?: Set<string>;
  } = {},
): UnifiedMatch {
  const cat = normalizeCategory(lot.category);
  const liveMandates = (opts.mandates ?? []).filter((m) => m.buyer_id === buyer.id && m.superseded_by == null);
  const reject = liveMandates.find((m) => normalizeCategory(m.category) === cat && m.stance === "rejects");
  const accept = liveMandates.find((m) => normalizeCategory(m.category) === cat && m.stance === "accepts");
  const dq = hardDisqualifier(
    buyer,
    lot,
    liveMandates.filter((m) => m.stance === "accepts").map((m) => m.category),
  );
  const stat = (opts.stats ?? []).find((s) => s.buyer_id === buyer.id && s.category === cat);
  const suppressed = opts.suppressedDomains?.has(buyer.domain) ?? false;

  if (suppressed || reject || dq) {
    const reason = suppressed ? "suppressed domain" : reject ? "buyer rejected this category" : dq!;
    return {
      buyerId: buyer.id,
      score: 0,
      bucket: "doNotContact",
      capacityScore: 0,
      productFitScore: 0,
      geographyScore: 0,
      historyScore: 0,
      contactScore: 0,
      rationale: reason,
      hardDisqualified: reason,
    };
  }

  const dealValue = lotDealValueUsd(lot);
  let capacity = 0.5;
  if (buyer.txn_capacity_usd != null && dealValue > 0) {
    capacity = Math.max(0, Math.min(1, buyer.txn_capacity_usd / (dealValue * 2)));
  }

  const buyerCats = buyer.categories.toLowerCase();
  let product = 0.4;
  if (buyerCats.includes("footwear") && /footwear/i.test(lot.category)) product = 1;
  else if (accept) product = 0.95;
  else if (buyerCats.includes("closeout") || buyerCats.includes("licensed") || buyerCats.includes(cat.split("-")[0])) product = 0.7;

  const geography = buyer.geography === "both" ? 1 : buyer.geography === "domestic" ? 0.85 : buyer.geography === "export" ? 0.7 : 0.5;
  const contact = /verified|public_intake|clay/i.test(buyer.verification_status) ? 0.9 : /finder/i.test(buyer.verification_status) ? 0.6 : 0.3;

  let history = 0.3;
  let bucket: MatchBucket = "compatible";
  if (accept) {
    bucket = "explicit";
    history = 0.9;
  } else if (stat && (stat.replies > 0 || stat.offers > 0 || stat.closes > 0)) {
    bucket = "historical";
    const activity = stat.closes * 0.4 + stat.offers * 0.3 + stat.replies * 0.2;
    const penalty = stat.rejects * 0.25 + stat.ignores * 0.1;
    history = Math.max(0.2, Math.min(1, 0.5 + activity - penalty));
  }

  const conf = buyer.confidence ?? 0.5;
  const score = Number((0.3 * capacity + 0.3 * product + 0.15 * geography + 0.15 * contact + 0.1 * history * conf).toFixed(3));

  return {
    buyerId: buyer.id,
    score,
    bucket,
    capacityScore: Number(capacity.toFixed(3)),
    productFitScore: product,
    geographyScore: geography,
    historyScore: history,
    contactScore: contact,
    rationale: `${bucket} capacity=${capacity.toFixed(2)} product=${product.toFixed(2)} geo=${geography.toFixed(2)} contact=${contact.toFixed(2)} history=${history.toFixed(2)}`,
    hardDisqualified: null,
  };
}

export function rankBuyersForLot(
  lot: LotLike,
  buyers: BuyerLike[],
  ctx: { mandates?: MandateLike[]; stats?: CategoryStatLike[]; suppressedDomains?: Set<string> } = {},
): UnifiedMatch[] {
  return buyers
    .map((b) => matchBuyerLot(b, lot, ctx))
    .sort((a, b) => b.score - a.score);
}
