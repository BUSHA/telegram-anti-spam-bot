import { Hono } from 'hono';

type Env = {
  DB: D1Database;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
};

const app = new Hono<{ Bindings: Env }>();

const ADMIN_CACHE = new Map<string, { expiresAt: number; ids: Set<number> }>();
const BLACKLIST_CACHE = new Map<
  string,
  {
    expiresAt: number;
    rows: Array<{ id: number; pattern: string; is_regex: number }>;
  }
>();

const SOFT_SUSPICIOUS_KEYWORDS = [
  'заработ',
  'доход',
  'инвест',
  'крипт',
  'прибыл',
  'без влож',
  'в личку',
  'пиши в лс',
  'ставк',
  'казин',
  'быстрые деньги'
];

const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  k: 'к',
  m: 'м',
  t: 'т',
  b: 'в',
  h: 'н'
};

const INVISIBLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/gu;
const LINK_RE = /(https?:\/\/|t\.me\/|telegram\.me\/)/u;

function normalizeText(input: string): string {
  const lowered = input.toLowerCase().replace(INVISIBLE_RE, '');
  let out = '';
  for (const ch of lowered) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

async function logAction(db: D1Database, action: string, userId: number | null, details: string): Promise<void> {
  await db
    .prepare('INSERT INTO logs(action, user_id, details) VALUES(?, ?, ?)')
    .bind(action, userId, details)
    .run();
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramResponse<T>> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return (await res.json()) as TelegramResponse<T>;
}

async function setWebhook(token: string, url: string, secret: string): Promise<TelegramResponse<boolean>> {
  return telegramApi<boolean>(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message']
  });
}

async function getBlacklist(
  db: D1Database
): Promise<Array<{ id: number; pattern: string; is_regex: number }>> {
  const cacheKey = 'global';
  const now = Date.now();
  const cached = BLACKLIST_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.rows;

  const rows = await db
    .prepare('SELECT id, pattern, is_regex FROM blacklist ORDER BY id DESC')
    .all<{ id: number; pattern: string; is_regex: number }>();
  const result = rows.results ?? [];
  BLACKLIST_CACHE.set(cacheKey, { expiresAt: now + 60_000, rows: result });
  return result;
}

function isHardMatch(text: string, rows: Array<{ id: number; pattern: string; is_regex: number }>): boolean {
  for (const row of rows) {
    if (row.is_regex) {
      try {
        const re = new RegExp(row.pattern, 'iu');
        if (re.test(text)) return true;
      } catch {
        continue;
      }
    } else {
      const normalizedPattern = normalizeText(row.pattern);
      if (normalizedPattern && text.includes(normalizedPattern)) return true;
    }
  }
  return false;
}

function isSoftMatch(rawText: string, normalizedTextValue: string): boolean {
  if (LINK_RE.test(rawText.toLowerCase())) return true;
  return SOFT_SUSPICIOUS_KEYWORDS.some((k) => normalizedTextValue.includes(k));
}

async function isAdmin(db: D1Database, token: string, chatId: string, userId: number): Promise<boolean> {
  const now = Date.now();
  const cache = ADMIN_CACHE.get(chatId);
  if (cache && cache.expiresAt > now) return cache.ids.has(userId);

  const response = await telegramApi<Array<{ user: { id: number }; status: string }>>(
    token,
    'getChatAdministrators',
    { chat_id: chatId }
  );
  if (!response.ok || !response.result) return false;

  const ids = new Set<number>();
  for (const admin of response.result) {
    if (admin.status === 'administrator' || admin.status === 'creator') ids.add(admin.user.id);
  }
  ADMIN_CACHE.set(chatId, { expiresAt: now + 300_000, ids });
  return ids.has(userId);
}

