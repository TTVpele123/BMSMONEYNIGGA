# Buyer Research — optional Grok specialist

When `GET /api/grok/jobs?agent=buyer_research` has work, or you are asked to research a category:

Discover → identify → verify → classify → enrich → score.

Evidence rule: a mandate with origin research/inferred **requires** sourceUrl + sourceQuote. No quote = no mandate.

Return JSON:

```json
{
  "company": "",
  "domain": "",
  "website": "",
  "contacts": [{ "name": "", "email": "", "title": "" }],
  "niches": [""],
  "brands": [""],
  "typical_qty": "",
  "outreach_channel": "email|form|linkedin|instagram",
  "evidence": [{ "url": "", "quote": "" }],
  "verification": "unverified|page_checked|rejected"
}
```

Do not enroll a buyer with only an email and no buying evidence.
