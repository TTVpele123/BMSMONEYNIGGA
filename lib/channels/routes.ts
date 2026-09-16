import { db } from "../db";
import { formRouteSetup } from "./form";
import type { ChannelId } from "./types";

export type ChannelRouteState =
  | "discovered"
  | "qualified"
  | "ready"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "deferred"
  | "needs_human"
  | "suppressed";

export type ChannelRoute = {
  buyerId: number;
  opportunityId?: number;
  lotIds: number[];
  channel: ChannelId;
  handle: string;
  state: ChannelRouteState;
  blocker?: string;
  evidence?: string;
  preparedSubject?: string;
  preparedBody?: string;
  mediaHashes?: string[];
  idempotencyKey: string;
};

/** Non-email routes never auto-execute. Auth/CAPTCHA/social → stop that route only. */
export function routeSetup(channel: ChannelId, handle: string): { state: ChannelRouteState; blocker: string | null } {
  if (channel === "linkedin") {
    return { state: "needs_human", blocker: "LinkedIn messaging is human-assisted last resort. Persist the profile; do not auto-DM." };
  }
  if (channel === "instagram") {
    return { state: "suppressed", blocker: "Instagram is research-only — no outreach." };
  }
  if (channel === "form") return formRouteSetup(handle);
  if (channel === "marketplace" || channel === "application") {
    return { state: "suppressed", blocker: "Marketplace/vendor portals are rejected for this inventory motion." };
  }
  if (channel === "phone") {
    return { state: "discovered", blocker: "Published phone is not auto-dialed. Inbound buyer phones escalate to Oliver." };
  }
  if (channel === "email") return { state: "ready", blocker: null };
  return { state: "deferred", blocker: "non-email adapter is not live" };
}

export function upsertRoute(input: ChannelRoute): number {
  const info = db().prepare(
    `INSERT INTO channel_routes(
        buyer_id, opportunity_id, lot_ids, channel, handle, state, blocker, evidence,
        prepared_subject, prepared_body, media_hashes, idempotency_key
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        state=excluded.state,
        blocker=excluded.blocker,
        evidence=COALESCE(excluded.evidence, channel_routes.evidence),
        prepared_subject=COALESCE(excluded.prepared_subject, channel_routes.prepared_subject),
        prepared_body=COALESCE(excluded.prepared_body, channel_routes.prepared_body),
        media_hashes=excluded.media_hashes,
        updated_at=datetime('now')`
  ).run(
    input.buyerId,
    input.opportunityId ?? null,
    JSON.stringify(input.lotIds),
    input.channel,
    input.handle,
    input.state,
    input.blocker ?? null,
    input.evidence ?? null,
    input.preparedSubject ?? null,
    input.preparedBody ?? null,
    JSON.stringify(input.mediaHashes ?? []),
    input.idempotencyKey,
  );
  const row = db().prepare("SELECT id FROM channel_routes WHERE idempotency_key=?").get(input.idempotencyKey) as { id: number };
  return row?.id ?? Number(info.lastInsertRowid);
}

export function resultToRouteState(status: string, reason?: string): ChannelRouteState {
  if (status === "sent") return "confirmed";
  if (status === "dry_run") return "ready";
  if (status === "deferred" && /queued for GrokBot/i.test(reason ?? "")) return "executing";
  if (status === "deferred" && /login|captcha|mfa|2fa|cloudflare/i.test(reason ?? "")) return "needs_human";
  if (status === "deferred") return "deferred";
  if (status === "failed") return "failed";
  if (status === "duplicate") return /already sent/i.test(reason ?? "") ? "confirmed" : "ready";
  if (status === "blocked") {
    if (/suppress|one-touch|kill switch|opted|bounc/i.test(reason ?? "")) return "suppressed";
    return "failed";
  }
  return "discovered";
}
