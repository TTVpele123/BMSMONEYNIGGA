# GrokBot operator architecture (not a mega-agent)

BMSMONEYNIGGA is the runtime. Deal OS is not.

**Code owns:** filtering, dedupe, suppression, routing, state, retries, metrics, email dry-run/send choke, inbound classify.  
**Grok owns:** WhatsApp Web, public-web research, messy extraction, channel ranking, human-language drafts.

North-star (`GET /api/metrics`): qualified conversations / deals **per Oliver lot**. Not emails, scrapes, or contacts.

## Roster

| Agent | Create in GrokBot? | Phase | Priority |
|---|---|---|---|
| **WHATSAPP_SCANNER** | **Yes — first** | 1 | P0 |
| Matcher / opportunity / email operator | Never Grok | 1 | P1 / P3 |
| **BUYER_RESEARCHER** | After scanner works, if quota remains | 1 | P2 |
| **OPPORTUNITY_RESEARCHER** | After matching, if quota remains | 1 | P2 |
| **INBOUND_ANALYST** | Only if a real ambiguous reply | 1 | P4 |
| Learning (`buyer_category_stats`) | Never Grok | 1 | P5 |
| FORM_OPERATOR | Dormant prompt only | 2 | P3 deferred |
| INSTAGRAM_OPERATOR | Dormant | 3 | P6 until enabled |
| LINKEDIN_OPERATOR | Dormant | 3 | P6 |
| MARKETPLACE_OPERATOR | Dormant | 3 | P6 |

Do **not** create `SOCIAL_OPERATOR` or a do-everything agent.

## Handoffs

```
WHATSAPP_SCANNER --POST /api/ingest/whatsapp--> lot_intake --> matcher --> opportunity --> email dry_run | defer
BUYER_RESEARCHER --POST /api/research/findings--> buyers + endpoints + mandates
OPPORTUNITY_RESEARCHER --POST /api/research/findings--> ranked endpoints
INBOUND_ANALYST --> Bailey (propose 1 reply or Oliver handoff); code still owns suppressions
FORM/IG/LI/MARKETPLACE --> POST /api/grok/jobs result status=deferred only
```

Agents never call each other. They persist through the engine.

## Priority queue

- **P0** Oliver ingest  
- **P1** high-confidence match (code)  
- **P2** buyer/contact/channel research (Grok, capped)  
- **P3** outreach prepare (email dry-run in code; others deferred)  
- **P4** inbound (code first)  
- **P5** learning (code)  
- **P6** low-confidence discovery  

Favor work that can become a sale soon.

## Grok usage

- Snapshot-first (`GET /api/ops/snapshot`) before browsing  
- One scanner POST, then stop  
- Researchers: max 5 buyers or 5 pairs  
- Never re-scan known WhatsApp ids  
- Never re-research a domain the same session  
- Never spend tokens on matching, suppression, or sending  

## Per-agent contracts

### WHATSAPP_SCANNER
- **Purpose:** Oliver chat → structured lot + original photos  
- **Trigger:** Manual / later hourly Automation  
- **Inputs:** WhatsApp Oliver thread; optional `since`  
- **Outputs:** POST `/api/ingest/whatsapp`; report lotsTouched  
- **APIs:** `GET /api/health`, `GET /api/ops/snapshot`, `POST /api/ingest/whatsapp`  
- **Permissions:** Browser WhatsApp Web; localhost HTTP. No Gmail.  
- **Never fabricate:** qty, price, brand, sizes, licensing, message ids, stock photos  
- **Stop:** successful POST, login wall, engine down  
- **Escalate:** cannot unlock WhatsApp; cannot get message ids  
- **Handoff:** engine intake → matcher (not this agent)  
- **Dedupe:** skip snapshot `recent_whatsapp` ids  
- **Success:** new lot + originals, no screenshots  
- **Failure:** screenshots as media; invented facts; no POST  
- **Evidence:** message id, verbatim text, file sha256/path  

### BUYER_RESEARCHER
- **Purpose:** evidenced buyers + real endpoints for a lot  
- **Trigger:** after a lot exists; or grok job `BUYER_RESEARCHER`  
- **Inputs:** lot from snapshot / Bailey  
- **Outputs:** POST `/api/research/findings`  
- **APIs:** health, snapshot, metrics, findings, grok jobs  
- **Never fabricate:** emails (`purchasing@` without mailto), mandates without quote  
- **Stop:** 5 buyers or no evidence  
- **Escalate:** paywall; social-only (record, don’t DM)  
- **Handoff:** findings → `selectChannel` / matcher  
- **Dedupe:** skip domains that already have an endpoint  
- **Success:** ≤5 evidenced buyers  
- **Failure:** guessed inboxes; enroll with no buy evidence  
- **Evidence:** url + quote per mandate/endpoint  

### OPPORTUNITY_RESEARCHER
- **Purpose:** best real path to a sale for buyer×lot  
- **Trigger:** after opportunities exist  
- **Inputs:** snapshot opportunities  
- **Outputs:** ranking + optional findings POST  
- **Never fabricate:** endpoints; “email always wins”  
- **Stop:** 5 pairs  
- **Handoff:** recommended_action to Bailey/code tick — not execute  
- **Success:** ranked channels with executable vs deferred  
- **Evidence:** on-page contact + purchasing quotes  

### INBOUND_ANALYST
- **Purpose:** classify ambiguous replies; capture phone; Oliver handoff  
- **Trigger:** Bailey pastes a reply (do not create day 1)  
- **Never fabricate:** lot facts, phone numbers  
- **Stop:** phone / unsub / bounce / one proposed reply  
- **Handoff:** Oliver packet if hot  

### FORM / INSTAGRAM / LINKEDIN / MARKETPLACE
- **Purpose:** prepare packets only  
- **Trigger:** Phase 2/3 jobs — **do not create tomorrow**  
- **Never:** live submit/DM/InMail; CAPTCHA/login bypass  
- **Success:** `{ status: "deferred", live: false }`  
- **Handoff:** job result only; core state unchanged  

## Learning

Code increments `buyer_category_stats` (sends/replies/offers/closes/ignores/rejects). Future `selectChannel` / match history uses that. Grok does not tune weights.
