import { AUTHORIZED_SENDER } from "../email/address";
import { listSendableMediaFiles, selectSendableLots } from "../email/attachments";
import { audit, db, killSwitchOn, outboundMode } from "../db";
import { buyerLotFormBlocked } from "../ledger";
import { assertLiveForm } from "../outbound-gate";
import { enqueueGrokJob } from "../research";
import { isSuppressed } from "../suppression";
import { classifyFormHandle, interpretFormResult } from "./form";
import type { ChannelRouteState } from "./routes";
import type { ChannelResult, LotBrief, OpportunityContext, PreparedOutreach } from "./types";

export const SAEFAM_FORM_IDENTITY = {
  company: "Saefam Overstock",
  name: "Bailey Saevitzon",
  email: AUTHORIZED_SENDER,
  phone: "818-406-8612",
};

export type FormPacket = {
  live: boolean;
  submit: boolean;
  url: string;
  idempotencyKey: string;
  opportunityId?: number;
  conversationId: number;
  buyerId: number;
  company: string;
  domain: string;
  identity: typeof SAEFAM_FORM_IDENTITY;
  lots: Array<{ id: number; title: string; category: string; quantity: number | null; unit_price: number | null; brand: string | null }>;
  message: string;
  media: Array<{ path: string; filename: string; sha256: string }>;
};

