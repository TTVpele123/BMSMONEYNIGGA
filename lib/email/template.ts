import { AUTHORIZED_SENDER } from "./address";
import type { MimeAttachment } from "./mime";

export type LotBrief = {
  id: number;
  title: string;
  category: string;
  quantity: number | null;
  unit_price: number | null;
  brand: string | null;
  raw_text?: string | null;
};

const FALLBACK_TITLE = "Available Inventory";

/** Internal taxonomy slugs → buyer-facing labels (never shown as raw slugs). */
const CATEGORY_LABEL: Record<string, string> = {
  "apparel-basic": "Apparel",
  "apparel-licensed": "Licensed Apparel",
  "apparel-kids": "Kids Apparel",
  "footwear-athletic": "Athletic Footwear",
  "footwear-other": "Footwear",
  headwear: "Headwear",
  accessories: "Accessories",
  socks: "Socks",
  "home-soft": "Home Soft Goods",
  "home-hard": "Home Goods",
  toys: "Toys",
  crafts: "Crafts",
  "general-merchandise": "General Merchandise",
};

const MEANINGLESS = /^(other|unknown|n\/?a|none|null|undefined|tbd|n\.a\.?|-|—)$/i;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** True for internal provenance, DB keys, lot IDs, source labels, quantity-only stubs. */
export function isInternalOrEmptyTitle(raw: string): boolean {
  const s = clean(raw);
  if (!s) return true;
  if (MEANINGLESS.test(s)) return true;
  if (/^oliver(\s+lot)?$/i.test(s)) return true;
  if (/\boliver\s+lot\b/i.test(s)) return true;
  if (/^(wa:|lot:|id:)/i.test(s)) return true;
  if (/^LOT-\d/i.test(s)) return true;
  if (/^ON-LOT-/i.test(s)) return true;
  if (/\bLOT-\d{4}-\d{2}\d{2}-/i.test(s)) return true;
  if (/^SENSATIONAL-/i.test(s)) return true; // inventory SKU-style keys
  // Quantity / logistics lines with no product noun
  if (/^\d[\d,]*(?:\s*(?:pcs|pieces|units|pairs|ea|each))?\b/i.test(s) && !hasProductNoun(s)) return true;
  if (/each (color|style|size)\b/i.test(s) && !hasProductNoun(s)) return true;
  return false;
}

function hasProductNoun(s: string): boolean {
  return /\b(hoodie|hoodies|fleece|tee|tees|t-?shirt|shirt|shirts|pant|pants|jean|jeans|short|shorts|sock|socks|shoe|shoes|sneaker|sneakers|boot|boots|hat|hats|cap|caps|beanie|headwear|apparel|garment|jacket|jackets|coat|coats|cardigan|cardigans|sweater|sweaters|knit|dress|dresses|top|tops|bottom|bottoms|legging|leggings|bra|underwear|pajama|pajamas|sandal|sandals|slipper|slippers|glove|gloves|scarf|scarves|belt|belts|bag|bags|tote|toys?|plush|mug|mugs|towel|towels|blanket|blankets|plate|plates|licensed)\b/i.test(
    s,
  );
}

function humanCategoryLabel(category: string | null | undefined): string | null {
  const raw = clean(category);
  if (!raw || MEANINGLESS.test(raw)) return null;
  const slug = raw.toLowerCase();
  if (CATEGORY_LABEL[slug]) return CATEGORY_LABEL[slug];
  // Hyphenated internal taxonomy → hide (do not show "apparel-basic" to buyers)
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(raw)) return null;
  // Already human-readable phrase
  if (/^[A-Za-z][A-Za-z0-9 /&'-]{1,60}$/.test(raw) && !MEANINGLESS.test(raw)) return raw;
  return null;
}

function firstMeaningfulLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const s = clean(line);
    if (!s) continue;
    if (isInternalOrEmptyTitle(s)) continue;
    return s.slice(0, 80);
  }
  return null;
}

/**
 * Concise buyer-facing product title from supplier facts.
 * Never returns Oliver lot, lot IDs, source names, or other internal placeholders.
 */
export function buyerFacingTitle(lot: LotBrief): string {
  const candidates: string[] = [];
  const title = clean(lot.title);
  if (title) candidates.push(title);
  const fromRaw = firstMeaningfulLine(lot.raw_text);
  if (fromRaw) candidates.push(fromRaw);
  // Brand + human category, when both known
  const brand = clean(lot.brand);
  const catLabel = humanCategoryLabel(lot.category);
  if (brand && !MEANINGLESS.test(brand) && catLabel) candidates.push(`${brand} ${catLabel}`);
  if (catLabel) candidates.push(catLabel);
  if (brand && !MEANINGLESS.test(brand) && hasProductNoun(brand) === false) {
    // brand alone is weak as a product title unless it includes a product noun
  }

  for (const c of candidates) {
    if (!isInternalOrEmptyTitle(c)) return c.slice(0, 80);
  }
  return FALLBACK_TITLE;
}

function isDisplayableFactValue(value: string): boolean {
  const s = clean(value);
  if (!s) return false;
  if (MEANINGLESS.test(s)) return false;
  if (/^oliver(\s+lot)?$/i.test(s) || /\boliver\s+lot\b/i.test(s)) return false;
  return true;
}

