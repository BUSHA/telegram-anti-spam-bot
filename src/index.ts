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
  from?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
};

type TelegramChatMemberUpdate = {
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  new_chat_member?: {
    status: string;
    user?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  };
};

type LogMeta = {
  messageText?: string;
  matchedTerms?: string[];
  user?: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  source?: string;
  messageId?: number;
  chatId?: string;
  softLinkMatch?: boolean;
};

type RuntimeSettings = {
  token: string;
  chatId: string;
  secret: string;
  softKeywords: string[];
  safeMode: boolean;
  webhookPathToken: string;
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

const DEFAULT_SOFT_SUSPICIOUS_KEYWORDS = [
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

const RUNTIME_SETTINGS_CACHE: {
  expiresAt: number;
  value: RuntimeSettings | null;
} = {
  expiresAt: 0,
  value: null
};

let schemaEnsuredPromise: Promise<void> | null = null;

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

const INVISIBLE_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/gu;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const LINK_RE = /(https?:\/\/|t\.me\/|telegram\.me\/)/u;
const SYSTEM_CLEANUP_RE = /(deleted message|удалил\S* сообщение)/iu;

function normalizeText(input: string): string {
  const lowered = input.toLowerCase().replace(INVISIBLE_RE, '');
  let out = '';
  for (const ch of lowered) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

function normalizeForPhraseMatch(input: string): string {
  return normalizeText(input).replace(NON_WORD_RE, ' ').replace(/\s+/gu, ' ').trim();
}

function splitWords(input: string): string[] {
  return normalizeForPhraseMatch(input).split(' ').filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseMatch(textForPhrase: string, phraseForMatch: string): boolean {
  if (!phraseForMatch) return false;
  const phraseExpr = escapeRegex(phraseForMatch).replace(/\s+/gu, '\\s+');
  const re = new RegExp(`(?:^|\\s)${phraseExpr}(?:\\s|$)`, 'u');
  return re.test(textForPhrase);
}

function parseSoftKeywords(value: string | null): string[] {
  if (!value) return DEFAULT_SOFT_SUSPICIOUS_KEYWORDS;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_SOFT_SUSPICIOUS_KEYWORDS;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const list = parsed.map((item) => String(item).trim()).filter(Boolean);
      return list.length ? list : DEFAULT_SOFT_SUSPICIOUS_KEYWORDS;
    }
  } catch {
    // Fallback to newline parsing.
  }

  const list = trimmed
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_SOFT_SUSPICIOUS_KEYWORDS;
}

function serializeSoftKeywords(keywords: string[]): string {
  return JSON.stringify(keywords);
}

function parsePagination(req: Request, defaultPageSize = 20, maxPageSize = 100): { page: number; pageSize: number; offset: number } {
  const url = new URL(req.url);
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawPageSize = Number(url.searchParams.get('pageSize') ?? String(defaultPageSize));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(Math.floor(rawPageSize), maxPageSize) : defaultPageSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pagingMeta(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaEnsuredPromise) {
    schemaEnsuredPromise = (async () => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )`
        )
        .run();

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS blacklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            is_regex INTEGER NOT NULL DEFAULT 0
          )`
        )
        .run();

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS quarantine (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            UNIQUE(message_id, user_id)
          )`
        )
        .run();

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            user_id INTEGER,
            details TEXT,
            meta_json TEXT,
            timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          )`
        )
        .run();

      try {
        await db.prepare('ALTER TABLE logs ADD COLUMN meta_json TEXT').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN first_name TEXT').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN last_name TEXT').run();
      } catch {
        // Column already exists.
      }

      await db.prepare('CREATE INDEX IF NOT EXISTS idx_quarantine_timestamp ON quarantine(timestamp DESC)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)').run();

      const existing = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('SOFT_SUSPICIOUS_KEYWORDS').first();
      if (!existing) {
        await db
          .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
          .bind('SOFT_SUSPICIOUS_KEYWORDS', serializeSoftKeywords(DEFAULT_SOFT_SUSPICIOUS_KEYWORDS))
          .run();
      }

      const safeModeSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('SAFE_MODE').first();
      if (!safeModeSetting) {
        await db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').bind('SAFE_MODE', '0').run();
      }

      const webhookPathSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('WEBHOOK_PATH_TOKEN').first();
      if (!webhookPathSetting) {
        await db
          .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
          .bind('WEBHOOK_PATH_TOKEN', crypto.randomUUID())
          .run();
      }
    })().catch((err) => {
      schemaEnsuredPromise = null;
      throw err;
    });
  }
  await schemaEnsuredPromise;
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
  RUNTIME_SETTINGS_CACHE.expiresAt = 0;
}

