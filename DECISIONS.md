# Engineering decisions (2026-09-11)

Made so implementation does not block on questions.

1. **Brand-new local repo.** BMSMONEYNIGGA is not a migration of Oliver Deal OS git history. No remote is required. Deal OS is a read-only data/logic source.
2. **No GitHub/Cursor remote** until you ask. `move_agent_to_root` failed because it fetches `origin`; this repo has none by design.
3. **Runtime data lives in `~/.bmsmoneynigga/`** — not Desktop, not `~/.buzz`. Avoids macOS TCC and Deal OS collisions.
4. **HTTP port 3222** so Deal OS can stay on 3111.
5. **SQLite + TypeScript + Next.js API + thin ops UI.** Gmail OAuth needs a local HTTP app; do not rewrite the stack.
6. **Default `OUTBOUND_MODE=dry_run`.** Live send is an explicit env flip behind the same choke point.
7. **Campaign `outbound_authorized_at` dropped** as a Bailey-approval gate for routine first-touch. Kill switch, suppression, ledger, claims, media hashes, and caps stay.
8. **One matcher.** `scoreMatch` + `matchProduct` unified. Hard DQ and do-not-contact run first.
9. **Opt-out suppresses domain** (except consumer mail hosts). Bounce suppresses one address only.
10. **WhatsApp chat screenshots are never outreach media.** Only original Oliver product/warehouse photos with lot + message provenance.
11. **Grok Bot is for browser UI only** (WhatsApp Web, forms, LinkedIn/Instagram). Deterministic code owns orchestration, state, and safety. xAI API (if present) may do extraction/copy; it does not refill Cursor Grok quota.
12. **Clay spend stays $0.**
13. **Do not auto-message Oliver.** Handoffs are packets for humans.
14. **Authorized sender is `saevitzonoverstock@gmail.com`.** (Updated 2026-09-14 — pivoted off saefamoverstock after Gmail send-limit.) Sign as Bailey Saevitzon / Saefam Overstock / 818-406-8612. Do not use personal or Berkeley mailboxes. `saefamoverstock@gmail.com` is legacy inbound/read-only only — never send from it. Both inboxes feed the same inbound pipeline.
15. **Email is the only live outbound channel.** Public wholesale/contact forms are the only additional outbound channel we will build (prepare now, submit later). LinkedIn is research + rare human assist. Instagram, vendor portals, marketplace chat, WhatsApp-to-buyers, and autodial are rejected.
16. **Never invent a contact.** `purchasing@domain` is not a channel. Route only on stored endpoints.
17. **No anti-automation circumvention.** CAPTCHA/login/MFA stops that route only.
18. **Approved stack (2026-09-13):** named email first; bounce → one form fallback; buyer+lot one-touch except address bounce; Grok researches in live or dry_run (never sends).
19. **Overnight clock (2026-09-14):** launchd `com.bmsmoneynigga.autonomy` POSTs `/api/jobs/tick` every 5 minutes and restarts :3222 if health is down. That HTTP cycle is the only clock (research, rematch, send, Gmail sync). No in-process `setInterval`. Email is the only autonomous execute path; forms wait for GrokBot and must not spin the matcher.
