import { LIVE_DAILY_CAP, LIVE_DOMAIN_CAP, liveSentToday, liveSentToDomainToday } from "./caps";
import { killSwitchOn, outboundMode, db } from "./db";
import { parseRecipient } from "./email/address";
import { lotHasSendableMedia } from "./email/attachments";
import { isSuppressed } from "./suppression";

export type OutboundGateInput = {
  to: string;
  domain?: string;
  lotIds?: number[];
};

/** Final check immediately before any provider send. Fail closed. */
export function assertLiveOutbound(input: OutboundGateInput): { ok: true } | { ok: false; reason: string } {
  if (outboundMode() !== "live") return { ok: false, reason: "outbound_mode is not live" };
  if (killSwitchOn()) return { ok: false, reason: "outbound paused/held" };

  const to = parseRecipient(input.to);
  if (!to.ok) return { ok: false, reason: to.reason };
  const suppressedTo = isSuppressed(to.email);
  if (suppressedTo.suppressed) return { ok: false, reason: `suppressed (${suppressedTo.matched})` };

  const domain = (input.domain ?? to.email.split("@")[1] ?? "").toLowerCase();
  if (domain) {
    const suppressedDomain = isSuppressed(domain);
    if (suppressedDomain.suppressed) return { ok: false, reason: `suppressed (${suppressedDomain.matched})` };
  }

  const lotIds = input.lotIds ?? [];
  if (!lotIds.length) return { ok: false, reason: "lot lacks eligible original Oliver product media" };
  for (const lotId of lotIds) {
    const lot = db().prepare("SELECT project_gate, state FROM lots WHERE id=?").get(lotId) as
      | { project_gate: string; state: string }
      | undefined;
    if (!lot) return { ok: false, reason: "lot lacks eligible original Oliver product media" };
    if (lot.project_gate === "DO_NOT_MARKET" || lot.project_gate === "ARCHIVED") {
      return { ok: false, reason: "lot is DO_NOT_MARKET" };
    }
    if (lot.state === "paused" || lot.state === "sold" || lot.state === "archived") {
      return { ok: false, reason: "lot is DO_NOT_MARKET" };
    }
    if (!lotHasSendableMedia(lotId)) return { ok: false, reason: "lot lacks eligible original Oliver product media" };
  }

  if (liveSentToday() >= LIVE_DAILY_CAP) return { ok: false, reason: `daily cap ${LIVE_DAILY_CAP}` };
  if (domain && liveSentToDomainToday(domain) >= LIVE_DOMAIN_CAP) return { ok: false, reason: `domain cap ${LIVE_DOMAIN_CAP}` };
  return { ok: true };
}