async function banAndDelete(
  db: D1Database,
  token: string,
  chatId: string,
  messageId: number,
  userId: number,
  source: string
): Promise<void> {
  await telegramApi(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  await telegramApi(token, 'banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: true });
  await logAction(db, 'ban_delete', userId, `${source}: banned user ${userId} and deleted message ${messageId}`);
}

async function upsertCoreSettings(
  db: D1Database,
  token: string,
  chatId: string,
  workerUrl: string
): Promise<{ secret: string; webhook: TelegramResponse<boolean> }> {
  await setSetting(db, 'TELEGRAM_TOKEN', token);
  await setSetting(db, 'CHAT_ID', chatId);

  let secret = await getSetting(db, 'WEBHOOK_SECRET');
  if (!secret) {
    secret = crypto.randomUUID();
    await setSetting(db, 'WEBHOOK_SECRET', secret);
  }

  await setSetting(db, 'WORKER_URL', workerUrl);
  const webhook = await setWebhook(token, `${workerUrl}/webhook`, secret);
  return { secret, webhook };
}

function jsonError(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

app.onError((err, c) => {
  console.error(err);
  if (c.req.path.startsWith('/admin/api/')) return jsonError('internal_error', 500);
  return c.text('internal_error', 500);
});

app.get('/health', (c) => c.json({ ok: true }));

app.post('/webhook', async (c) => {
  const db = c.env.DB;
  const token = await getSetting(db, 'TELEGRAM_TOKEN');
  const chatId = await getSetting(db, 'CHAT_ID');
  const secret = await getSetting(db, 'WEBHOOK_SECRET');

  if (!token || !chatId || !secret) return c.json({ ok: true, skipped: 'not_configured' });

  const incomingSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (incomingSecret !== secret) return jsonError('unauthorized', 401);

  const update = await c.req.json<{ message?: TelegramMessage }>();
  const message = update.message;
  if (!message) return c.json({ ok: true, skipped: 'no_message' });
  if (String(message.chat.id) !== String(chatId)) return c.json({ ok: true, skipped: 'wrong_chat' });

  const sender = message.from;
  if (!sender || sender.is_bot) return c.json({ ok: true, skipped: 'no_sender' });

  if (await isAdmin(db, token, chatId, sender.id)) return c.json({ ok: true, skipped: 'admin_user' });

  const text = message.text ?? message.caption ?? '';
  if (!text.trim()) return c.json({ ok: true, skipped: 'no_text' });
  const normalized = normalizeText(text);

  const blacklist = await getBlacklist(db);
  if (isHardMatch(normalized, blacklist)) {
    await banAndDelete(db, token, chatId, message.message_id, sender.id, 'hard_match');
    return c.json({ ok: true, action: 'ban_delete' });
  }

  if (isSoftMatch(text, normalized)) {
    await db
      .prepare(
        'INSERT INTO quarantine(message_id, user_id, username, text) VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING'
      )
      .bind(message.message_id, sender.id, sender.username ?? '', text)
      .run();
    await logAction(db, 'quarantine', sender.id, `message ${message.message_id} queued for review`);
    return c.json({ ok: true, action: 'quarantine' });
  }

  return c.json({ ok: true, action: 'allow' });
});

app.get('/admin', (c) => {
  return c.html(ADMIN_HTML);
});
app.get('/admin/', (c) => c.html(ADMIN_HTML));

app.get('/admin/api/settings', async (c) => {
  const db = c.env.DB;
  const token = await getSetting(db, 'TELEGRAM_TOKEN');
  const chatId = await getSetting(db, 'CHAT_ID');
  const workerUrl = await getSetting(db, 'WORKER_URL');
  return c.json({
    ok: true,
    data: {
      token: token ?? '',
      chatId: chatId ?? '',
      workerUrl: workerUrl ?? ''
    }
  });
});

app.post('/admin/api/settings', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ token?: string; chatId?: string }>();
  const token = (body.token ?? '').trim();
  const chatId = (body.chatId ?? '').trim();
  if (!token || !chatId) return jsonError('token and chatId are required');
  if (!/^-?\d+$/u.test(chatId)) return jsonError('chatId must be numeric');

  const workerUrl = new URL(c.req.url).origin;
  const { webhook } = await upsertCoreSettings(db, token, chatId, workerUrl);
  await logAction(db, 'settings_updated', null, `chat ${chatId}, webhook ${webhook.ok ? 'ok' : 'failed'}`);

  return c.json({
    ok: true,
    data: {
      webhookOk: webhook.ok,
      webhookDescription: webhook.description ?? ''
    }
  });
});

app.get('/admin/api/blacklist', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, pattern, is_regex FROM blacklist ORDER BY id DESC')
    .all<{ id: number; pattern: string; is_regex: number }>();
  return c.json({ ok: true, data: rows.results ?? [] });
});