/** Supplier-confirmed facts only — skips internal/meaningless values. */
function knownFacts(lot: LotBrief): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  const title = buyerFacingTitle(lot);
  // Product row only when we have a real derived title (header already shows it; keep for plain text)
  if (title !== FALLBACK_TITLE) facts.push({ label: "Product", value: title });

  const brand = clean(lot.brand);
  if (brand && isDisplayableFactValue(brand)) facts.push({ label: "Brand", value: brand });

  // Never show Category: other / unknown / taxonomy slugs — only a clear human label, and
  // only when it adds information beyond the product title.
  const catLabel = humanCategoryLabel(lot.category);
  if (catLabel && catLabel.toLowerCase() !== title.toLowerCase()) {
    facts.push({ label: "Category", value: catLabel });
  }

  if (lot.quantity != null && Number.isFinite(lot.quantity) && lot.quantity > 0) {
    facts.push({ label: "Quantity", value: `${lot.quantity.toLocaleString()} units` });
  }
  if (lot.unit_price != null && Number.isFinite(lot.unit_price) && lot.unit_price > 0) {
    facts.push({ label: "Asking price", value: `$${lot.unit_price}/unit` });
  }
  return facts;
}

/** Plain-text fallback — supplier facts only, never invented fields. */
export function composePlain(input: { company: string; lots: LotBrief[] }): { subject: string; body: string } {
  const titles = input.lots.map((l) => buyerFacingTitle(l)).join(" / ");
  const subject = `Wholesale availability — ${titles}`.slice(0, 140);
  const blocks = input.lots.map((lot) => {
    const heading = buyerFacingTitle(lot);
    const facts = knownFacts(lot);
    const lines = [`${heading}`, ...facts.map((f) => `${f.label}: ${f.value}`)];
    return lines.join("\n");
  });
  const body = [
    `Hi ${input.company} team,`,
    "",
    "Sharing a current closeout opportunity that looks like a fit for what you buy.",
    "",
    ...blocks.flatMap((b, i) => (i === 0 ? [b] : ["", b])),
    "",
    "Photos below/attached are the supplier's original lot photos — not stock imagery.",
    "",
    "If relevant, reply with quantity interest and any constraints (sizes, price, timing). If not a fit, a one-line pass is enough.",
    "",
    "Bailey Saevitzon",
    "Saefam Overstock",
    "818-406-8612",
    AUTHORIZED_SENDER,
  ].join("\n");
  return { subject, body };
}

/**
 * Rich wholesale HTML with CID-inline original supplier photos.
 * Only includes facts present on the lot rows — never invents location/MOQ/condition.
 */
export function composeRichHtml(input: {
  company: string;
  lots: LotBrief[];
  attachments: MimeAttachment[];
}): { subject: string; text: string; html: string } {
  const plain = composePlain(input);
  const hero = input.attachments[0];
  const gallery = input.attachments.slice(1);

  const lotSections = input.lots.map((lot) => {
    const heading = buyerFacingTitle(lot);
    // In HTML, heading is the title — omit duplicate Product row
    const facts = knownFacts(lot).filter((f) => f.label !== "Product");
    const rows = facts
      .map(
        (f) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#667085;font-size:13px;width:120px;vertical-align:top;">${esc(f.label)}</td>` +
          `<td style="padding:6px 0;color:#101828;font-size:14px;font-weight:600;">${esc(f.value)}</td></tr>`,
      )
      .join("");
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 16px 0;">
        <tr><td style="font-size:16px;font-weight:700;color:#101828;padding:0 0 8px 0;">${esc(heading)}</td></tr>
        <tr><td>
          <table role="presentation" cellspacing="0" cellpadding="0">${rows || `<tr><td style="color:#667085;font-size:13px;">Details on request</td></tr>`}</table>
        </td></tr>
      </table>`;
  }).join("");

  const galleryHtml = gallery.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 20px 0;">
        <tr>${gallery
          .slice(0, 6)
          .map(
            (a) =>
              `<td style="padding:4px;width:33%;vertical-align:top;">
                <img src="cid:${a.contentId}" alt="Supplier product photo" width="180" style="display:block;width:100%;max-width:180px;height:auto;border-radius:8px;border:1px solid #eaecf0;" />
              </td>`,
          )
          .join("")}</tr>
      </table>`
    : "";

  const heroHtml = hero
    ? `<img src="cid:${hero.contentId}" alt="Supplier product photo" width="560" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;border:1px solid #eaecf0;" />`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(plain.subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eaecf0;">
        <tr><td style="background:#0b1f33;padding:20px 24px;">
          <div style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#98a2b3;">Saefam Overstock</div>
          <div style="font-size:20px;font-weight:700;color:#ffffff;margin-top:4px;">Wholesale opportunity</div>
        </td></tr>
        <tr><td style="padding:0;">${heroHtml}</td></tr>
        <tr><td style="padding:24px;">
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;">Hi ${esc(input.company)} team,</p>
          <p style="margin:0 0 18px 0;font-size:15px;line-height:1.5;color:#344054;">Sharing a current closeout that looks like a fit for what you buy. Facts below are supplier-confirmed only.</p>
          ${lotSections}
          ${galleryHtml}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 20px 0;">
            <tr><td style="background:#f9fafb;border:1px solid #eaecf0;border-radius:12px;padding:14px 16px;">
              <div style="font-size:14px;font-weight:700;color:#101828;margin-bottom:4px;">Next step</div>
              <div style="font-size:14px;line-height:1.5;color:#344054;">If this is relevant, reply with quantity interest and any constraints (sizes, price, timing). If not a fit, a one-line pass is enough and we will not follow up on this lot.</div>
            </td></tr>
          </table>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#101828;">
            <strong>Bailey Saevitzon</strong><br/>
            Saefam Overstock<br/>
            818-406-8612<br/>
            <a href="mailto:${AUTHORIZED_SENDER}" style="color:#175cd3;text-decoration:none;">${AUTHORIZED_SENDER}</a>
          </p>
          <p style="margin:16px 0 0 0;font-size:11px;line-height:1.4;color:#98a2b3;">Photos are original supplier lot photos — not stock imagery, screenshots, or web images.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: plain.subject, text: plain.body, html };
}
