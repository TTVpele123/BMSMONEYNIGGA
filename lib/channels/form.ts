const GATED_RE = /login|signin|sign-in|sign_in|auth|captcha|recaptcha|cloudflare|mfa|2fa|account\/create|register/i;
const PORTAL_RE = /vendor[-_ ]?portal|supplier[-_ ]?portal|sellercentral|partner[-_ ]?net|retail[-_ ]?link/i;
const CONFIRM_RE = /thank you|thanks[!.,]|thanks for|we (have )?received|we.ll review your|submission (received|complete)|successfully (sent|submitted)|(?:message|form) (?:has been |was )?sent|ticket\s*#?\s*\w+|reference\s*(id|#)|dziękujemy|wiadomość została wysłana|bedankt voor|het is verzonden|inzending is gelukt/i;

export type FormClass = "public" | "gated" | "portal";

/** Public no-auth forms are the only ones we will ever auto-submit. Never bypass gates. */
export function classifyFormHandle(handle: string): { kind: FormClass; reason: string } {
  const url = handle.trim();
  if (!url) return { kind: "gated", reason: "missing form URL" };
  if (PORTAL_RE.test(url)) return { kind: "portal", reason: "vendor/retailer portal — rejected for this inventory motion" };
  if (GATED_RE.test(url)) return { kind: "gated", reason: "form requires login, CAPTCHA, or MFA" };
  return { kind: "public", reason: "public wholesale/contact form" };
}

export function formRouteSetup(handle: string): { state: "suppressed" | "needs_human" | "deferred" | "ready"; blocker: string | null } {
  const cls = classifyFormHandle(handle);
  if (cls.kind === "portal") {
    return { state: "suppressed", blocker: cls.reason };
  }
  if (cls.kind === "gated") {
    return { state: "needs_human", blocker: `${cls.reason}. Complete it once in the GrokBot browser if this buyer is high-fit, then retry this route only.` };
  }
  return { state: "ready", blocker: null };
}

/**
 * A click is never success. Confirmed only with explicit confirmation evidence.
 * Used by a future live adapter and by Grok form reports today.
 */
export function interpretFormResult(input: {
  submitted?: boolean;
  confirmationText?: string;
  confirmationUrl?: string;
  httpStatus?: number;
  error?: string;
}): { state: "confirmed" | "failed" | "deferred"; reason: string } {
  if (input.error) return { state: "failed", reason: input.error };
  if (input.httpStatus != null && input.httpStatus >= 400) {
    return { state: "failed", reason: `form HTTP ${input.httpStatus}` };
  }
  const evidence = `${input.confirmationText ?? ""} ${input.confirmationUrl ?? ""}`;
  if (input.submitted && CONFIRM_RE.test(evidence)) {
    return { state: "confirmed", reason: "form confirmation recorded" };
  }
  if (input.submitted) {
    return { state: "failed", reason: "submit claimed without confirmation evidence" };
  }
  return { state: "deferred", reason: "form not submitted" };
}
