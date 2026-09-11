# Gmail live send (optional Saturday)

Authorized mailbox: **saevitzonoverstock@gmail.com** (`saefamoverstock` was banned — see GrokBot settings and DECISIONS.md).

Dry-run does not need Gmail.

To go live:

1. Reuse the existing Google OAuth client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from Deal OS `.env.local`).
2. Copy `DEAL_OS_SECRET` or `data/.secret.key` **only if** you also copy the encrypted token row for the **current** live mailbox. Do not copy a token for the banned address and expect it to send.
3. Set in `.env.local`:

```
AUTHORIZED_AUTOMATED_SENDER=saevitzonoverstock@gmail.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OUTBOUND_MODE=dry_run
```

4. Confirm dry-run WhatsApp → conversation looks right.
5. Flip `OUTBOUND_MODE=live` via `/api/killswitch` or env.

Until a provider is connected, `guardedOutreach` in live mode returns **failed** (not success).
