# Telegram Anti-Spam Bot (Cloudflare Workers)

This project is a sophisticated anti-spam bot for Telegram, designed to run on Cloudflare's serverless infrastructure. It features intelligent text normalization, a multi-tier filtering system, and a text-based captcha for new members.

## Project Overview

*   **Core Logic**: Built with [Hono](https://hono.dev/) on Cloudflare Workers.
*   **Data Persistence**: Uses [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) to store settings, configured chats, admin-chat assignments, discovered chats, blacklists, quarantine messages, logs, and pre-moderation states.
*   **Async Processing**: Utilizes [Cloudflare Queues](https://developers.cloudflare.com/queues/) for reliable captcha timeout handling.
*   **Admin Dashboard**: A built-in SPA (`public/admin/index.html`) for managing the bot, served as Cloudflare Workers Static Assets at the `/admin` path.
*   **Language**: TypeScript.

### Key Features

1.  **Text Normalization**: Handles homoglyphs (e.g., Cyrillic 'а' vs Latin 'a'), invisible Unicode characters, and whitespace manipulation to prevent filter evasion.
2.  **Two-Tier Filtering**:
    *   **Blacklist (Hard Match)**: Immediate deletion of messages and a permanent ban for the user.
    *   **Quarantine (Soft Match)**: Messages matching suspicious keywords are held for manual moderator review in the dashboard.
3.  **Pre-moderation (Captcha)**: New users are restricted to read-only mode and must solve a simple digit-based captcha (selecting a number written as a word) within a configurable timeout.
4.  **Safe Mode**: A "dry run" mode where the bot logs what it *would* have done without actually deleting messages or banning users.
5.  **User Reports**: Allows users to report spam by replying to a message with a bot mention, which then sends the message to the quarantine for review.
6.  **Multi-chat Admin Assignments**: The same bot can moderate multiple Telegram chats. One admin can be assigned to several chats, several admins can share several chats, and several admins can manage one chat.
7.  **Known Chat Discovery**: Admins can send `/chats` to the bot in private chat to list non-private chats the bot has seen via membership updates or messages.

## Project Structure

*   `src/index.ts`: The main entry point containing the Hono app, Telegram webhook handlers, API routes for the dashboard, and Queue consumer logic.
*   `public/admin/index.html`: A single-file administrative interface using Vanilla JS and Tailwind CSS, deployed through the Worker `ASSETS` binding.
*   `schema.sql`: Defines the database structure for D1.
*   `wrangler.toml.example`: Template for Cloudflare configuration (D1, Queues, and general settings).
*   `worker-configuration.d.ts`: TypeScript definitions for environment bindings.

## Building and Running

### Prerequisites

*   Node.js and npm.
*   Cloudflare account with `wrangler` CLI installed.

### Commands

*   **Installation**: `npm install`
*   **Admin CSS Build**: `npm run build:css` (Compiles Tailwind CSS for the static admin dashboard asset)
*   **Local Development**: `npm run dev` (Runs the worker locally using Miniflare).
*   **Type Generation**: `npm run types` (Generates types for your D1 and Queue bindings).
*   **Deployment**: `npx wrangler deploy` (Deploys the project to Cloudflare; `npm run deploy` is only a wrapper for this command).
*   **Database Setup**:
    *   Create D1: `wrangler d1 create telegram_antispam`
    *   Apply Schema: `wrangler d1 execute telegram_antispam --file=./schema.sql` (Add `--local` for local dev).
*   **Queue Setup**:
    *   Create Queue: `wrangler queues create anti-spam-delay-queue`

## Development Conventions

*   **Hono Framework**: Use Hono for all HTTP routing and middleware.
*   **Admin Static Assets**: Keep dashboard HTML/CSS/JS under `public/admin/`. Do not import admin HTML into `src/index.ts`; the Worker serves the admin shell through `env.ASSETS`.
*   **Tailwind Usage**: Do not use `cdn.tailwindcss.com` in production. Update Tailwind classes in `public/admin/index.html`, then regenerate `public/admin/tailwind.css` via `npm run build:css`.
*   **Database Interactions**: Use the D1 binding (`DB`) with prepared statements for safety.
*   **Error Handling**: API errors should return a JSON response with `{ ok: false, error: "..." }`.
*   **Localization**: The bot's public messages and dashboard are primarily in Ukrainian.
*   **Security**: The `/admin` and `/admin/*` routes should be protected via Cloudflare Access (Zero Trust) in production, as the worker does not implement internal authentication.
*   **Normalization**: Always use `normalizeText` and `normalizeForPhraseMatch` when comparing user input against blacklists or keywords.
*   **Multi-chat Data Model**:
    *   `bot_chats` contains chats configured for moderation in the admin panel.
    *   `bot_admins` contains configured dashboard/Telegram action admins.
    *   `admin_chat_assignments` maps admins to configured moderation chats.
    *   `known_chats` contains non-private chats the bot has observed; it is used by the `/chats` helper and does not make a chat moderated by itself.
*   **Telegram Token Handling**: The dashboard treats the bot token as write-only. API responses should expose only whether a token is configured, never the token value.
*   **Admin Notifications**: Include chat names only when a receiving admin has more than one assigned chat.