function persistAttempt(input: {
  conversationId: number;
  buyerId: number;
  lotIds: number[];
  subject: string;
  body: string;
  mediaHashes: string[];
  status: "logged" | "dry_run" | "sent" | "blocked" | "failed";
  reason: string;
  idempotencyKey: string;
}): number {
  const existing = db().prepare("SELECT id, status FROM outreach_attempts WHERE idempotency_key=?").get(input.idempotencyKey) as
    | { id: number; status: string }
    | undefined;
  if (existing) {
    db().prepare(
      "UPDATE outreach_attempts SET status=?, reason=?, body=?, subject=?, media_hashes=?, lot_ids=? WHERE id=?"
    ).run(input.status, input.reason, input.body, input.subject, JSON.stringify(input.mediaHashes), JSON.stringify(input.lotIds), existing.id);
    return existing.id;
  }
  const info = db().prepare(
    `INSERT INTO outreach_attempts(conversation_id,buyer_id,channel,lot_ids,subject,body,media_hashes,status,reason,idempotency_key)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    input.conversationId,
    input.buyerId,
    "form",
    JSON.stringify(input.lotIds),
    input.subject,
    input.body,
    JSON.stringify(input.mediaHashes),
    input.status,
    input.reason,
    input.idempotencyKey,
  );
  return Number(info.lastInsertRowid);
}

export function buyerHasPendingFormJob(buyerId: number): boolean {
  const rows = db().prepare(
    "SELECT input FROM grok_jobs WHERE agent='FORM_OPERATOR' AND state IN ('queued','claimed')"
  ).all() as Array<{ input: string }>;
  return rows.some((r) => {
    try { return (JSON.parse(r.input) as { buyerId?: number }).buyerId === buyerId; } catch { return false; }
  });
}

function pendingFormJob(idempotencyKey: string): number | undefined {
  const rows = db().prepare(
    "SELECT id, input FROM grok_jobs WHERE agent='FORM_OPERATOR' AND state IN ('queued','claimed')"
  ).all() as Array<{ id: number; input: string }>;
  return rows.find((r) => {
    try { return (JSON.parse(r.input) as { idempotencyKey?: string }).idempotencyKey === idempotencyKey; } catch { return false; }
  })?.id;
}

export function buildFormPacket(ctx: OpportunityContext, prepared: PreparedOutreach): FormPacket {
  const media = ctx.lots.flatMap((l) => listSendableMediaFiles(l.id));
  return {
    live: outboundMode() === "live",
    submit: outboundMode() === "live",
    url: ctx.endpoint.handle,
    idempotencyKey: ctx.idempotencyKey,
    opportunityId: ctx.opportunityId,
    conversationId: ctx.conversationId,
    buyerId: ctx.buyerId,
    company: ctx.company,
    domain: ctx.domain,
    identity: SAEFAM_FORM_IDENTITY,
    lots: ctx.lots.map((l) => ({
      id: l.id, title: l.title, category: l.category, quantity: l.quantity, unit_price: l.unit_price, brand: l.brand,
    })),
    message: prepared.body,
    media,
  };
}

export function executeForm(ctx: OpportunityContext, prepared: PreparedOutreach): ChannelResult {
  const lotIds = ctx.lots.map((l) => l.id);
  const cls = classifyFormHandle(ctx.endpoint.handle);
  if (cls.kind === "portal") {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: [],
      status: "blocked", reason: cls.reason, idempotencyKey: ctx.idempotencyKey,
    });
    return { ok: false, status: "blocked", reason: cls.reason, attemptId: id };
  }
  if (cls.kind === "gated") {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: [],
      status: "logged", reason: cls.reason, idempotencyKey: ctx.idempotencyKey,
    });
    return { ok: true, status: "deferred", reason: cls.reason, attemptId: id };
  }
  if (killSwitchOn()) {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: [],
      status: "blocked", reason: "kill switch", idempotencyKey: ctx.idempotencyKey,
    });
    return { ok: false, status: "blocked", reason: "kill switch", attemptId: id };
  }
  if (isSuppressed(ctx.domain).suppressed) {
    return { ok: false, status: "blocked", reason: `suppressed (${ctx.domain})` };
  }
  const touch = buyerLotFormBlocked(ctx.buyerId, lotIds);
  if (touch.blocked) {
    return { ok: false, status: "blocked", reason: touch.reason };
  }

  const media = selectSendableLots(ctx.lots as LotBrief[]);
  if (!media.ok) {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: [],
      status: "blocked", reason: media.reason, idempotencyKey: ctx.idempotencyKey,
    });
    return { ok: false, status: "blocked", reason: media.reason, attemptId: id };
  }

  const existing = db().prepare("SELECT id, status, reason FROM outreach_attempts WHERE idempotency_key=?").get(ctx.idempotencyKey) as
    | { id: number; status: string; reason: string }
    | undefined;
  if (existing?.status === "sent") {
    return { ok: true, status: "duplicate", reason: "already sent", attemptId: existing.id };
  }
  if (existing?.status === "dry_run" && outboundMode() === "dry_run") {
    return { ok: true, status: "duplicate", reason: "already dry_run", attemptId: existing.id };
  }

  const packet = buildFormPacket(ctx, { ...prepared, mediaHashes: media.pick.hashes });

  if (outboundMode() !== "live") {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: media.pick.hashes,
      status: "dry_run", reason: "dry_run — form not submitted", idempotencyKey: ctx.idempotencyKey,
    });
    audit("form", "dry_run", { entityType: "outreach_attempts", entityId: id, detail: { url: packet.url } });
    return { ok: true, status: "dry_run", reason: "dry_run — form not submitted", attemptId: id };
  }

  const gate = assertLiveForm({ url: ctx.endpoint.handle, domain: ctx.domain, lotIds });
  if (!gate.ok) {
    const id = persistAttempt({
      conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
      subject: prepared.subject ?? "", body: prepared.body, mediaHashes: media.pick.hashes,
      status: "failed", reason: gate.reason, idempotencyKey: ctx.idempotencyKey,
    });
    return { ok: false, status: "deferred", reason: gate.reason, attemptId: id };
  }

  const pending = pendingFormJob(ctx.idempotencyKey);
  const id = persistAttempt({
    conversationId: ctx.conversationId, buyerId: ctx.buyerId, lotIds,
    subject: prepared.subject ?? "", body: prepared.body, mediaHashes: media.pick.hashes,
    status: "logged", reason: "form queued for GrokBot — not confirmed", idempotencyKey: ctx.idempotencyKey,
  });
  if (!pending) {
    enqueueGrokJob(
      "FORM_OPERATOR",
      "Open the public wholesale/contact form in the job. Fill only Saefam + lot facts. Attach original Oliver photos if the form accepts files. Submit only if live=true and there is no CAPTCHA/Turnstile/login/MFA. CAPTCHA, Turnstile, broken, or impossible required fields → needs_human and continue the queue. A click is not success — report confirmation text. Never bypass safeguards.",
      packet,
    );
  }
  audit("form", "queued_grok", { entityType: "outreach_attempts", entityId: id, detail: { url: packet.url } });
  return { ok: true, status: "deferred", reason: "form queued for GrokBot — not confirmed", attemptId: id };
}

export function applyFormResult(input: {
  idempotencyKey: string;
  submitted?: boolean;
  confirmationText?: string;
  confirmationUrl?: string;
  httpStatus?: number;
  error?: string;
  needsHuman?: boolean;
  blocker?: string;
  fieldsFilled?: Record<string, string>;
}): { state: ChannelRouteState; reason: string; attemptId?: number } {
  const attempt = db().prepare("SELECT id, buyer_id, conversation_id, lot_ids, subject, body, media_hashes FROM outreach_attempts WHERE idempotency_key=?").get(input.idempotencyKey) as
    | { id: number; buyer_id: number; conversation_id: number; lot_ids: string; subject: string; body: string; media_hashes: string }
    | undefined;
  if (!attempt) return { state: "failed", reason: "unknown form attempt" };

  let lotIds: number[] = [];
  try { lotIds = JSON.parse(attempt.lot_ids) as number[]; } catch { lotIds = []; }

  if (input.needsHuman || /captcha|turnstile|hcaptcha|login|mfa|2fa|cloudflare/i.test(input.blocker ?? input.error ?? "")) {
    const reason = input.blocker ?? input.error ?? "form requires human action";
    persistAttempt({
      conversationId: attempt.conversation_id, buyerId: attempt.buyer_id, lotIds,
      subject: attempt.subject, body: attempt.body, mediaHashes: JSON.parse(attempt.media_hashes || "[]"),
      status: "failed", reason, idempotencyKey: input.idempotencyKey,
    });
    db().prepare(
      "UPDATE channel_routes SET state='needs_human', blocker=?, updated_at=datetime('now') WHERE buyer_id=? AND channel='form'"
    ).run(reason, attempt.buyer_id);
    return { state: "needs_human", reason, attemptId: attempt.id };
  }

  const judged = interpretFormResult({
    submitted: input.submitted,
    confirmationText: input.confirmationText,
    confirmationUrl: input.confirmationUrl,
    httpStatus: input.httpStatus,
    error: input.error,
  });
  const status = judged.state === "confirmed" ? "sent" : judged.state === "failed" ? "failed" : "logged";
  persistAttempt({
    conversationId: attempt.conversation_id, buyerId: attempt.buyer_id, lotIds,
    subject: attempt.subject, body: attempt.body, mediaHashes: JSON.parse(attempt.media_hashes || "[]"),
    status, reason: judged.reason, idempotencyKey: input.idempotencyKey,
  });
  db().prepare(
    "UPDATE channel_routes SET state=?, blocker=?, updated_at=datetime('now') WHERE buyer_id=? AND channel='form'"
  ).run(judged.state, judged.state === "confirmed" ? null : judged.reason, attempt.buyer_id);
  if (judged.state === "confirmed") {
    db().prepare("UPDATE opportunities SET stage='executed', reason=?, updated_at=datetime('now') WHERE buyer_id=? AND stage IN ('deferred','prepared','channel_selected','dry_run')").run(judged.reason, attempt.buyer_id);
  }
  audit("form", `result_${judged.state}`, {
    entityType: "outreach_attempts",
    entityId: attempt.id,
    ok: judged.state === "confirmed",
    detail: { fields: input.fieldsFilled ?? {}, confirmationUrl: input.confirmationUrl },
  });
  return { state: judged.state, reason: judged.reason, attemptId: attempt.id };
}

export function applyFormJobResult(jobId: number, result: unknown): { state: ChannelRouteState; reason: string } {
  const job = db().prepare("SELECT input FROM grok_jobs WHERE id=?").get(jobId) as { input: string } | undefined;
  let packet: { idempotencyKey?: string } = {};
  try { packet = job ? JSON.parse(job.input) as { idempotencyKey?: string } : {}; } catch { packet = {}; }
  const raw = (result ?? {}) as {
    submitted?: boolean;
    confirmationText?: string;
    confirmation_text?: string;
    confirmationUrl?: string;
    confirmation_url?: string;
    httpStatus?: number;
    error?: string;
    status?: string;
    blocker?: string;
    blockers?: string[];
    fieldsFilled?: Record<string, string>;
    fields_filled?: Record<string, string>;
  };
  const needsHuman = raw.status === "needs_human" || (raw.status !== "confirmed" && Boolean(raw.blocker || raw.blockers?.length));
  if (!packet.idempotencyKey) return { state: "failed", reason: "form job missing idempotency key" };
  return applyFormResult({
    idempotencyKey: packet.idempotencyKey,
    submitted: raw.submitted ?? (raw.status === "confirmed" || raw.status === "submitted"),
    confirmationText: raw.confirmationText ?? raw.confirmation_text,
    confirmationUrl: raw.confirmationUrl ?? raw.confirmation_url,
    httpStatus: raw.httpStatus,
    error: raw.error,
    needsHuman,
    blocker: raw.blocker ?? raw.blockers?.[0],
    fieldsFilled: raw.fieldsFilled ?? raw.fields_filled,
  });
}
