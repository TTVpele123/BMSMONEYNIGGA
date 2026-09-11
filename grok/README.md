# Grok reset — Saturday checklist

Cursor Grok Bot quota is for **browser UI only**. The engine already runs without it.

Paying $20–50 on Cursor does **not** refill an app-side Grok cap. An xAI API key (optional) does extraction/copy and does **not** refill Grok Bot.

## 10 minutes after reset

1. `cd ~/Projects/BMSMONEYNIGGA && ./start.sh`  
   Confirm http://localhost:3222 and `curl -s localhost:3222/api/health` shows `"mode":"dry_run"`.
2. Optional: `npm run import:legacy` to pull Deal OS buyers/lots/suppressions (read-only on the old DB).
3. Open a **new Grok agent** in this repo. Paste [WHATSAPP_SCANNER.md](WHATSAPP_SCANNER.md) as the system/task prompt.
4. Let it scan Oliver’s WhatsApp Web thread and POST to `http://localhost:3222/api/ingest/whatsapp`.
5. Refresh the dashboard. Confirm a new lot, original photos (not chat screenshots), and dry-run outreach rows.
6. Only then: `curl -X POST localhost:3222/api/killswitch -H 'content-type: application/json' -d '{"outbound_mode":"live"}'`  
   Live send still requires Gmail tokens for `saevitzonoverstock@gmail.com`. If tokens are missing, live attempts **fail visibly** — they do not pretend to succeed.

## Agents to create in Grok Bot tomorrow

Create these as separate chats/automations. Exact prompts are in this folder.

| Agent | File | When |
|---|---|---|
| WhatsApp Scanner | `WHATSAPP_SCANNER.md` | Hourly (or first run now) |
| Form Operator | `FORM_OPERATOR.md` | Only if `GET /api/grok/jobs?agent=form_operator` returns jobs |
| Social Operator | `SOCIAL_OPERATOR.md` | Only if jobs for `social_operator` exist |
| Research (optional) | `agents/buyer_research.md` | If code research queue is thin |

Do **not** create a “do everything” mega-agent. The engine orchestrates.

## First test

Use Oliver’s real thread. Success looks like:

- `whatsapp_messages` row for each new Oliver message
- `lot_media.classification` is `clean_product_photo` or `warehouse_inventory_photo`
- zero `screenshot_chat_capture` on outreach attempts
- dashboard shows the lot and a dry-run conversation

## Hourly automation

After these files are committed, create a Cursor Automation: cron `0 * * * *`, prompt = contents of `WHATSAPP_SCANNER.md`, tools = browser. Finish that in the Automations editor — do not burn Grok now drafting it interactively.
