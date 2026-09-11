# First-day runbook (limited Grok quota)

Goal: **one real Oliver drop → structured lot + original photos → match → email dry-run**. Not “stand up every channel.”

## 1. Start BMSMONEYNIGGA

```bash
cd ~/Projects/BMSMONEYNIGGA
./start.sh
```

Optional (already done once): `npm run import:legacy`

## 2. Verify health

```bash
curl -s http://localhost:3222/api/health
curl -s http://localhost:3222/api/metrics
```

Must show `"mode":"dry_run"` and `"kill": false`. Open http://localhost:3222  
If mode is `live`, stop and set dry_run:

```bash
curl -s -X POST http://localhost:3222/api/killswitch \
  -H 'content-type: application/json' \
  -d '{"outbound_mode":"dry_run"}'
```

## 3. Create WHATSAPP_SCANNER only

New GrokBot agent. Paste **all** of `grok/WHATSAPP_SCANNER.md`.

## 4–6. Scan Oliver → ingest → verify media

Tell it: “Scan Oliver’s WhatsApp for new product drops in the last hour.”

Then:

```bash
curl -s http://localhost:3222/api/ops/snapshot
```

Pass:

- new `lots` row
- `recent_whatsapp` ids
- lot photos are originals (`clean_product_photo` / `warehouse_inventory_photo`)
- no chat screenshots on the lot

Fail: screenshots, invented qty/price, wrong chat, engine not POSTed.

## 7–10. Matching + opportunity + email dry-run (code)

Ingest route already ticks the orchestrator. If needed:

```bash
curl -s -X POST http://localhost:3222/api/jobs/tick
```

`selectChannel` + email operator run in code. Grok does **not** send.

## 11. Verify no live send

```bash
curl -s http://localhost:3222/api/metrics
```

`live_sends` must be `0`. `dry_runs` may increase. Dashboard conversations = `queued` / dry_run attempts.

## 12. Inspect opportunities

Dashboard + snapshot `opportunities`.  
Email buyers → dry_run. Form/IG/LI-only → `deferred`. No invented `purchasing@`.

## 13. Only then extra Grok (optional)

If quota remains **and** step 11 passed:

1. Create BUYER_RESEARCHER — paste `grok/agents/BUYER_RESEARCHER.md` — one lot, max 5 buyers
2. Create OPPORTUNITY_RESEARCHER — paste `grok/agents/OPPORTUNITY_RESEARCHER.md` — rank ≤5 pairs
3. `POST /api/jobs/tick` again

**Do not** create FORM / INSTAGRAM / LINKEDIN / MARKETPLACE / INBOUND_ANALYST today.  
**Do not** flip `OUTBOUND_MODE=live` until Gmail for `saevitzonoverstock@gmail.com` is connected (`GMAIL.md`) and you have stared at a dry-run.

## If usage is almost gone

Stop after step 11. That is a successful first day.