async function logAction(
  db: D1Database,
  action: string,
  userId: number | null,
  details: string,
  meta: LogMeta | null = null
): Promise<void> {
  await db
    .prepare('INSERT INTO logs(action, user_id, details, meta_json) VALUES(?, ?, ?, ?)')
    .bind(action, userId, details, meta ? JSON.stringify(meta) : null)
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
    allowed_updates: ['message', 'my_chat_member']
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

function findHardMatchTerms(
  normalizedText: string,
  phraseText: string,
  rows: Array<{ id: number; pattern: string; is_regex: number }>
): string[] {
  const matched = new Set<string>();
  const textWords = splitWords(phraseText);

  for (const row of rows) {
    if (row.is_regex) {
      try {
        const re = new RegExp(row.pattern, 'iu');
        if (re.test(normalizedText)) matched.add(row.pattern);
      } catch {
        continue;
      }
      continue;
    }

    const normalizedPattern = normalizeForPhraseMatch(row.pattern);
    if (!normalizedPattern) continue;

    const patternWords = splitWords(normalizedPattern);
    if (patternWords.length === 0) continue;

    let found = false;
    for (let i = 0; i <= textWords.length - patternWords.length; i += 1) {
      let ok = true;
      for (let j = 0; j < patternWords.length; j += 1) {
        const pw = patternWords[j];
        const tw = textWords[i + j];
        if (!tw) {
          ok = false;
          break;
        }
        if (pw.length >= 3) {
          if (!tw.startsWith(pw)) {
            ok = false;
            break;
          }
        } else if (tw !== pw) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = true;
        break;
      }
    }
    if (found) matched.add(row.pattern);
  }

  return Array.from(matched);
}

function findSoftMatches(
  rawText: string,
  normalizedText: string,
  phraseText: string,
  keywords: string[]
): { terms: string[]; softLinkMatch: boolean } {
  const terms = new Set<string>();
  const linkMatch = LINK_RE.test(rawText.toLowerCase());

  for (const keyword of keywords) {
    const normalizedKeyword = normalizeForPhraseMatch(keyword);
    if (!normalizedKeyword) continue;
    if (normalizedKeyword.includes(' ')) {
      if (phraseMatch(phraseText, normalizedKeyword)) terms.add(keyword);
      continue;
    }
    const stem = normalizeText(keyword).trim();
    if (stem && normalizedText.includes(stem)) terms.add(keyword);
  }

  return {
    terms: Array.from(terms),
    softLinkMatch: linkMatch
  };
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
  ADMIN_CACHE.set(chatId, { expiresAt: now + 900_000, ids });
  return ids.has(userId);
}

async function getRuntimeSettings(db: D1Database): Promise<RuntimeSettings | null> {
  const now = Date.now();
  if (RUNTIME_SETTINGS_CACHE.value && RUNTIME_SETTINGS_CACHE.expiresAt > now) {
    return RUNTIME_SETTINGS_CACHE.value;
  }

  const rows = await db
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)')
    .bind('TELEGRAM_TOKEN', 'CHAT_ID', 'WEBHOOK_SECRET', 'SOFT_SUSPICIOUS_KEYWORDS', 'SAFE_MODE', 'WEBHOOK_PATH_TOKEN')
    .all<{ key: string; value: string }>();

  const map = new Map<string, string>();
  for (const row of rows.results ?? []) map.set(row.key, row.value);

  const token = (map.get('TELEGRAM_TOKEN') ?? '').trim();
  const chatId = (map.get('CHAT_ID') ?? '').trim();
  const secret = (map.get('WEBHOOK_SECRET') ?? '').trim();
  const softKeywords = parseSoftKeywords(map.get('SOFT_SUSPICIOUS_KEYWORDS') ?? null);
  const safeMode = (map.get('SAFE_MODE') ?? '0').trim() === '1';
  const webhookPathToken = (map.get('WEBHOOK_PATH_TOKEN') ?? '').trim();

  if (!token || !chatId || !secret || !webhookPathToken) {
    RUNTIME_SETTINGS_CACHE.value = null;
    RUNTIME_SETTINGS_CACHE.expiresAt = now + 30_000;
    return null;
  }

  const value: RuntimeSettings = { token, chatId, secret, softKeywords, safeMode, webhookPathToken };
  RUNTIME_SETTINGS_CACHE.value = value;
  RUNTIME_SETTINGS_CACHE.expiresAt = now + 60_000;
  return value;
}

