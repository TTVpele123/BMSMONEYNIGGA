import type { BuyerLike } from "./matcher";

export type Channel = "email" | "form" | "linkedin" | "instagram" | "phone" | "manual";

export function routeBuyer(buyer: BuyerLike & { outreach_channel?: string; contact_email?: string | null }): Channel {
  if (buyer.outreach_channel && buyer.outreach_channel !== "unknown") {
    return buyer.outreach_channel as Channel;
  }
  if (buyer.contact_email) return "email";
  if (/form|intake/i.test(buyer.channel)) return "form";
  if (/linkedin/i.test(buyer.channel)) return "linkedin";
  if (/instagram/i.test(buyer.channel)) return "instagram";
  if (/phone|call/i.test(buyer.channel)) return "phone";
  return "email";
}
