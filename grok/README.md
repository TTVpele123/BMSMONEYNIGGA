# GrokBot pack (BMSMONEYNIGGA)

**Do not run GrokBot until usage resets.** Do not create a mega-agent. Do not create form/social agents on day 1.

| Start here | File |
|---|---|
| Tomorrow morning | [FIRST_DAY_RUNBOOK.md](FIRST_DAY_RUNBOOK.md) |
| Exact create/don’t-create list | [GROKBOT_DEPLOYMENT.md](GROKBOT_DEPLOYMENT.md) |
| Why these agents | [OPERATOR_ARCHITECTURE.md](OPERATOR_ARCHITECTURE.md) |
| Phases | [GROK_PHASE_PLAN.md](GROK_PHASE_PLAN.md) |
| Channels | [../CHANNELS.md](../CHANNELS.md) |
| Grok vs xAI | [GROK_VS_XAI.md](GROK_VS_XAI.md) |

## Prompts to paste

| Agent | File | Create tomorrow? |
|---|---|---|
| WHATSAPP_SCANNER | [WHATSAPP_SCANNER.md](WHATSAPP_SCANNER.md) | **Yes — first** |
| BUYER_RESEARCHER | [agents/BUYER_RESEARCHER.md](agents/BUYER_RESEARCHER.md) | Only after scanner works |
| OPPORTUNITY_RESEARCHER | [agents/OPPORTUNITY_RESEARCHER.md](agents/OPPORTUNITY_RESEARCHER.md) | Only after matching |
| INBOUND_ANALYST | [agents/INBOUND_ANALYST.md](agents/INBOUND_ANALYST.md) | No unless a real reply is ambiguous |
| FORM_OPERATOR | [FORM_OPERATOR.md](FORM_OPERATOR.md) | **No** (Phase 2, dormant) |
| INSTAGRAM_OPERATOR | [INSTAGRAM_OPERATOR.md](INSTAGRAM_OPERATOR.md) | **No** (Phase 3) |
| LINKEDIN_OPERATOR | [LINKEDIN_OPERATOR.md](LINKEDIN_OPERATOR.md) | **No** (Phase 3) |
| MARKETPLACE_OPERATOR | [MARKETPLACE_OPERATOR.md](MARKETPLACE_OPERATOR.md) | **No** (Phase 3) |

`SOCIAL_OPERATOR` is retired. Do not create it.

Matching, email dry-run, suppression, and inbound classify are **code**. Do not spend Grok on them.

Default `OUTBOUND_MODE=dry_run`. Do not flip live on first day. See [GMAIL.md](../GMAIL.md).