async function banAndDelete(
  db: D1Database,
  token: string,
  chatId: string,
  messageId: number,
  userId: number,
  source: string,
  details: string,
  meta: LogMeta
): Promise<void> {
  const deleteResp = await telegramApi<boolean>(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  const banResp = await telegramApi<boolean>(token, 'banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: true });

  const action = deleteResp.ok && banResp.ok ? 'ban_delete' : 'ban_delete_partial';
  const status = `delete=${deleteResp.ok ? 'ok' : 'fail'} ban=${banResp.ok ? 'ok' : 'fail'}`;
  await logAction(db, action, userId, `${details} (${status})`, { ...meta, source });
}

async function upsertCoreSettings(
  db: D1Database,
  token: string,
  chatId: string,
  workerUrl: string
): Promise<{ secret: string; webhook: TelegramResponse<boolean>; webhookPathToken: string }> {
  await setSetting(db, 'TELEGRAM_TOKEN', token);
  await setSetting(db, 'CHAT_ID', chatId);

  let secret = await getSetting(db, 'WEBHOOK_SECRET');
  if (!secret) {
    secret = crypto.randomUUID();
    await setSetting(db, 'WEBHOOK_SECRET', secret);
  }

  let webhookPathToken = await getSetting(db, 'WEBHOOK_PATH_TOKEN');
  if (!webhookPathToken) {
    webhookPathToken = crypto.randomUUID();
    await setSetting(db, 'WEBHOOK_PATH_TOKEN', webhookPathToken);
  }

  await setSetting(db, 'WORKER_URL', workerUrl);
  const webhook = await setWebhook(token, `${workerUrl}/webhook/${webhookPathToken}`, secret);
  return { secret, webhook, webhookPathToken };
}

function jsonError(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  if (c.req.path.startsWith('/admin/api/')) return jsonError('internal_error', 500);
  return c.text('internal_error', 500);
});

app.get('/health', (c) => c.json({ ok: true }));
app.get('/favicon.ico', (c) => c.body(null, 204));

app.post('/webhook/:pathToken', async (c) => {
  const db = c.env.DB;
  const settings = await getRuntimeSettings(db);
  if (!settings) return c.json({ ok: true, skipped: 'not_configured' });
  if (c.req.param('pathToken') !== settings.webhookPathToken) return jsonError('unauthorized', 401);

  const incomingSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') ?? '';
  if (incomingSecret !== settings.secret) return jsonError('unauthorized', 401);

  const update = await c.req.json<{ message?: TelegramMessage; my_chat_member?: TelegramChatMemberUpdate }>();
  const membershipUpdate = update.my_chat_member;
  if (membershipUpdate?.chat?.id && membershipUpdate.new_chat_member?.user?.is_bot) {
    const chatTitle = membershipUpdate.chat.title || membershipUpdate.chat.username || '(untitled)';
    const actor = membershipUpdate.from
      ? `${membershipUpdate.from.first_name ?? ''} ${membershipUpdate.from.last_name ?? ''}`.trim() ||
        membershipUpdate.from.username ||
        String(membershipUpdate.from.id)
      : 'unknown';
    const status = membershipUpdate.new_chat_member.status || 'unknown';
    await logAction(
      db,
      'chat_membership_update',
      null,
      `bot status "${status}" in chat ${membershipUpdate.chat.id} (${chatTitle}); changed by ${actor}`,
      {
        chatId: String(membershipUpdate.chat.id)
      }
    );
    return c.json({ ok: true, action: 'chat_membership_update', chatId: membershipUpdate.chat.id, status });
  }

  const message = update.message;
  if (!message) return c.json({ ok: true, skipped: 'no_message' });
  if (String(message.chat.id) !== String(settings.chatId)) return c.json({ ok: true, skipped: 'wrong_chat' });

  const sender = message.from;
  const text = message.text ?? message.caption ?? '';

  if (sender?.is_bot) {
    if (text && SYSTEM_CLEANUP_RE.test(text)) {
      await telegramApi(settings.token, 'deleteMessage', { chat_id: settings.chatId, message_id: message.message_id });
      return c.json({ ok: true, action: 'cleanup_system_message' });
    }
    return c.json({ ok: true, skipped: 'bot_message' });
  }

  if (!sender) return c.json({ ok: true, skipped: 'no_sender' });
  if (!text.trim()) return c.json({ ok: true, skipped: 'no_text' });

  const normalized = normalizeText(text);
  const phraseText = normalizeForPhraseMatch(text);

  const blacklist = await getBlacklist(db);
  const hardMatchTerms = findHardMatchTerms(normalized, phraseText, blacklist);
  const userLabel = `${sender.first_name ?? ''} ${sender.last_name ?? ''}`.trim() || String(sender.id);
  const usernamePart = sender.username ? `(@${sender.username})` : '(no username)';
  const metaBase: LogMeta = {
    messageText: text,
    user: {
      id: sender.id,
      username: sender.username,
      firstName: sender.first_name,
      lastName: sender.last_name
    },
    messageId: message.message_id,
    chatId: String(message.chat.id)
  };

  if (hardMatchTerms.length > 0) {
    if (await isAdmin(db, settings.token, settings.chatId, sender.id)) return c.json({ ok: true, skipped: 'admin_user' });

    if (settings.safeMode) {
      await logAction(
        db,
        'dry_run_hard_match',
        sender.id,
        `SAFE MODE: would ban/delete user ${userLabel} ${usernamePart}; matched: ${hardMatchTerms.join(', ')}; text: ${text}`,
        { ...metaBase, matchedTerms: hardMatchTerms, source: 'hard_match_dry_run' }
      );
      return c.json({ ok: true, action: 'dry_run_hard_match', matchedTerms: hardMatchTerms });
    }

    await banAndDelete(
      db,
      settings.token,
      settings.chatId,
      message.message_id,
      sender.id,
      'hard_match',
      `hard match by ${userLabel} ${usernamePart}; matched: ${hardMatchTerms.join(', ')}; text: ${text}`,
      { ...metaBase, matchedTerms: hardMatchTerms }
    );
    return c.json({ ok: true, action: 'ban_delete', matchedTerms: hardMatchTerms });
  }

  const softMatch = findSoftMatches(text, normalized, phraseText, settings.softKeywords);
  if (softMatch.terms.length === 0 && !softMatch.softLinkMatch) {
    return c.json({ ok: true, action: 'allow' });
  }

  if (await isAdmin(db, settings.token, settings.chatId, sender.id)) return c.json({ ok: true, skipped: 'admin_user' });

  const softTerms = softMatch.softLinkMatch ? [...softMatch.terms, '[link]'] : softMatch.terms;
  await db
    .prepare(
      'INSERT INTO quarantine(message_id, user_id, username, first_name, last_name, text) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
    )
    .bind(message.message_id, sender.id, sender.username ?? '', sender.first_name ?? '', sender.last_name ?? '', text)
    .run();
  await logAction(
    db,
    'quarantine',
    sender.id,
    `soft match by ${userLabel} ${usernamePart}; matched: ${softTerms.join(', ') || 'none'}; text: ${text}`,
    { ...metaBase, matchedTerms: softTerms, softLinkMatch: softMatch.softLinkMatch, source: 'soft_match' }
  );
  return c.json({ ok: true, action: 'quarantine', matchedTerms: softTerms });
});

app.post('/webhook', (c) => jsonError('not_found', 404));

app.get('/admin', (c) => {
  return c.html(ADMIN_HTML);
});
app.get('/admin/', (c) => c.html(ADMIN_HTML));

app.get('/admin/api/settings', async (c) => {
  const db = c.env.DB;
  const token = await getSetting(db, 'TELEGRAM_TOKEN');
  const chatId = await getSetting(db, 'CHAT_ID');
  const workerUrl = await getSetting(db, 'WORKER_URL');
  const softKeywords = parseSoftKeywords(await getSetting(db, 'SOFT_SUSPICIOUS_KEYWORDS'));
  const safeMode = (await getSetting(db, 'SAFE_MODE')) === '1';
  const webhookPathToken = (await getSetting(db, 'WEBHOOK_PATH_TOKEN')) ?? '';
  return c.json({
    ok: true,
    data: {
      token: token ?? '',
      chatId: chatId ?? '',
      workerUrl: workerUrl ?? '',
      softKeywords,
      safeMode,
      webhookPath: webhookPathToken ? `/webhook/${webhookPathToken}` : ''
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
  const { webhook, webhookPathToken } = await upsertCoreSettings(db, token, chatId, workerUrl);
  await logAction(db, 'settings_updated', null, `chat ${chatId}, webhook ${webhook.ok ? 'ok' : 'failed'}`);

  return c.json({
    ok: true,
    data: {
      webhookOk: webhook.ok,
      webhookDescription: webhook.description ?? '',
      webhookPath: `/webhook/${webhookPathToken}`
    }
  });
});

app.post('/admin/api/settings/moderation', async (c) => {
  const body = await c.req.json<{ keywords?: string[] | string; safeMode?: boolean }>();

  let list: string[] = [];
  if (Array.isArray(body.keywords)) {
    list = body.keywords.map((item) => String(item).trim()).filter(Boolean);
  } else {
    list = String(body.keywords ?? '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (list.length === 0) return jsonError('keywords are required');

  await setSetting(c.env.DB, 'SOFT_SUSPICIOUS_KEYWORDS', serializeSoftKeywords(list));
  await setSetting(c.env.DB, 'SAFE_MODE', body.safeMode ? '1' : '0');
  await logAction(
    c.env.DB,
    'soft_keywords_updated',
    null,
    `updated moderation settings: soft keywords (${list.length}), safe mode ${body.safeMode ? 'on' : 'off'}`
  );
  return c.json({ ok: true, data: { keywords: list, safeMode: !!body.safeMode } });
});

app.get('/admin/api/blacklist', async (c) => {
  const { page, pageSize, offset } = parsePagination(c.req.raw, 20, 100);
  const [rows, totalRow] = await Promise.all([
    c.env.DB
      .prepare('SELECT id, pattern, is_regex FROM blacklist ORDER BY id DESC LIMIT ? OFFSET ?')
      .bind(pageSize, offset)
      .all<{ id: number; pattern: string; is_regex: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM blacklist').first<{ total: number }>()
  ]);
  return c.json({ ok: true, data: rows.results ?? [], paging: pagingMeta(totalRow?.total ?? 0, page, pageSize) });
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
  const { page, pageSize, offset } = parsePagination(c.req.raw, 20, 100);
  const [rows, totalRow] = await Promise.all([
    c.env.DB
      .prepare(
        'SELECT id, message_id, user_id, username, first_name, last_name, text, timestamp FROM quarantine ORDER BY id DESC LIMIT ? OFFSET ?'
      )
      .bind(pageSize, offset)
      .all(),
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM quarantine').first<{ total: number }>()
  ]);
  return c.json({ ok: true, data: rows.results ?? [], paging: pagingMeta(totalRow?.total ?? 0, page, pageSize) });
});

app.post('/admin/api/quarantine/:id/ban-delete', async (c) => {
  const settings = await getRuntimeSettings(c.env.DB);
  if (!settings) return jsonError('system is not configured', 503);

  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');

  const row = await c.env.DB
    .prepare('SELECT id, message_id, user_id, username, first_name, last_name, text FROM quarantine WHERE id = ?')
    .bind(id)
    .first<{
      id: number;
      message_id: number;
      user_id: number;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      text: string;
    }>();
  if (!row) return jsonError('not found', 404);

  const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  const details = `manual review ban-delete user ${fullName || row.user_id}${row.username ? ` (@${row.username})` : ''}; text: ${row.text}`;
  if (settings.safeMode) {
    await logAction(
      c.env.DB,
      'dry_run_manual_review',
      row.user_id,
      `SAFE MODE: would ban/delete from review queue; ${details}`,
      {
        messageText: row.text,
        user: {
          id: row.user_id,
          username: row.username ?? undefined,
          firstName: row.first_name ?? undefined,
          lastName: row.last_name ?? undefined
        },
        messageId: row.message_id,
        chatId: settings.chatId,
        source: 'manual_review_dry_run'
      }
    );
    await c.env.DB.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();
    return c.json({ ok: true, action: 'dry_run_manual_review' });
  }

  await banAndDelete(c.env.DB, settings.token, settings.chatId, row.message_id, row.user_id, 'manual_review', details, {
    messageText: row.text,
    user: {
      id: row.user_id,
      username: row.username ?? undefined,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined
    },
    messageId: row.message_id,
    chatId: settings.chatId
  });

  await c.env.DB.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();

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
  const { page, pageSize, offset } = parsePagination(c.req.raw, 20, 100);
  const includeSystem = new URL(c.req.url).searchParams.get('includeSystem') === '1';

  const filterSql = includeSystem
    ? ''
    : `WHERE action NOT IN ('settings_updated', 'blacklist_add', 'blacklist_delete', 'soft_keywords_updated', 'log_deleted')`;

  const [rows, totalRow] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, action, user_id, details, meta_json, timestamp
         FROM logs
         ${filterSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`
      )
      .bind(pageSize, offset)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM logs ${filterSql}`).first<{ total: number }>()
  ]);

  return c.json({ ok: true, data: rows.results ?? [], paging: pagingMeta(totalRow?.total ?? 0, page, pageSize) });
});

app.delete('/admin/api/logs/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');

  const existing = await c.env.DB.prepare('SELECT id FROM logs WHERE id = ?').bind(id).first<{ id: number }>();
  if (!existing) return jsonError('not found', 404);

  await c.env.DB.prepare('DELETE FROM logs WHERE id = ?').bind(id).run();
  await logAction(c.env.DB, 'log_deleted', null, `deleted history item ${id}`);
  return c.json({ ok: true });
});

app.post('/admin/api/logs/:id/unban', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');

  const settings = await getRuntimeSettings(c.env.DB);
  if (!settings) return jsonError('system is not configured', 503);

  const row = await c.env.DB
    .prepare('SELECT id, user_id, meta_json FROM logs WHERE id = ?')
    .bind(id)
    .first<{ id: number; user_id: number | null; meta_json: string | null }>();
  if (!row) return jsonError('not found', 404);

  const userId = row.user_id;
  if (!userId) return jsonError('no user id in this history item');

  const unbanRes = await telegramApi<boolean>(settings.token, 'unbanChatMember', {
    chat_id: settings.chatId,
    user_id: userId,
    only_if_banned: true
  });

  if (!unbanRes.ok) {
    return jsonError(unbanRes.description ?? 'unban failed', 502);
  }

  let username = '';
  try {
    const meta = row.meta_json ? (JSON.parse(row.meta_json) as LogMeta) : null;
    if (meta?.user?.username) username = ` (@${meta.user.username})`;
  } catch {
    // Ignore parsing errors.
  }

  await logAction(c.env.DB, 'unban', userId, `unbanned user ${userId}${username}`);
  return c.json({ ok: true });
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
    <main class="max-w-6xl mx-auto p-6 space-y-8">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold">Telegram Anti-Spam Dashboard</h1>
        <div class="flex items-center gap-3">
          <span id="safeModeBadge" class="hidden px-2 py-1 rounded text-xs font-semibold bg-amber-200 text-amber-900">SAFE MODE ON</span>
          <button id="refreshBtn" class="px-3 py-2 bg-slate-800 text-white rounded">Refresh</button>
        </div>
      </header>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">Settings</h2>

        <details>
          <summary class="cursor-pointer font-medium">System Setup</summary>
          <div class="mt-3 space-y-3">
            <div class="grid md:grid-cols-2 gap-3">
              <input id="token" class="border rounded p-2" placeholder="Bot Token" />
              <input id="chatId" class="border rounded p-2" placeholder="Target Chat ID (e.g. -100...)" />
            </div>
            <button id="saveSettings" class="px-3 py-2 bg-blue-600 text-white rounded">Save & Set Webhook</button>
            <div id="webhookPathInfo" class="text-xs text-slate-600"></div>
            <label class="flex items-center gap-2 font-medium"><input id="safeMode" type="checkbox" />Safe Mode (no real ban/delete)</label>
            <label for="softKeywords" class="block font-medium">Soft Keywords (one phrase per line)</label>
            <textarea
              id="softKeywords"
              rows="5"
              class="w-full border rounded p-2"
              placeholder="заработ\nбыстрые деньги\n..."
            ></textarea>
            <button id="saveModeration" class="px-3 py-2 bg-indigo-600 text-white rounded">Save Moderation Settings</button>

            <div class="pt-2 border-t">
              <h3 class="text-lg font-semibold">Blacklist Manager</h3>
              <div class="grid md:grid-cols-[1fr_auto_auto] gap-2 mt-2">
                <input id="pattern" class="border rounded p-2" placeholder="Pattern or phrase" />
                <label class="flex items-center gap-2"><input id="isRegex" type="checkbox" />Regex</label>
                <button id="addPattern" class="px-3 py-2 bg-emerald-600 text-white rounded">Add</button>
              </div>
              <div id="blacklistList" class="space-y-2 mt-2"></div>
              <div id="blacklistPager" class="flex items-center justify-between gap-2 text-sm mt-2"></div>
            </div>
          </div>
        </details>
      </section>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <h2 class="text-xl font-semibold">Review Queue</h2>
        <div id="quarantineList" class="space-y-2"></div>
        <div id="quarantinePager" class="flex items-center justify-between gap-2 text-sm"></div>
      </section>

      <section class="bg-white rounded-lg shadow p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold">History</h2>
          <label class="flex items-center gap-2 text-sm"><input id="includeSystemLogs" type="checkbox" />Show system logs</label>
        </div>
        <div id="logsList" class="space-y-2 text-sm"></div>
        <div id="logsPager" class="flex items-center justify-between gap-2 text-sm"></div>
      </section>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const state = {
        blacklistPage: 1,
        quarantinePage: 1,
        logsPage: 1,
        pageSize: 20
      };

      function esc(value) {
        return String(value || '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

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

      function parseMeta(metaJson) {
        if (!metaJson) return null;
        try {
          return JSON.parse(metaJson);
        } catch {
          return null;
        }
      }

      function highlightText(text, terms) {
        let highlighted = esc(text);
        if (!terms || !terms.length) return highlighted;

        const cleanedTerms = terms
          .filter((term) => term && term !== '[link]')
          .map((term) => esc(term))
          .sort((a, b) => b.length - a.length);

        if (!cleanedTerms.length) return highlighted;

        for (const term of cleanedTerms) {
          highlighted = highlighted.split(term).join('<mark class="bg-yellow-200 px-0.5 rounded">' + term + '</mark>');
        }

        return highlighted;
      }

      function pager(rootId, paging, onPageChange) {
        const root = $(rootId);
        if (!paging) {
          root.innerHTML = '';
          return;
        }

        const prevDisabled = paging.page <= 1;
        const nextDisabled = paging.page >= paging.totalPages;

        root.innerHTML =
          '<div>Page ' + paging.page + ' / ' + paging.totalPages + ' · Total: ' + paging.total + '</div>' +
          '<div class="flex gap-2">' +
          '<button class="pager-prev px-2 py-1 rounded border" ' + (prevDisabled ? 'disabled' : '') + '>Prev</button>' +
          '<button class="pager-next px-2 py-1 rounded border" ' + (nextDisabled ? 'disabled' : '') + '>Next</button>' +
          '</div>';

        const prev = root.querySelector('.pager-prev');
        const next = root.querySelector('.pager-next');
        prev.addEventListener('click', () => !prevDisabled && onPageChange(paging.page - 1));
        next.addEventListener('click', () => !nextDisabled && onPageChange(paging.page + 1));
      }

      async function loadSettings() {
        const data = await api('/admin/api/settings');
        $('token').value = data.data.token || '';
        $('chatId').value = data.data.chatId || '';
        $('softKeywords').value = (data.data.softKeywords || []).join('\\n');
        $('safeMode').checked = !!data.data.safeMode;
        $('safeModeBadge').classList.toggle('hidden', !data.data.safeMode);
        $('webhookPathInfo').textContent = data.data.webhookPath
          ? 'Private webhook path: ' + data.data.webhookPath
          : '';
      }

      async function saveSettings() {
        const data = await api('/admin/api/settings', {
          method: 'POST',
          body: JSON.stringify({
            token: $('token').value,
            chatId: $('chatId').value
          })
        });
        if (data.data && data.data.webhookPath) {
          $('webhookPathInfo').textContent = 'Private webhook path: ' + data.data.webhookPath;
        }
      }

      async function saveModeration() {
        await api('/admin/api/settings/moderation', {
          method: 'POST',
          body: JSON.stringify({
            keywords: $('softKeywords').value,
            safeMode: $('safeMode').checked
          })
        });
        $('safeModeBadge').classList.toggle('hidden', !$('safeMode').checked);
      }

      async function loadBlacklist() {
        const data = await api('/admin/api/blacklist?page=' + state.blacklistPage + '&pageSize=' + state.pageSize);
        const root = $('blacklistList');
        root.innerHTML = '';

        for (const row of data.data) {
          const el = rowCard(
            '<div class="flex items-center justify-between gap-3"><div><span class="font-medium">' +
              esc(row.pattern) +
              '</span><span class="ml-2 text-xs text-slate-500">' +
              (row.is_regex ? 'regex' : 'phrase/plain') +
              '</span></div><button data-id="' +
              row.id +
              '" class="del-pattern px-2 py-1 text-white bg-rose-600 rounded">Delete</button></div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.del-pattern').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/blacklist/' + btn.dataset.id, { method: 'DELETE' });
            await loadBlacklist();
          });
        });

        pager('blacklistPager', data.paging, (page) => {
          state.blacklistPage = page;
          loadBlacklist().catch((e) => alert(e.message));
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
        state.blacklistPage = 1;
        await loadBlacklist();
      }

      async function loadQuarantine() {
        const data = await api('/admin/api/quarantine?page=' + state.quarantinePage + '&pageSize=' + state.pageSize);
        const root = $('quarantineList');
        root.innerHTML = '';

        for (const row of data.data) {
          const safeText = esc(row.text || '');
          const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ');
          const namePart = fullName ? ', name: ' + esc(fullName) : '';
          const usernamePart = row.username ? ' (@' + esc(row.username) + ')' : '';
          const el = rowCard(
            '<div class="space-y-2"><div class="text-xs text-slate-500">user: ' +
              row.user_id +
              usernamePart +
              namePart +
              ', msg: ' +
              row.message_id +
              '</div>' +
              '<div>' +
              safeText +
              '</div>' +
              '<div class="flex gap-2"><button data-id="' +
              row.id +
              '" class="ban-delete px-2 py-1 bg-rose-600 text-white rounded">Ban & Delete</button>' +
              '<button data-id="' +
              row.id +
              '" class="approve px-2 py-1 bg-slate-600 text-white rounded">Approve</button></div></div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.ban-delete').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/ban-delete', { method: 'POST' });
            await Promise.all([loadQuarantine(), loadLogs()]);
          });
        });

        root.querySelectorAll('.approve').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/approve', { method: 'POST' });
            await Promise.all([loadQuarantine(), loadLogs()]);
          });
        });

        pager('quarantinePager', data.paging, (page) => {
          state.quarantinePage = page;
          loadQuarantine().catch((e) => alert(e.message));
        });
      }

      function actionTitle(action) {
        if (action === 'ban_delete') return 'Ban & Delete';
        if (action === 'ban_delete_partial') return 'Ban/Delete Partial Failure';
        if (action === 'quarantine') return 'Quarantine';
        if (action === 'unban') return 'Unban';
        return action;
      }

      async function loadLogs() {
        const includeSystem = $('includeSystemLogs').checked ? '1' : '0';
        const data = await api(
          '/admin/api/logs?page=' + state.logsPage + '&pageSize=' + state.pageSize + '&includeSystem=' + includeSystem
        );
        const root = $('logsList');
        root.innerHTML = '';

        for (const row of data.data) {
          const meta = parseMeta(row.meta_json);
          const messageText = meta?.messageText || '';
          const matchedTerms = meta?.matchedTerms || [];
          const userName = [meta?.user?.firstName, meta?.user?.lastName].filter(Boolean).join(' ');
          const userLine = meta?.user
            ? '<div class="text-slate-700">User: <b>' +
              esc(userName || String(meta.user.id)) +
              '</b>' +
              (meta.user.username ? ' (@' + esc(meta.user.username) + ')' : '') +
              '</div>'
            : '';

          const matchLine = matchedTerms.length
            ? '<div class="text-xs text-amber-700">Matched: ' + esc(matchedTerms.join(', ')) + '</div>'
            : '';

          const messageLine = messageText
            ? '<div class="mt-2 text-slate-700">Message: <div class="mt-1 p-2 rounded bg-white border">' +
              highlightText(messageText, matchedTerms) +
              '</div></div>'
            : '';
          const detailsLine = messageText
            ? ''
            : '<div class="text-slate-600">' + esc(row.details || '') + '</div>';

          const canUnban = row.action === 'ban_delete' || row.action === 'ban_delete_partial';

          const el = rowCard(
            '<div class="space-y-2">' +
              '<div class="flex items-center justify-between gap-3"><div><span class="font-medium">' +
              esc(actionTitle(row.action)) +
              '</span> · ' +
              esc(row.timestamp) +
              '</div><div class="flex gap-2">' +
              (canUnban
                ? '<button data-id="' + row.id + '" class="unban px-2 py-1 bg-emerald-700 text-white rounded">Unban</button>'
                : '') +
              '<button data-id="' +
              row.id +
              '" class="delete-log px-2 py-1 bg-slate-600 text-white rounded">Delete</button></div></div>' +
              userLine +
              detailsLine +
              matchLine +
              messageLine +
              '</div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.delete-log').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/logs/' + btn.dataset.id, { method: 'DELETE' });
            await loadLogs();
          });
        });

        root.querySelectorAll('.unban').forEach((btn) => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/logs/' + btn.dataset.id + '/unban', { method: 'POST' });
            await loadLogs();
          });
        });

        pager('logsPager', data.paging, (page) => {
          state.logsPage = page;
          loadLogs().catch((e) => alert(e.message));
        });
      }

      async function refreshAll() {
        await Promise.all([loadSettings(), loadBlacklist(), loadQuarantine(), loadLogs()]);
      }

      $('saveSettings').addEventListener('click', () =>
        saveSettings()
          .then(() => alert('Saved'))
          .catch((e) => alert(e.message))
      );
      $('saveModeration').addEventListener('click', () =>
        saveModeration()
          .then(() => alert('Moderation settings saved'))
          .catch((e) => alert(e.message))
      );
      $('addPattern').addEventListener('click', () => addPattern().catch((e) => alert(e.message)));
      $('refreshBtn').addEventListener('click', () => refreshAll().catch((e) => alert(e.message)));
      $('includeSystemLogs').addEventListener('change', () => {
        state.logsPage = 1;
        loadLogs().catch((e) => alert(e.message));
      });

      refreshAll().catch((e) => alert(e.message));
    </script>
  </body>
</html>`;

export default app;
