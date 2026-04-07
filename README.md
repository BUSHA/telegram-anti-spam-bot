# Telegram Anti-Spam Bot (Cloudflare Workers + D1)

## What is implemented
- Cloudflare Worker using Hono (`src/index.ts`)
- D1 schema (`schema.sql`)
- Telegram webhook processing with secret-token validation
- Cyrillic-oriented normalization (lowercase, homoglyph replacement, invisible char stripping)
- Hard-match blacklist: immediate delete + ban
- Soft-match quarantine: links/suspicious terms go to review queue
- `/admin` SPA (Vanilla JS + Tailwind CDN)
- JSON API under `/admin/api/*` for settings, blacklist, quarantine, logs
- Auto `setWebhook` when token/chat settings are saved
- Admin-user bypass via Telegram `getChatAdministrators` cache

## Files
- Worker config: `wrangler.toml`
- Worker code: `src/index.ts`
- DB schema: `schema.sql`

## Setup
1. Create D1 database:
```bash
wrangler d1 create telegram_antispam
```

2. Put returned `database_id` into `wrangler.toml`.

3. First migration with `curl`:
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database/<DATABASE_ID>/query" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -n --arg sql "$(cat schema.sql)" '{sql: [$sql]}')
```

4. Install and deploy:
```bash
npm install
npm run types
wrangler deploy
```

After every `wrangler.toml` change, rerun:
```bash
npm run types
```

## Zero Trust protection for dashboard
Protect `/admin/*` with Cloudflare Access policy (Application + Policy), and allow only your identities/groups.  
This project intentionally does not implement internal login logic.

## Runtime flow
- Telegram sends updates to `POST /webhook`
- Worker verifies header `X-Telegram-Bot-Api-Secret-Token`
- Worker checks configured `CHAT_ID`
- Admin users are ignored
- Content is normalized and checked against blacklist (`u` regex flag enforced)
- Suspicious non-hard-match content is inserted into `quarantine`
- Dashboard operators review and take actions from `/admin`
