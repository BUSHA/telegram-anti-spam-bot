# Telegram Anti-Spam Bot: Setup and Deployment Guide

This guide covers first-time setup and production deployment for the Cloudflare Workers + D1 Telegram anti-spam bot.

## 1. Prerequisites

- Cloudflare account with Workers + D1 enabled
- Node.js 18+ and npm installed
- A Telegram bot token from `@BotFather`
- Target Telegram group where the bot is already added
- Bot has admin permissions in that group:
  - Delete messages
  - Ban users
  - Read group messages

## 2. Project Install

From the project root:

```bash
npm install
npm run types
```

`npm run types` generates `worker-configuration.d.ts` (required for IDE/runtime types).

## 3. Cloudflare Auth

Authenticate Wrangler:

```bash
npx wrangler login
```

Verify:

```bash
npx wrangler whoami
```

## 4. Create D1 Database

Create DB:

```bash
npx wrangler d1 create telegram_antispam
```

Copy the returned `database_id` and put it into [wrangler.toml](/Users/busha/projects/banner/wrangler.toml):

```toml
[[d1_databases]]
binding = "DB"
database_name = "telegram_antispam"
database_id = "PASTE_REAL_DATABASE_ID_HERE"
```

## 5. Run First Migration

### Recommended (Wrangler local schema file execution)

```bash
npx wrangler d1 execute telegram_antispam --remote --file=schema.sql
```

### Alternative (Cloudflare API + curl)

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/d1/database/<DATABASE_ID>/query" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-binary @<(jq -n --arg sql "$(cat schema.sql)" '{sql: [$sql]}')
```

## 6. Deploy Worker

Deploy:

```bash
npx wrangler deploy
```

After deploy, note your Worker URL, for example:

`https://telegram-anti-spam-bot.<subdomain>.workers.dev`

The bot uses this URL for Telegram webhook setup.

## 7. Telegram Bot and Group Setup

## 7.1 Create bot token

In Telegram, message `@BotFather`:

1. `/newbot`
2. Set name and username
3. Copy token (format similar to `123456:ABC...`)

## 7.2 Add bot to your group

Add the bot to the target group and grant admin rights:

- Delete messages
- Ban users

## 7.3 Get target chat ID

Use one of:

- `@RawDataBot` in your group
- `getUpdates` on Telegram API (temporary polling)

For supergroups, chat IDs usually look like `-1001234567890`.

## 8. System Setup in Dashboard

Open:

- `https://<your-worker-domain>/admin`

In **System Setup**, enter:

- Bot Token
- Target Chat ID

Click **Save & Set Webhook**.

This does:

1. Stores settings in D1 (`TELEGRAM_TOKEN`, `CHAT_ID`, `WORKER_URL`)
2. Creates/stores `WEBHOOK_SECRET` if missing
3. Calls Telegram `setWebhook` to:
   - `https://<worker-domain>/webhook`
   - with secret token validation enabled

## 9. Protect `/admin` with Cloudflare Zero Trust

This project intentionally has no internal login. Protect `/admin/*` using Cloudflare Access.

1. Cloudflare Dashboard -> Zero Trust -> Access -> Applications -> Add application
2. Type: **Self-hosted**
3. Application domain: your Worker domain
4. Path policy: `/admin/*`
5. Add policy:
   - Action: Allow
   - Include: your email / identity provider group
6. Save and test access

Recommended:

- Keep `/webhook` public
- Protect only `/admin` and `/admin/api/*`

## 10. Validate Deployment

## 10.1 Health check

```bash
curl https://<your-worker-domain>/health
```

Expected:

```json
{"ok":true}
```

## 10.2 Verify webhook

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo"
```

Check:

- `url` is `https://<your-worker-domain>/webhook`
- no recent webhook errors

## 10.3 Functional test

1. Add a clear test word to blacklist in `/admin`
2. Send that word from a non-admin user in the target group
3. Expected: message deleted + user banned + log entry appears in History

## 11. Runtime Behavior Summary

- Admin users are ignored (fetched via `getChatAdministrators`, cached)
- Text normalization before checks:
  - lowercase
  - Latin/Cyrillic homoglyph substitutions
  - remove invisible Unicode characters
- Hard match:
  - delete message
  - ban user
  - write audit log
- Soft match:
  - insert into quarantine
  - review manually from dashboard

## 12. Day-2 Operations

Regenerate runtime types after any `wrangler.toml` binding/config change:

```bash
npm run types
```

Redeploy after code changes:

```bash
npx wrangler deploy
```

Optional: view D1 data:

```bash
npx wrangler d1 execute telegram_antispam --remote --command "SELECT * FROM logs ORDER BY id DESC LIMIT 20;"
```

## 13. Troubleshooting

- `Cannot find name 'D1Database'`:
  - Run `npm run types`
  - Restart IDE TypeScript server
- `Cannot find module 'hono'`:
  - Run `npm install`
- Webhook not firing:
  - Check `getWebhookInfo`
  - Confirm Worker is deployed and URL is correct
  - Ensure `/webhook` is not behind Access policy
- Messages not moderated:
  - Confirm bot is admin in group
  - Confirm stored `CHAT_ID` matches actual group
  - Test with non-admin sender (admins are intentionally ignored)
- `/admin` open to internet:
  - Verify Access app path policy is exactly `/admin/*`

## 14. Security Notes

- Do not hardcode bot token in source code
- Rotate bot token if leaked, then re-save settings in dashboard
- Keep Cloudflare API tokens least-privilege
- Restrict `/admin/*` with Access identity checks
