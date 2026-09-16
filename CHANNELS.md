# Multi-channel acquisition

BMSMONEYNIGGA is the active system. Oliver Deal OS is a read-only data source, not the runtime.

Email is live via Gmail. Public wholesale/contact forms are live via GrokBot/browser (confirmed only with thank-you/ticket evidence). LinkedIn is last-resort `needs_human`. Instagram, marketplaces, and vendor portals are research or rejected. Default outbound mode is `dry_run`.

```
BUYER UNIVERSE → QUALIFY → MATCH → OPPORTUNITY ENGINE
        email | form | instagram | linkedin | marketplace | application
                         → CONVERSATION → HUMAN / OLIVER
```

Pipeline stages (not “discover → send email”):

`discovered → qualified → channel_selected → prepared → dry_run → executed → response_captured → handed_off`

Blocked or deferred are terminal-until-retry.

## Operator contract (every channel)

Conceptual interface — channel-specific behavior stays behind the adapter. Matching, suppression, buyer/lot/conversation state, and audit stay in core code.

| Method | Meaning | Email today | Deferred channels today |
|---|---|---|---|
| `discover` | find legitimate endpoints | contacts + `recordEndpoint` | researcher may record; operator does not scrape live |
| `qualify` | endpoint is real + permitted | suppression + ledger | same core gates |
| `prepare` | compose 1–3 lots + Oliver media hashes | `compose` | draft packet only |
| `dryRun` | persist attempt, do not send | `guardedOutreach` dry_run | `deferred` attempt row |
| `execute` | live send | only if `OUTBOUND_MODE=live` + Gmail | **forbidden** until phase enable |
| `captureResponse` | inbound → classify | `processInbound` | future |
| `handoff` | hot → Oliver packet | `createEscalation` | same core |

TypeScript: `lib/channels/types.ts` `ChannelOperator` (`compose`, `execute`, `liveExecution`). Registry: `lib/channels/registry.ts`. Select: `lib/channels/select.ts`. Dispatch: `lib/opportunity.ts`.

No channel adapter may modify: `lib/matcher.ts`, `lib/suppression.ts`, lot/buyer/conversation writes, or `audit()`.

## How a channel is chosen

`selectChannel(buyerId)` scores **real** endpoints only:

- Verified email beats a form.
- A wholesale form beats social if there is no useful email.
- Instagram / portals never win as a sales path.
- LinkedIn only as last-resort human assist when a named person exists and email/form do not.
- Named purchasing inbox beats generic `info@`.
- Address bounce is not buyer+lot one-touch — form may run once.
- **Never invent `purchasing@domain`.** A guessed inbox is not a channel.

## Adding a channel later

1. Implement `ChannelOperator` in `lib/channels/`.
2. `registerOperator(op)` in `lib/channels/registry.ts`.
3. Record endpoints with `recordEndpoint`.
4. Do not edit matcher, suppression, conversations, or deal/escalation code.

Live operators must enforce platform rules, rate limits, auth, opt-out, dry-run, audit, and human approval where required. Do not bypass anti-automation.

## Phase plan

See `grok/GROK_PHASE_PLAN.md`. Short:

- **Phase 1:** WhatsApp → match → opportunity → email dry-run
- **Phase 2:** buyer/contact research + website forms (prepare only until enabled)
- **Phase 3:** LinkedIn / Instagram / marketplace (official or human-approved)
- **Phase 4:** channel performance learning
- **Phase 5:** mature multi-channel engine
