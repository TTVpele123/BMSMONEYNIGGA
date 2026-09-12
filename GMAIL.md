# Gmail — `saevitzonoverstock@gmail.com`

Authorized mailbox only. `saefamoverstock@gmail.com` is banned and will be rejected at send time.

Default outbound mode is **`dry_run`**. Connecting Gmail does **not** send mail. `./start.sh` does **not** export `OUTBOUND_MODE`; runtime mode is `settings.outbound_mode` (seeded `dry_run`). Flip live only via `POST /api/killswitch` after a stared-at dry-run.

## Env vars

Put these in `.env.local` (never commit):

```
AUTHORIZED_AUTOMATED_SENDER=saevitzonoverstock@gmail.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=http://localhost:3222/api/gmail/oauth/callback
BMSM_PORT=3222
BMSM_SECRET=                 # optional; otherwise ~/.bmsmoneynigga/data/.secret.key is created
OUTBOUND_MODE=dry_run        # seed only on first DB create; settings win after that
KILL_SWITCH=false
```

Dry-run and matching work with all Gmail vars empty.

## OAuth scopes

- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`

## Token storage

- Path: `~/.bmsmoneynigga/data/gmail-oauth.enc` (or `$BMSM_DATA_DIR/data/gmail-oauth.enc`)
- Format: AES-256-GCM (`iv || authTag || ciphertext`, base64) of:

```json
{
  "address": "saevitzonoverstock@gmail.com",
  "refresh_token": "...",
  "access_token": "...",
  "expiry": "2026-09-11T00:00:00.000Z",
  "scopes": ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
  "updated_at": "2026-09-11T00:00:00.000Z"
}
```

Tokens for any other address are refused.

## Authenticate (manual, after this commit)

1. In Google Cloud, reuse the existing OAuth client (or create a Desktop/Web client).
2. Add authorized redirect URI: `http://localhost:3222/api/gmail/oauth/callback`.
3. Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.local`.
4. Restart `./start.sh` (still dry_run).
5. Confirm `GET http://localhost:3222/api/gmail/status` shows `oauth_client: true` and `connected: false`.
6. In a browser, open `http://localhost:3222/api/gmail/oauth/start`.
7. Sign in as **`saevitzonoverstock@gmail.com`** (not saefam, not personal). Grant send + readonly.
8. You should land on a “Gmail connected” page. If you authenticated as anyone else, tokens are not saved.
9. Re-check `/api/gmail/status` — `connected: true`, `address` matches the authorized mailbox.
10. Leave `outbound_mode` on `dry_run`. Inbox sync (`POST /api/gmail/sync` and the 5-minute scheduler) can run; it only writes inbound events.

Do **not** flip live until you have reviewed a dry-run body + media hashes for the lots you intend to send.

## Live flip (not done by this change)

`POST /api/killswitch` with `{ "outbound_mode": "live" }`. Kill switch, suppression, one-touch ledger, and replied-manual-only still apply. Failed provider calls stay `failed`, never `sent`.
