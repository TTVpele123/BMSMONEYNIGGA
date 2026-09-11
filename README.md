# BMSMONEYNIGGA

Autonomous deal-acquisition engine. Oliver WhatsApp inventory in → qualified buyer conversations and deals out.

This is a **new system**, not Oliver Deal OS 2. Deal OS is a read-only source of buyers, lots, media, and safety lessons.

## Quick start

```bash
npm install
cp .env.example .env.local   # optional
npm test
./start.sh                   # http://localhost:3222  (OUTBOUND_MODE=dry_run)
```

Saturday Grok reset: [grok/FIRST_DAY_RUNBOOK.md](grok/FIRST_DAY_RUNBOOK.md). Do not create form/social agents on day 1.

## North-star metric

Qualified buyer conversations per Oliver lot → deals per lot.

Not emails sent. Not buyers discovered.

## Loops

1. WhatsApp ingest → lot + original Oliver photos → match → chat one buyer once → outreach → inbound → escalate hot deals
2. 24/7 buyer research: discover → verify → classify → enrich → score → enroll

Human involvement is the exception: hot buyers, negotiation, money/legal, or genuine ambiguity.