app.post('/admin/api/blacklist', async (c) => {
  const body = await c.req.json<{ pattern?: string; isRegex?: boolean }>();
  const pattern = (body.pattern ?? '').trim();
  const isRegex = !!body.isRegex;
  if (!pattern) return jsonError('pattern is required');

  if (isRegex) {
    try {
      new RegExp(pattern, 'u');
    } catch {
      return jsonError('invalid regex');
    }
  }

  await c.env.DB.prepare('INSERT INTO blacklist(pattern, is_regex) VALUES(?, ?)').bind(pattern, isRegex ? 1 : 0).run();
  BLACKLIST_CACHE.delete('global');
  await logAction(c.env.DB, 'blacklist_add', null, `added pattern "${pattern}"`);
  return c.json({ ok: true });
});

app.delete('/admin/api/blacklist/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');
  await c.env.DB.prepare('DELETE FROM blacklist WHERE id = ?').bind(id).run();
  BLACKLIST_CACHE.delete('global');
  await logAction(c.env.DB, 'blacklist_delete', null, `deleted pattern id ${id}`);
  return c.json({ ok: true });
});

app.get('/admin/api/quarantine', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, message_id, user_id, username, text, timestamp FROM quarantine ORDER BY id DESC LIMIT 100')
    .all();
  return c.json({ ok: true, data: rows.results ?? [] });
});

app.post('/admin/api/quarantine/:id/ban-delete', async (c) => {
  const db = c.env.DB;
  const token = await getSetting(db, 'TELEGRAM_TOKEN');
  const chatId = await getSetting(db, 'CHAT_ID');
  if (!token || !chatId) return jsonError('system is not configured', 503);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');

  const row = await db
    .prepare('SELECT id, message_id, user_id FROM quarantine WHERE id = ?')
    .bind(id)
    .first<{ id: number; message_id: number; user_id: number }>();
  if (!row) return jsonError('not found', 404);

  await banAndDelete(db, token, chatId, row.message_id, row.user_id, 'manual_review');
  await db.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();

  return c.json({ ok: true });
});

app.post('/admin/api/quarantine/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');
  await c.env.DB.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();
  await logAction(c.env.DB, 'quarantine_approved', null, `approved quarantine id ${id}`);
  return c.json({ ok: true });
});

app.get('/admin/api/logs', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, action, user_id, details, timestamp FROM logs ORDER BY id DESC LIMIT 200')
    .all();
  return c.json({ ok: true, data: rows.results ?? [] });
});

const ADMIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegram Anti-Spam Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-100 text-slate-900 min-h-screen">
    <main class="max-w-5xl mx-auto p-6 space-y-8">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">Telegram Anti-Spam Dashboard</h1>
        <button id="refreshBtn" class="px-3 py-2 bg-slate-800 text-white rounded">Refresh</button>
      </header>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">System Setup</h2>
        <div class="grid md:grid-cols-2 gap-3">
          <input id="token" class="border rounded p-2" placeholder="Bot Token" />
          <input id="chatId" class="border rounded p-2" placeholder="Target Chat ID (e.g. -100...)" />
        </div>
        <button id="saveSettings" class="px-3 py-2 bg-blue-600 text-white rounded">Save & Set Webhook</button>
      </section>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">Blacklist Manager</h2>
        <div class="grid md:grid-cols-[1fr_auto_auto] gap-2">
          <input id="pattern" class="border rounded p-2" placeholder="Pattern or stop-word" />
          <label class="flex items-center gap-2"><input id="isRegex" type="checkbox" />Regex</label>
          <button id="addPattern" class="px-3 py-2 bg-emerald-600 text-white rounded">Add</button>
        </div>
        <div id="blacklistList" class="space-y-2"></div>
      </section>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">Review Queue</h2>
        <div id="quarantineList" class="space-y-2"></div>
      </section>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">History</h2>
        <div id="logsList" class="space-y-2 text-sm"></div>
      </section>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);

      async function api(path, options = {}) {
        const res = await fetch(path, {
          headers: { 'content-type': 'application/json' },
          ...options
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');
        return data;
      }

      function rowCard(content) {
        const div = document.createElement('div');
        div.className = 'border rounded p-3 bg-slate-50';
        div.innerHTML = content;
        return div;
      }

      async function loadSettings() {
        const data = await api('/admin/api/settings');
        $('token').value = data.data.token || '';
        $('chatId').value = data.data.chatId || '';
      }

      async function saveSettings() {
        await api('/admin/api/settings', {
          method: 'POST',
          body: JSON.stringify({
            token: $('token').value,
            chatId: $('chatId').value
          })
        });
        await refreshAll();
      }

      async function loadBlacklist() {
        const data = await api('/admin/api/blacklist');
        const root = $('blacklistList');
        root.innerHTML = '';
        for (const row of data.data) {
          const el = rowCard('<div class="flex items-center justify-between gap-3"><div><span class="font-medium">' +
            row.pattern.replaceAll('<', '&lt;') +
            '</span><span class="ml-2 text-xs text-slate-500">' + (row.is_regex ? 'regex' : 'plain') +
            '</span></div><button data-id="' + row.id + '" class="del-pattern px-2 py-1 text-white bg-rose-600 rounded">Delete</button></div>');
          root.appendChild(el);
        }
        root.querySelectorAll('.del-pattern').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/blacklist/' + btn.dataset.id, { method: 'DELETE' });
            await loadBlacklist();
          });
        });
      }

      async function addPattern() {
        await api('/admin/api/blacklist', {
          method: 'POST',
          body: JSON.stringify({
            pattern: $('pattern').value,
            isRegex: $('isRegex').checked
          })
        });
        $('pattern').value = '';
        $('isRegex').checked = false;
        await loadBlacklist();
      }

      async function loadQuarantine() {
        const data = await api('/admin/api/quarantine');
        const root = $('quarantineList');
        root.innerHTML = '';
        for (const row of data.data) {
          const safeText = String(row.text || '').replaceAll('<', '&lt;');
          const el = rowCard(
            '<div class="space-y-2"><div class="text-xs text-slate-500">user: ' + row.user_id +
            (row.username ? ' (@' + row.username + ')' : '') + ', msg: ' + row.message_id + '</div>' +
            '<div>' + safeText + '</div>' +
            '<div class="flex gap-2"><button data-id="' + row.id + '" class="ban-delete px-2 py-1 bg-rose-600 text-white rounded">Ban & Delete</button>' +
            '<button data-id="' + row.id + '" class="approve px-2 py-1 bg-slate-600 text-white rounded">Approve</button></div></div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.ban-delete').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/ban-delete', { method: 'POST' });
            await loadQuarantine();
            await loadLogs();
          });
        });
        root.querySelectorAll('.approve').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/approve', { method: 'POST' });
            await loadQuarantine();
            await loadLogs();
          });
        });
      }

      async function loadLogs() {
        const data = await api('/admin/api/logs');
        const root = $('logsList');
        root.innerHTML = '';
        for (const row of data.data) {
          const el = rowCard('<div><span class="font-medium">' + row.action + '</span> · ' + row.timestamp + '</div><div class="text-slate-600">' +
            String(row.details || '').replaceAll('<', '&lt;') + '</div>');
          root.appendChild(el);
        }
      }

      async function refreshAll() {
        await Promise.all([loadSettings(), loadBlacklist(), loadQuarantine(), loadLogs()]);
      }

      $('saveSettings').addEventListener('click', () => saveSettings().catch((e) => alert(e.message)));
      $('addPattern').addEventListener('click', () => addPattern().catch((e) => alert(e.message)));
      $('refreshBtn').addEventListener('click', () => refreshAll().catch((e) => alert(e.message)));

      refreshAll().catch((e) => alert(e.message));
    </script>
  </body>
</html>`;

export default app;
