# GrokBot deployment checklist (copy/paste)

**Do not run any of this until GrokBot usage resets.** Do not create form/social agents on day 1. Do not create a mega-agent.

Engine: `http://localhost:3222` · Repo: `~/Projects/BMSMONEYNIGGA` · Mode must stay `dry_run` until you explicitly flip it.

---

## 1. WHATSAPP_SCANNER — CREATE

| | |
|---|---|
| **Create?** | **YES — first and only required agent** |
| **Prompt file** | `grok/WHATSAPP_SCANNER.md` (paste entire file) |
| **Trigger** | Manual first run. Later: hourly Cursor Automation (`0 * * * *`) + browser |
| **Permissions** | Browser (WhatsApp Web). HTTP to localhost:3222. No Gmail. No send. |
| **First action** | `GET http://localhost:3222/api/health` then scan Oliver chat |
| **Expected output** | POST `/api/ingest/whatsapp` → `{ ok, ingested.lotsTouched }` |
| **Verify** | Dashboard lots + photos; `GET /api/ops/snapshot` `recent_whatsapp`; media class is **not** `screenshot_chat_capture` |
| **Do NOT** | Outreach, Gmail, other chats, stock photos, screenshots, invent qty/price |

---

## 2. BUYER_RESEARCHER — CREATE ONLY AFTER SCANNER WORKS

| | |
|---|---|
| **Create?** | Yes if quota remains **and** a lot exists |
| **Prompt file** | `grok/agents/BUYER_RESEARCHER.md` |
| **Trigger** | Manual: “research lot {id}” or `GET /api/grok/jobs?agent=BUYER_RESEARCHER` |
| **Permissions** | Browser public sites. POST `/api/research/findings`. No WhatsApp. No send. |
| **First action** | `GET /api/ops/snapshot` then one lot, max 5 buyers |
| **Expected output** | `{ ok: true, buyerIds: [...], skippedGuessedEmails: [...] }` |
| **Verify** | New buyers/endpoints in snapshot; no `purchasing@` without mailto evidence |
| **Do NOT** | Invent emails, DM anyone, enroll sites with no buying evidence |

---

## 3. OPPORTUNITY_RESEARCHER — CREATE ONLY AFTER MATCHING

| | |
|---|---|
| **Create?** | Yes if quota remains and opportunities exist |
| **Prompt file** | `grok/agents/OPPORTUNITY_RESEARCHER.md` |
| **Trigger** | Manual: rank newest snapshot opportunities |
| **Permissions** | Public site of that buyer. POST findings. No execute. |
| **First action** | Snapshot → rank ≤5 pairs → POST new evidenced endpoints |
| **Expected output** | Ranked channel list + `email_dry_run` or `no_path` |
| **Verify** | `opportunities.selected_channel` / new endpoints; email not forced if only a form exists |
| **Do NOT** | Send, submit forms, assume email always wins |

---

## 4. INBOUND_ANALYST — DO NOT CREATE YET

| | |
|---|---|
| **Create?** | **No** unless a real ambiguous reply arrives |
| **Prompt file** | `grok/agents/INBOUND_ANALYST.md` |
| **Trigger** | Bailey pastes a reply |
| **Permissions** | Read snapshot. Propose one reply. Do not send. |
| **First action** | Classify; if phone → Oliver handoff |
| **Expected output** | CLASSIFICATION + PHONE + OLIVER_HANDOFF |
| **Verify** | Code inbound still owns suppressions |
| **Do NOT** | Long automated threads; create this on day 1 “just in case” |

---

## 5–8. DORMANT — DO NOT CREATE

| Agent | Prompt | Trigger | First action |
|---|---|---|---|
| FORM_OPERATOR | `grok/FORM_OPERATOR.md` | Phase 2 jobs only | Prepare packet, `live: false` |
| INSTAGRAM_OPERATOR | `grok/INSTAGRAM_OPERATOR.md` | Phase 3 | Do not DM |
| LINKEDIN_OPERATOR | `grok/LINKEDIN_OPERATOR.md` | Phase 3 | Do not InMail |
| MARKETPLACE_OPERATOR | `grok/MARKETPLACE_OPERATOR.md` | Phase 3 | Do not submit |

**Do NOT** create `SOCIAL_OPERATOR` (retired). **Do NOT** enable live on any of these.

---

## After agents exist

Bailey (not Grok) runs matching/dry-run:

```bash
curl -s http://localhost:3222/api/jobs/tick
curl -s http://localhost:3222/api/metrics
```

Live email is a later, explicit killswitch flip — not part of agent creation.
