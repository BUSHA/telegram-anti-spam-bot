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
  new_chat_members?: Array<{ id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean }>;
  left_chat_member?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  caption_entities?: Array<{ type: string; offset: number; length: number }>;
  reply_to_message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
  };
};

type TelegramChatMemberUpdate = {
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  old_chat_member?: {
    status: string;
    user?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  };
  new_chat_member?: {
    status: string;
    user?: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean };
  };
};

type TelegramCallbackQuery = {
  id: string;
  from: { id: number; username?: string; first_name?: string; last_name?: string };
  data?: string;
  message?: { message_id: number; text?: string; chat: { id: number } };
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
  unbannedAt?: string;
  unbannedBy?: string;
  reporter?: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  reporterMessage?: string;
};

type RuntimeSettings = {
  token: string;
  chatId: string;
  secret: string;
  softKeywords: string[];
  safeMode: boolean;
  webhookPathToken: string;
  adminUserId: string;
  botUsername: string;
  premoderationEnabled: boolean;
  premoderationTimeoutSec: number;
  premoderationPrompt: string;
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
const DEFAULT_PREMODERATION_TIMEOUT_SEC = 30;
const DEFAULT_PREMODERATION_PROMPT =
  'Вітаємо, {user}! Для перевірки оберіть цифру {digit} протягом {seconds} сек.';
const UA_NUMBER_WORDS: Record<number, string> = {
  0: 'нуль',
  1: 'один',
  2: 'два',
  3: 'три',
  4: 'чотири',
  5: "п'ять",
  6: 'шість',
  7: 'сім',
  8: 'вісім',
  9: "дев'ять",
  10: 'десять',
  11: 'одинадцять',
  12: 'дванадцять',
  13: 'тринадцять',
  14: 'чотирнадцять',
  15: "п'ятнадцять",
  16: 'шістнадцять',
  17: 'сімнадцять',
  18: 'вісімнадцять',
  19: "дев'ятнадцять",
  20: 'двадцять',
  21: 'двадцять один',
  22: 'двадцять два',
  23: 'двадцять три',
  24: 'двадцять чотири',
  25: "двадцять п'ять",
  26: 'двадцять шість',
  27: 'двадцять сім',
  28: 'двадцять вісім',
  29: "двадцять дев'ять",
  30: 'тридцять'
};
const PREMOD_MIN_NUMBER = 1;
const PREMOD_MAX_NUMBER = 30;

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

function hasBotMention(message: TelegramMessage, botUsername: string): boolean {
  if (!botUsername) return false;
  const target = `@${botUsername}`.toLowerCase();
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  for (const entity of entities) {
    if (entity.type !== 'mention') continue;
    const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (mention === target) return true;
  }
  return text.toLowerCase().includes(target);
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
            reporter_user_id INTEGER,
            reporter_username TEXT,
            reporter_first_name TEXT,
            reporter_last_name TEXT,
            reporter_message TEXT,
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
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS premoderation_challenges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            join_message_id INTEGER,
            captcha_message_id INTEGER,
            challenge_token TEXT NOT NULL UNIQUE,
            correct_digit INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            failure_reason TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            expires_at TEXT NOT NULL,
            resolved_at TEXT
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
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN reporter_user_id INTEGER').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN reporter_username TEXT').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN reporter_first_name TEXT').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN reporter_last_name TEXT').run();
      } catch {
        // Column already exists.
      }
      try {
        await db.prepare('ALTER TABLE quarantine ADD COLUMN reporter_message TEXT').run();
      } catch {
        // Column already exists.
      }

      await db.prepare('CREATE INDEX IF NOT EXISTS idx_quarantine_timestamp ON quarantine(timestamp DESC)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_premod_expiry ON premoderation_challenges(status, expires_at)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS idx_premod_user ON premoderation_challenges(chat_id, user_id, status)').run();

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

      const adminUserIdSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('ADMIN_USER_ID').first();
      if (!adminUserIdSetting) {
        await db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').bind('ADMIN_USER_ID', '').run();
      }
      const botUsernameSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('BOT_USERNAME').first();
      if (!botUsernameSetting) {
        await db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').bind('BOT_USERNAME', '').run();
      }
      const premodEnabledSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('PREMODERATION_ENABLED').first();
      if (!premodEnabledSetting) {
        await db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)').bind('PREMODERATION_ENABLED', '0').run();
      }
      const premodTimeoutSetting = await db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .bind('PREMODERATION_TIMEOUT_SEC')
        .first();
      if (!premodTimeoutSetting) {
        await db
          .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
          .bind('PREMODERATION_TIMEOUT_SEC', String(DEFAULT_PREMODERATION_TIMEOUT_SEC))
          .run();
      }
      const premodPromptSetting = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('PREMODERATION_PROMPT').first();
      if (!premodPromptSetting) {
        await db
          .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
          .bind('PREMODERATION_PROMPT', DEFAULT_PREMODERATION_PROMPT)
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
): Promise<number | null> {
  const result = await db
    .prepare('INSERT INTO logs(action, user_id, details, meta_json) VALUES(?, ?, ?, ?)')
    .bind(action, userId, details, meta ? JSON.stringify(meta) : null)
    .run();
  const raw = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
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
    allowed_updates: ['message', 'my_chat_member', 'chat_member', 'callback_query']
  });
}

async function getBotUsername(token: string): Promise<string> {
  const res = await telegramApi<{ username?: string }>(token, 'getMe', {});
  return (res.result?.username ?? '').trim().toLowerCase();
}

async function answerCallbackQuery(token: string, callbackQueryId: string, text: string): Promise<void> {
  try {
    await telegramApi<boolean>(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
  } catch {
    // Ignore callback acknowledgement failures.
  }
}

async function sendAdminMessage(
  token: string,
  adminUserId: string,
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>> = []
): Promise<void> {
  if (!adminUserId) return;
  try {
    const payload: Record<string, unknown> = {
      chat_id: adminUserId,
      text,
      disable_web_page_preview: true
    };
    if (buttons.length > 0) payload.reply_markup = { inline_keyboard: buttons };
    await telegramApi<boolean>(token, 'sendMessage', payload);
  } catch {
    // Ignore admin notification delivery failures.
  }
}

async function editMessageText(
  token: string,
  chatId: string | number,
  messageId: number,
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>> = [],
  parseMode?: 'HTML' | 'Markdown'
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text
    };
    payload.reply_markup = { inline_keyboard: buttons };
    if (parseMode) payload.parse_mode = parseMode;
    await telegramApi<boolean>(token, 'editMessageText', payload);
  } catch {
    // Ignore update failures.
  }
}

async function deleteMessage(token: string, chatId: string | number, messageId: number): Promise<void> {
  try {
    await telegramApi<boolean>(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // Ignore deletion failures.
  }
}

async function markCallbackMessageProcessed(
  token: string,
  callbackQuery: TelegramCallbackQuery,
  statusText: string
): Promise<void> {
  const message = callbackQuery.message;
  if (!message) return;

  try {
    await telegramApi<boolean>(token, 'editMessageReplyMarkup', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  } catch {
    // Ignore cleanup errors.
  }

  if (!message.text) return;
  if (/\n\nStatus:/u.test(message.text)) return;

  try {
    await telegramApi<boolean>(token, 'editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `${message.text}\n\nStatus: ${statusText}`
    });
  } catch {
    // Ignore edit text errors.
  }
}

function randomInt(maxExclusive: number): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % maxExclusive;
}

function shuffled<T>(input: T[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function buildPremoderationPrompt(
  template: string,
  userId: number,
  username: string | undefined,
  firstName: string | undefined,
  correctDigit: number,
  timeoutSec: number
): { html: string; plain: string } {
  const safeWord = UA_NUMBER_WORDS[correctDigit] ?? String(correctDigit);
  const mentionText = username ? `@${username}` : (firstName?.trim() || 'користувачу');
  const mentionHtml = username ? mentionText : `<a href="tg://user?id=${userId}">${mentionText}</a>`;
  const normalizedTemplate = (template || DEFAULT_PREMODERATION_PROMPT).trim() || DEFAULT_PREMODERATION_PROMPT;
  const replacements: Array<[string, string]> = [
    ['{user}', mentionHtml],
    ['{digit}', safeWord],
    ['{digit_word}', safeWord],
    ['{digit_num}', String(correctDigit)],
    ['{seconds}', String(timeoutSec)]
  ];
  let html = normalizedTemplate;
  let plain = normalizedTemplate;
  for (const [token, value] of replacements) {
    html = html.split(token).join(value);
    if (token === '{user}') {
      plain = plain.split(token).join(mentionText);
    } else {
      plain = plain.split(token).join(value);
    }
  }
  if (!html.includes('@') && !html.includes('tg://user?id=')) {
    html = `${mentionHtml}, ${html}`;
    plain = `${mentionText}, ${plain}`;
  }
  return { html, plain };
}

function buildUserMention(userId: number, username?: string | null, firstName?: string | null): { html: string; plain: string } {
  if (username) {
    const handle = `@${username}`;
    return { html: handle, plain: handle };
  }
  const name = (firstName ?? '').trim() || 'користувач';
  return {
    html: `<a href="tg://user?id=${userId}">${name}</a>`,
    plain: name
  };
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

async function restrictUserReadOnly(token: string, chatId: string, userId: number): Promise<TelegramResponse<boolean>> {
  return telegramApi<boolean>(token, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false
    }
  });
}

async function restoreUserPermissions(token: string, chatId: string, userId: number): Promise<TelegramResponse<boolean>> {
  return telegramApi<boolean>(token, 'restrictChatMember', {
    chat_id: chatId,
    user_id: userId,
    permissions: {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: true
    }
  });
}

type PremodChallengeRow = {
  id: number;
  chat_id: string;
  user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  join_message_id: number | null;
  captcha_message_id: number | null;
  challenge_token: string;
  correct_digit: number;
  status: string;
  failure_reason: string | null;
  expires_at: string;
};

function userLabelFromRow(row: PremodChallengeRow): string {
  return `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || String(row.user_id);
}

async function resolvePremoderationFailure(
  db: D1Database,
  settings: RuntimeSettings,
  row: PremodChallengeRow,
  reason: 'timeout' | 'wrong_digit' | 'expired_click',
  selectedDigit?: number
): Promise<void> {
  if (row.status !== 'pending') return;
  const nowIso = new Date().toISOString();
  const userLabel = userLabelFromRow(row);
  const usernamePart = row.username ? `(@${row.username})` : '(no username)';
  const reasonLabel = reason === 'timeout' ? 'timeout' : reason === 'wrong_digit' ? 'wrong answer' : 'expired answer';
  const extra = typeof selectedDigit === 'number' ? `; selected ${selectedDigit}, expected ${row.correct_digit}` : '';

  const banRes = await telegramApi<boolean>(settings.token, 'banChatMember', {
    chat_id: settings.chatId,
    user_id: row.user_id,
    revoke_messages: true
  });
  await cleanupJoinMessagesForUser(db, settings.token, settings.chatId, row.user_id);
  if (row.captcha_message_id) await deleteMessage(settings.token, settings.chatId, row.captcha_message_id);
  if (row.join_message_id) await deleteMessage(settings.token, settings.chatId, row.join_message_id);

  await db
    .prepare('UPDATE premoderation_challenges SET status = ?, failure_reason = ?, resolved_at = ? WHERE id = ?')
    .bind('failed', reasonLabel, nowIso, row.id)
    .run();
  const logId = await logAction(
    db,
    'premod_failed',
    row.user_id,
    `pre-moderation failed for ${userLabel} ${usernamePart}; reason ${reasonLabel}${extra}; ban=${banRes.ok ? 'ok' : 'fail'}`,
    {
      user: {
        id: row.user_id,
        username: row.username ?? undefined,
        firstName: row.first_name ?? undefined,
        lastName: row.last_name ?? undefined
      },
      source: 'premoderation',
      chatId: row.chat_id
    }
  );
  if (settings.adminUserId) {
    const reasonText =
      reason === 'timeout'
        ? 'timeout'
        : reason === 'wrong_digit'
          ? `wrong answer${typeof selectedDigit === 'number' ? ` (${selectedDigit} instead of ${row.correct_digit})` : ''}`
          : 'expired click';
    const lines = [
      'Pre-moderation ban',
      `User: ${userLabel} ${usernamePart}`,
      `Reason: ${reasonText}`,
      `Ban: ${banRes.ok ? 'ok' : `fail${banRes.description ? ` (${banRes.description})` : ''}`}`
    ];
    const buttons =
      logId && Number.isFinite(logId)
        ? [[{ text: 'Unban', callback_data: `lg_unban:${logId}` }]]
        : [];
    await sendAdminMessage(settings.token, settings.adminUserId, lines.join('\n'), buttons);
  }
}

async function resolvePremoderationSuccess(
  db: D1Database,
  settings: RuntimeSettings,
  row: PremodChallengeRow
): Promise<{ ok: boolean; error?: string }> {
  if (row.status !== 'pending') return { ok: false, error: 'already processed' };
  const nowIso = new Date().toISOString();

  const unmuteRes = await restoreUserPermissions(settings.token, settings.chatId, row.user_id);
  if (!unmuteRes.ok) return { ok: false, error: unmuteRes.description ?? 'failed to remove restriction' };

  await db
    .prepare('UPDATE premoderation_challenges SET status = ?, resolved_at = ? WHERE id = ?')
    .bind('passed', nowIso, row.id)
    .run();
  if (row.captcha_message_id) {
    const mention = buildUserMention(row.user_id, row.username, row.first_name);
    await editMessageText(
      settings.token,
      settings.chatId,
      row.captcha_message_id,
      `✅ ${mention.html}, перевірку пройдено. Ласкаво просимо!`,
      [],
      'HTML'
    );
  }
  await logAction(
    db,
    'premod_passed',
    row.user_id,
    `pre-moderation passed for ${userLabelFromRow(row)}${row.username ? ` (@${row.username})` : ''}`,
    {
      user: {
        id: row.user_id,
        username: row.username ?? undefined,
        firstName: row.first_name ?? undefined,
        lastName: row.last_name ?? undefined
      },
      source: 'premoderation',
      chatId: row.chat_id
    }
  );
  return { ok: true };
}

async function processExpiredPremoderationChallenges(db: D1Database, settings: RuntimeSettings): Promise<void> {
  if (!settings.premoderationEnabled) return;
  const rows = await db
    .prepare(
      `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
       FROM premoderation_challenges
       WHERE status = 'pending' AND chat_id = ? AND expires_at <= ?
       ORDER BY id ASC
       LIMIT 10`
    )
    .bind(settings.chatId, new Date().toISOString())
    .all<PremodChallengeRow>();
  for (const row of rows.results ?? []) {
    await resolvePremoderationFailure(db, settings, row, 'timeout');
    if (row.captcha_message_id) {
      await editMessageText(settings.token, settings.chatId, row.captcha_message_id, '⛔ Час перевірки вичерпано.', []);
    }
  }
}

async function cleanupJoinMessagesForUser(
  db: D1Database,
  token: string,
  chatId: string,
  userId: number
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT id, join_message_id
       FROM premoderation_challenges
       WHERE chat_id = ? AND user_id = ? AND join_message_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 10`
    )
    .bind(chatId, userId)
    .all<{ id: number; join_message_id: number | null }>();
  for (const row of rows.results ?? []) {
    if (!row.join_message_id) continue;
    await deleteMessage(token, chatId, row.join_message_id);
    await db.prepare('UPDATE premoderation_challenges SET join_message_id = NULL WHERE id = ?').bind(row.id).run();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedulePremoderationTimeout(
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
  db: D1Database,
  chatId: string,
  challengeToken: string,
  timeoutSec: number
): void {
  executionCtx.waitUntil(
    (async () => {
      await sleep(Math.max(1, timeoutSec) * 1000);
      const settings = await getRuntimeSettings(db);
      if (!settings || settings.chatId !== chatId) return;
      const row = await db
        .prepare(
          `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
           FROM premoderation_challenges
           WHERE challenge_token = ?`
        )
        .bind(challengeToken)
        .first<PremodChallengeRow>();
      if (!row || row.status !== 'pending') return;
      if (row.expires_at > new Date().toISOString()) return;
      await resolvePremoderationFailure(db, settings, row, 'timeout');
      if (row.captcha_message_id) {
        await editMessageText(settings.token, settings.chatId, row.captcha_message_id, '⛔ Час перевірки вичерпано.', []);
      }
    })()
  );
}

async function startPremoderationForUser(
  db: D1Database,
  settings: RuntimeSettings,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
  user: { id: number; username?: string; first_name?: string; last_name?: string; is_bot?: boolean },
  joinMessageId?: number
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (!settings.premoderationEnabled) return { ok: true, skipped: 'premoderation_disabled' };
  if (user.is_bot) return { ok: true, skipped: 'bot_user' };
  if (await isAdmin(db, settings.token, settings.chatId, user.id)) return { ok: true, skipped: 'admin_user' };

  const existing = await db
    .prepare(
      `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
       FROM premoderation_challenges
       WHERE chat_id = ? AND user_id = ? AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(settings.chatId, user.id)
    .first<PremodChallengeRow>();
  if (existing) return { ok: true, skipped: 'already_pending' };

  const restrictRes = await restrictUserReadOnly(settings.token, settings.chatId, user.id);
  if (!restrictRes.ok) {
    return { ok: false, error: restrictRes.description ?? 'failed to restrict user' };
  }

  const correctDigit = PREMOD_MIN_NUMBER + randomInt(PREMOD_MAX_NUMBER - PREMOD_MIN_NUMBER + 1);
  const digits = new Set<number>([correctDigit]);
  while (digits.size < 4) {
    digits.add(PREMOD_MIN_NUMBER + randomInt(PREMOD_MAX_NUMBER - PREMOD_MIN_NUMBER + 1));
  }
  const options = shuffled(Array.from(digits));
  const challengeToken = crypto.randomUUID();
  const timeoutSec = Math.max(10, Math.min(300, Math.floor(settings.premoderationTimeoutSec || DEFAULT_PREMODERATION_TIMEOUT_SEC)));
  const expiresAt = new Date(Date.now() + timeoutSec * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO premoderation_challenges(
        chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, expires_at
      ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?)`
    )
    .bind(
      settings.chatId,
      user.id,
      user.username ?? '',
      user.first_name ?? '',
      user.last_name ?? '',
      joinMessageId ?? null,
      challengeToken,
      correctDigit,
      expiresAt
    )
    .run();

  const row = await db
    .prepare(
      `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
       FROM premoderation_challenges
       WHERE challenge_token = ?`
    )
    .bind(challengeToken)
    .first<PremodChallengeRow>();
  if (!row) return { ok: false, error: 'challenge insert failed' };

  const { html, plain } = buildPremoderationPrompt(
    settings.premoderationPrompt,
    user.id,
    user.username,
    user.first_name,
    correctDigit,
    timeoutSec
  );
  const sendRes = await telegramApi<{ message_id: number }>(settings.token, 'sendMessage', {
    chat_id: settings.chatId,
    text: html,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [options.map((digit) => ({ text: String(digit), callback_data: `pm:${challengeToken}:${digit}` }))]
    }
  });

  if (!sendRes.ok || !sendRes.result?.message_id) {
    await restoreUserPermissions(settings.token, settings.chatId, user.id);
    await db.prepare('DELETE FROM premoderation_challenges WHERE id = ?').bind(row.id).run();
    return { ok: false, error: sendRes.description ?? 'failed to send captcha message' };
  }

  await db
    .prepare('UPDATE premoderation_challenges SET captcha_message_id = ? WHERE id = ?')
    .bind(sendRes.result.message_id, row.id)
    .run();
  await logAction(
    db,
    'premod_started',
    user.id,
    `pre-moderation started for ${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() +
      `${user.username ? ` (@${user.username})` : ''}; challenge: ${plain}`,
    {
      user: {
        id: user.id,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name
      },
      source: 'premoderation',
      chatId: settings.chatId,
      messageId: sendRes.result.message_id
    }
  );
  schedulePremoderationTimeout(executionCtx, db, settings.chatId, challengeToken, timeoutSec);
  return { ok: true };
}

async function getRuntimeSettings(db: D1Database): Promise<RuntimeSettings | null> {
  const now = Date.now();
  if (RUNTIME_SETTINGS_CACHE.value && RUNTIME_SETTINGS_CACHE.expiresAt > now) {
    return RUNTIME_SETTINGS_CACHE.value;
  }

  const rows = await db
    .prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(
      'TELEGRAM_TOKEN',
      'CHAT_ID',
      'WEBHOOK_SECRET',
      'SOFT_SUSPICIOUS_KEYWORDS',
      'SAFE_MODE',
      'WEBHOOK_PATH_TOKEN',
      'ADMIN_USER_ID',
      'BOT_USERNAME',
      'PREMODERATION_ENABLED',
      'PREMODERATION_TIMEOUT_SEC',
      'PREMODERATION_PROMPT'
    )
    .all<{ key: string; value: string }>();

  const map = new Map<string, string>();
  for (const row of rows.results ?? []) map.set(row.key, row.value);

  const token = (map.get('TELEGRAM_TOKEN') ?? '').trim();
  const chatId = (map.get('CHAT_ID') ?? '').trim();
  const secret = (map.get('WEBHOOK_SECRET') ?? '').trim();
  const softKeywords = parseSoftKeywords(map.get('SOFT_SUSPICIOUS_KEYWORDS') ?? null);
  const safeMode = (map.get('SAFE_MODE') ?? '0').trim() === '1';
  const webhookPathToken = (map.get('WEBHOOK_PATH_TOKEN') ?? '').trim();
  const adminUserId = (map.get('ADMIN_USER_ID') ?? '').trim();
  const botUsername = (map.get('BOT_USERNAME') ?? '').trim().toLowerCase();
  const premoderationEnabled = (map.get('PREMODERATION_ENABLED') ?? '0').trim() === '1';
  const premoderationTimeoutSecRaw = Number((map.get('PREMODERATION_TIMEOUT_SEC') ?? '').trim());
  const premoderationTimeoutSec =
    Number.isFinite(premoderationTimeoutSecRaw) && premoderationTimeoutSecRaw > 0
      ? Math.max(10, Math.min(300, Math.floor(premoderationTimeoutSecRaw)))
      : DEFAULT_PREMODERATION_TIMEOUT_SEC;
  const premoderationPrompt = (map.get('PREMODERATION_PROMPT') ?? '').trim() || DEFAULT_PREMODERATION_PROMPT;

  if (!token || !chatId || !secret || !webhookPathToken) {
    RUNTIME_SETTINGS_CACHE.value = null;
    RUNTIME_SETTINGS_CACHE.expiresAt = now + 30_000;
    return null;
  }

  const value: RuntimeSettings = {
    token,
    chatId,
    secret,
    softKeywords,
    safeMode,
    webhookPathToken,
    adminUserId,
    botUsername,
    premoderationEnabled,
    premoderationTimeoutSec,
    premoderationPrompt
  };
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
): Promise<{ action: string; logId: number | null }> {
  await cleanupJoinMessagesForUser(db, token, chatId, userId);
  const deleteResp = await telegramApi<boolean>(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  const banResp = await telegramApi<boolean>(token, 'banChatMember', { chat_id: chatId, user_id: userId, revoke_messages: true });

  const action = deleteResp.ok && banResp.ok ? 'ban_delete' : 'ban_delete_partial';
  const status = `delete=${deleteResp.ok ? 'ok' : 'fail'} ban=${banResp.ok ? 'ok' : 'fail'}`;
  const logId = await logAction(db, action, userId, `${details} (${status})`, { ...meta, source });
  return { action, logId };
}

async function upsertCoreSettings(
  db: D1Database,
  token: string,
  chatId: string,
  workerUrl: string
): Promise<{ secret: string; webhook: TelegramResponse<boolean>; webhookPathToken: string }> {
  await setSetting(db, 'TELEGRAM_TOKEN', token);
  await setSetting(db, 'CHAT_ID', chatId);
  const botUsername = await getBotUsername(token);
  await setSetting(db, 'BOT_USERNAME', botUsername);

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

async function banDeleteQuarantineById(
  db: D1Database,
  settings: RuntimeSettings,
  id: number
): Promise<{ ok: boolean; error?: string }> {
  const row = await db
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
  if (!row) return { ok: false, error: 'not found' };

  const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  const details = `manual review ban-delete user ${fullName || row.user_id}${row.username ? ` (@${row.username})` : ''}; text: ${row.text}`;

  if (settings.safeMode) {
    await logAction(db, 'dry_run_manual_review', row.user_id, `SAFE MODE: would ban/delete from review queue; ${details}`, {
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
    });
    await db.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();
    return { ok: true };
  }

  await banAndDelete(db, settings.token, settings.chatId, row.message_id, row.user_id, 'manual_review', details, {
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
  await db.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();
  return { ok: true };
}

async function approveQuarantineById(db: D1Database, id: number): Promise<{ ok: boolean; error?: string }> {
  const existing = await db.prepare('SELECT id FROM quarantine WHERE id = ?').bind(id).first<{ id: number }>();
  if (!existing) return { ok: false, error: 'not found' };
  await db.prepare('DELETE FROM quarantine WHERE id = ?').bind(id).run();
  await logAction(db, 'quarantine_approved', null, `approved quarantine id ${id}`);
  return { ok: true };
}

async function unbanFromLogById(
  db: D1Database,
  settings: RuntimeSettings,
  id: number,
  source: 'dashboard' | 'telegram_callback'
): Promise<{ ok: boolean; error?: string }> {
  const row = await db
    .prepare('SELECT id, action, user_id, details, meta_json FROM logs WHERE id = ?')
    .bind(id)
    .first<{ id: number; action: string; user_id: number | null; details: string | null; meta_json: string | null }>();
  if (!row) return { ok: false, error: 'not found' };
  if (row.action !== 'ban_delete' && row.action !== 'ban_delete_partial' && row.action !== 'premod_failed') {
    return { ok: false, error: 'unban is only available for ban records' };
  }

  const userId = row.user_id;
  if (!userId) return { ok: false, error: 'no user id in this history item' };

  let meta: LogMeta = {};
  try {
    meta = row.meta_json ? (JSON.parse(row.meta_json) as LogMeta) : {};
  } catch {
    meta = {};
  }
  if (meta.unbannedAt) return { ok: true };

  const unbanRes = await telegramApi<boolean>(settings.token, 'unbanChatMember', {
    chat_id: settings.chatId,
    user_id: userId,
    only_if_banned: true
  });
  if (!unbanRes.ok) return { ok: false, error: unbanRes.description ?? 'unban failed' };

  const unbannedAt = new Date().toISOString();
  const mergedMeta: LogMeta = { ...meta, unbannedAt, unbannedBy: source };
  const cleanedDetails = (row.details ?? '').replace(/\s*\|\s*UNBANNED.*$/u, '').trim();
  const detailsWithNote = `${cleanedDetails} | UNBANNED at ${unbannedAt} via ${source}`;
  await db
    .prepare('UPDATE logs SET details = ?, meta_json = ? WHERE id = ?')
    .bind(detailsWithNote, JSON.stringify(mergedMeta), id)
    .run();
  return { ok: true };
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

  const update = await c.req.json<{
    message?: TelegramMessage;
    my_chat_member?: TelegramChatMemberUpdate;
    chat_member?: TelegramChatMemberUpdate;
    callback_query?: TelegramCallbackQuery;
  }>();
  await processExpiredPremoderationChallenges(db, settings);
  const callbackQuery = update.callback_query;
  if (callbackQuery?.id && callbackQuery.data) {
    const data = callbackQuery.data;
    if (data.startsWith('pm:')) {
      const [, challengeToken, selectedRaw] = data.split(':');
      const selectedDigit = Number(selectedRaw);
      if (!challengeToken || !Number.isFinite(selectedDigit)) {
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Невірна відповідь');
        return c.json({ ok: true, skipped: 'invalid_premod_callback' });
      }

      const row = await db
        .prepare(
          `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
           FROM premoderation_challenges
           WHERE challenge_token = ?`
        )
        .bind(challengeToken)
        .first<PremodChallengeRow>();
      if (!row) {
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Ця перевірка вже неактуальна');
        return c.json({ ok: true, skipped: 'premod_not_found' });
      }
      if (String(callbackQuery.from.id) !== String(row.user_id)) {
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Ця перевірка не для вас');
        return c.json({ ok: true, skipped: 'premod_wrong_user' });
      }
      if (row.status !== 'pending') {
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Вже оброблено');
        return c.json({ ok: true, skipped: 'premod_already_processed' });
      }
      if (row.expires_at <= new Date().toISOString()) {
        await resolvePremoderationFailure(db, settings, row, 'expired_click', selectedDigit);
        if (row.captcha_message_id) {
          await editMessageText(settings.token, settings.chatId, row.captcha_message_id, '⛔ Час перевірки вичерпано.', []);
        }
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Час вичерпано');
        return c.json({ ok: true, action: 'premod_failed_expired' });
      }

      if (selectedDigit !== row.correct_digit) {
        await resolvePremoderationFailure(db, settings, row, 'wrong_digit', selectedDigit);
        if (row.captcha_message_id) {
          await editMessageText(settings.token, settings.chatId, row.captcha_message_id, '⛔ Неправильна відповідь.', []);
        }
        await answerCallbackQuery(settings.token, callbackQuery.id, 'Неправильно');
        return c.json({ ok: true, action: 'premod_failed_wrong' });
      }

      const passResult = await resolvePremoderationSuccess(db, settings, row);
      await answerCallbackQuery(settings.token, callbackQuery.id, passResult.ok ? 'Перевірку пройдено' : passResult.error ?? 'failed');
      return c.json({ ok: passResult.ok, action: 'premod_pass', error: passResult.error });
    }

    if (!settings.adminUserId || String(callbackQuery.from.id) !== String(settings.adminUserId)) {
      await answerCallbackQuery(settings.token, callbackQuery.id, 'Only configured admin can use this action');
      return c.json({ ok: true, skipped: 'callback_not_admin' });
    }

    if (data.startsWith('qr_ban:')) {
      const id = Number(data.slice('qr_ban:'.length));
      const result = Number.isFinite(id) ? await banDeleteQuarantineById(db, settings, id) : { ok: false, error: 'invalid id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Done' : result.error ?? 'failed');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? 'Banned' : `Failed: ${result.error ?? 'failed'}`);
      return c.json({ ok: true, action: 'callback_qr_ban', result });
    }
    if (data.startsWith('qr_app:')) {
      const id = Number(data.slice('qr_app:'.length));
      const result = Number.isFinite(id) ? await approveQuarantineById(db, id) : { ok: false, error: 'invalid id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Approved' : result.error ?? 'failed');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? 'Approved' : `Failed: ${result.error ?? 'failed'}`);
      return c.json({ ok: true, action: 'callback_qr_app', result });
    }
    if (data.startsWith('lg_unban:')) {
      const id = Number(data.slice('lg_unban:'.length));
      const result = Number.isFinite(id)
        ? await unbanFromLogById(db, settings, id, 'telegram_callback')
        : { ok: false, error: 'invalid id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Unbanned' : result.error ?? 'failed');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? 'Unbanned' : `Failed: ${result.error ?? 'failed'}`);
      return c.json({ ok: true, action: 'callback_lg_unban', result });
    }

    await answerCallbackQuery(settings.token, callbackQuery.id, 'Unknown action');
    return c.json({ ok: true, skipped: 'unknown_callback_action' });
  }

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
  const memberUpdate = update.chat_member;
  if (memberUpdate?.chat?.id && String(memberUpdate.chat.id) === String(settings.chatId)) {
    const oldStatus = memberUpdate.old_chat_member?.status ?? '';
    const newStatus = memberUpdate.new_chat_member?.status ?? '';
    const joined = (oldStatus === 'left' || oldStatus === 'kicked') && (newStatus === 'member' || newStatus === 'restricted');
    const joinedUser = memberUpdate.new_chat_member?.user;
    if (joined && joinedUser) {
      const premodResult = await startPremoderationForUser(db, settings, c.executionCtx, joinedUser);
      if (!premodResult.ok) {
        await logAction(
          db,
          'premod_error',
          joinedUser.id,
          `failed to start pre-moderation for ${joinedUser.id}: ${premodResult.error ?? 'unknown error'}`,
          {
            user: {
              id: joinedUser.id,
              username: joinedUser.username,
              firstName: joinedUser.first_name,
              lastName: joinedUser.last_name
            },
            source: 'premoderation',
            chatId: String(memberUpdate.chat.id)
          }
        );
      }
      return c.json({ ok: true, action: 'premod_join_chat_member', result: premodResult });
    }
  }

  const message = update.message;
  if (!message) return c.json({ ok: true, skipped: 'no_message' });
  if (String(message.chat.id) !== String(settings.chatId)) return c.json({ ok: true, skipped: 'wrong_chat' });

  if (message.new_chat_members?.length) {
    await deleteMessage(settings.token, settings.chatId, message.message_id);
    const results = [];
    for (const member of message.new_chat_members) {
      const result = await startPremoderationForUser(db, settings, c.executionCtx, member, message.message_id);
      results.push({ userId: member.id, ...result });
      if (!result.ok) {
        await logAction(
          db,
          'premod_error',
          member.id,
          `failed to start pre-moderation for ${member.id}: ${result.error ?? 'unknown error'}`,
          {
            user: {
              id: member.id,
              username: member.username,
              firstName: member.first_name,
              lastName: member.last_name
            },
            source: 'premoderation',
            chatId: String(message.chat.id),
            messageId: message.message_id
          }
        );
      }
    }
    return c.json({ ok: true, action: 'premod_join_message', results });
  }

  if (message.left_chat_member) {
    await deleteMessage(settings.token, settings.chatId, message.message_id);
    return c.json({ ok: true, action: 'cleanup_left_member_message' });
  }

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

    const banResult = await banAndDelete(
      db,
      settings.token,
      settings.chatId,
      message.message_id,
      sender.id,
      'hard_match',
      `hard match by ${userLabel} ${usernamePart}; matched: ${hardMatchTerms.join(', ')}; text: ${text}`,
      { ...metaBase, matchedTerms: hardMatchTerms }
    );
    if (settings.adminUserId && banResult.logId) {
      await sendAdminMessage(
        settings.token,
        settings.adminUserId,
        `Hard match ban\nUser: ${userLabel} ${usernamePart}\nMatched: ${hardMatchTerms.join(', ')}\nMessage: ${text}`,
        [[{ text: 'Unban', callback_data: `lg_unban:${banResult.logId}` }]]
      );
    }
    return c.json({ ok: true, action: 'ban_delete', matchedTerms: hardMatchTerms });
  }

  const replied = message.reply_to_message;
  if (replied && hasBotMention(message, settings.botUsername)) {
    const reportedText = replied.text ?? replied.caption ?? '';
    const reporterMessage = (message.text ?? message.caption ?? '').trim();
    const reportedUser = replied.from;
    if (reportedText.trim() && reportedUser && !reportedUser.is_bot) {
      let quarantineId: number | null = null;
      const existingRow = await db
        .prepare('SELECT id FROM quarantine WHERE message_id = ? AND user_id = ?')
        .bind(replied.message_id, reportedUser.id)
        .first<{ id: number }>();

      if (existingRow?.id) {
        quarantineId = existingRow.id;
      } else {
        await db
          .prepare(
            'INSERT INTO quarantine(message_id, user_id, username, first_name, last_name, reporter_user_id, reporter_username, reporter_first_name, reporter_last_name, reporter_message, text) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
          )
          .bind(
            replied.message_id,
            reportedUser.id,
            reportedUser.username ?? '',
            reportedUser.first_name ?? '',
            reportedUser.last_name ?? '',
            sender.id,
            sender.username ?? '',
            sender.first_name ?? '',
            sender.last_name ?? '',
            reporterMessage,
            reportedText
          )
          .run();
        const row = await db
          .prepare('SELECT id FROM quarantine WHERE message_id = ? AND user_id = ?')
          .bind(replied.message_id, reportedUser.id)
          .first<{ id: number }>();
        quarantineId = row?.id ?? null;
      }

      const reporterLabel = `${sender.first_name ?? ''} ${sender.last_name ?? ''}`.trim() || String(sender.id);
      const reporterUsername = sender.username ? `(@${sender.username})` : '(no username)';
      const targetLabel = `${reportedUser.first_name ?? ''} ${reportedUser.last_name ?? ''}`.trim() || String(reportedUser.id);
      const targetUsername = reportedUser.username ? `(@${reportedUser.username})` : '(no username)';

      await logAction(
        db,
        'quarantine_report',
        reportedUser.id,
        `user report by ${reporterLabel} ${reporterUsername}; target ${targetLabel} ${targetUsername}; text: ${reportedText}`,
        {
          messageText: reportedText,
          matchedTerms: ['[user_report]'],
          user: {
            id: reportedUser.id,
            username: reportedUser.username,
            firstName: reportedUser.first_name,
            lastName: reportedUser.last_name
          },
          reporter: {
            id: sender.id,
            username: sender.username,
            firstName: sender.first_name,
            lastName: sender.last_name
          },
          reporterMessage,
          messageId: replied.message_id,
          chatId: String(message.chat.id),
          source: 'user_report'
        }
      );

      if (settings.adminUserId && quarantineId) {
        await sendAdminMessage(
          settings.token,
          settings.adminUserId,
          `Spam report\nReported by: ${reporterLabel} ${reporterUsername}\nReport text: ${reporterMessage || '(empty)'}\nTarget: ${targetLabel} ${targetUsername}\nMessage: ${reportedText}`,
          [
            [
              { text: 'Ban & Delete', callback_data: `qr_ban:${quarantineId}` },
              { text: 'Approve', callback_data: `qr_app:${quarantineId}` }
            ]
          ]
        );
      }
      return c.json({ ok: true, action: 'quarantine_report' });
    }
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
  const quarantineRow = await db
    .prepare('SELECT id FROM quarantine WHERE message_id = ? AND user_id = ?')
    .bind(message.message_id, sender.id)
    .first<{ id: number }>();
  await logAction(
    db,
    'quarantine',
    sender.id,
    `soft match by ${userLabel} ${usernamePart}; matched: ${softTerms.join(', ') || 'none'}; text: ${text}`,
    { ...metaBase, matchedTerms: softTerms, softLinkMatch: softMatch.softLinkMatch, source: 'soft_match' }
  );
  if (settings.adminUserId && quarantineRow?.id) {
    await sendAdminMessage(
      settings.token,
      settings.adminUserId,
      `Review queue item\nUser: ${userLabel} ${usernamePart}\nMatched: ${softTerms.join(', ') || 'none'}\nMessage: ${text}`,
      [
        [
          { text: 'Ban & Delete', callback_data: `qr_ban:${quarantineRow.id}` },
          { text: 'Approve', callback_data: `qr_app:${quarantineRow.id}` }
        ]
      ]
    );
  }
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
  const adminUserId = (await getSetting(db, 'ADMIN_USER_ID')) ?? '';
  const premoderationEnabled = (await getSetting(db, 'PREMODERATION_ENABLED')) === '1';
  const timeoutRaw = Number((await getSetting(db, 'PREMODERATION_TIMEOUT_SEC')) ?? '');
  const premoderationTimeoutSec =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.max(10, Math.min(300, Math.floor(timeoutRaw)))
      : DEFAULT_PREMODERATION_TIMEOUT_SEC;
  const premoderationPrompt = (await getSetting(db, 'PREMODERATION_PROMPT')) || DEFAULT_PREMODERATION_PROMPT;
  return c.json({
    ok: true,
    data: {
      token: token ?? '',
      chatId: chatId ?? '',
      workerUrl: workerUrl ?? '',
      softKeywords,
      safeMode,
      webhookPath: webhookPathToken ? `/webhook/${webhookPathToken}` : '',
      adminUserId,
      premoderationEnabled,
      premoderationTimeoutSec,
      premoderationPrompt
    }
  });
});

app.post('/admin/api/settings', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ token?: string; chatId?: string; adminUserId?: string }>();
  const token = (body.token ?? '').trim();
  const chatId = (body.chatId ?? '').trim();
  const adminUserId = (body.adminUserId ?? '').trim();
  if (!token || !chatId) return jsonError('token and chatId are required');
  if (!/^-?\d+$/u.test(chatId)) return jsonError('chatId must be numeric');
  if (adminUserId && !/^\d+$/u.test(adminUserId)) return jsonError('adminUserId must be numeric');

  const workerUrl = new URL(c.req.url).origin;
  const { webhook, webhookPathToken } = await upsertCoreSettings(db, token, chatId, workerUrl);
  await setSetting(db, 'ADMIN_USER_ID', adminUserId);
  await logAction(db, 'settings_updated', null, `chat ${chatId}, webhook ${webhook.ok ? 'ok' : 'failed'}`);

  return c.json({
    ok: true,
    data: {
      webhookOk: webhook.ok,
      webhookDescription: webhook.description ?? '',
      webhookPath: `/webhook/${webhookPathToken}`,
      adminUserId
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

app.post('/admin/api/settings/premoderation', async (c) => {
  const body = await c.req.json<{ enabled?: boolean; timeoutSec?: number; prompt?: string }>();
  const timeoutRaw = Number(body.timeoutSec ?? DEFAULT_PREMODERATION_TIMEOUT_SEC);
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 10 || timeoutRaw > 300) {
    return jsonError('timeoutSec must be in range 10..300');
  }
  const timeoutSec = Math.floor(timeoutRaw);
  const prompt = String(body.prompt ?? '').trim() || DEFAULT_PREMODERATION_PROMPT;
  if (prompt.length > 1000) return jsonError('prompt is too long');

  await setSetting(c.env.DB, 'PREMODERATION_ENABLED', body.enabled ? '1' : '0');
  await setSetting(c.env.DB, 'PREMODERATION_TIMEOUT_SEC', String(timeoutSec));
  await setSetting(c.env.DB, 'PREMODERATION_PROMPT', prompt);
  await logAction(
    c.env.DB,
    'premod_settings_updated',
    null,
    `pre-moderation ${body.enabled ? 'enabled' : 'disabled'}; timeout ${timeoutSec}s`
  );
  return c.json({ ok: true, data: { enabled: !!body.enabled, timeoutSec, prompt } });
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
        'SELECT id, message_id, user_id, username, first_name, last_name, reporter_user_id, reporter_username, reporter_first_name, reporter_last_name, reporter_message, text, timestamp FROM quarantine ORDER BY id DESC LIMIT ? OFFSET ?'
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
  const result = await banDeleteQuarantineById(c.env.DB, settings, id);
  if (!result.ok) return jsonError(result.error ?? 'failed', result.error === 'not found' ? 404 : 400);
  return c.json({ ok: true });
});

app.post('/admin/api/quarantine/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return jsonError('invalid id');
  const result = await approveQuarantineById(c.env.DB, id);
  if (!result.ok) return jsonError(result.error ?? 'failed', result.error === 'not found' ? 404 : 400);
  return c.json({ ok: true });
});

app.get('/admin/api/logs', async (c) => {
  const { page, pageSize, offset } = parsePagination(c.req.raw, 20, 100);
  const includeSystem = new URL(c.req.url).searchParams.get('includeSystem') === '1';

  const filterSql = includeSystem
    ? ''
    : `WHERE action NOT IN ('settings_updated', 'blacklist_add', 'blacklist_delete', 'soft_keywords_updated', 'premod_settings_updated', 'log_deleted')`;

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
  const result = await unbanFromLogById(c.env.DB, settings, id, 'dashboard');
  if (!result.ok) return jsonError(result.error ?? 'failed', result.error === 'not found' ? 404 : 400);
  return c.json({ ok: true });
});

const ADMIN_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegram Anti-Spam Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
      body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 0; }
      .glass-panel { background: rgba(30, 41, 59, 0.6); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
      .card-row { background: rgba(15, 23, 42, 0.4); border: 1px solid rgba(255, 255, 255, 0.05); }
      .btn { transition: background-color 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; }
      .btn:hover { opacity: 0.9; box-shadow: 0 0 10px rgba(255,255,255,0.1); }
      .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .input-field { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255, 255, 255, 0.15); color: #f8fafc; transition: border-color 0.2s ease, box-shadow 0.2s ease; }
      .input-field:focus { outline: none; border-color: #818cf8; box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.2); }
      .input-field::placeholder { color: #475569; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      .checkbox-custom { accent-color: #818cf8; width: 1.125rem; height: 1.125rem; cursor: pointer; background-color: transparent; }
      .gradient-text { background: linear-gradient(to right, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      
      /* Navigation Tabs */
      .nav-tab {
        display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 1rem; border-radius: 0.75rem;
        color: #94a3b8; font-weight: 500; cursor: pointer; transition: all 0.2s ease; border: 1px solid transparent;
      }
      .nav-tab:hover { background: rgba(255,255,255,0.05); color: #f8fafc; }
      .nav-tab.active { background: rgba(99, 102, 241, 0.15); color: #818cf8; border-color: rgba(99, 102, 241, 0.3); }
      .nav-tab svg { width: 1.25rem; height: 1.25rem; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      
      .tab-section { display: none; animation: fadeIn 0.3s ease-out; flex: 1; flex-direction: column; overflow: hidden; }
      .tab-section.active { display: flex; }
      
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    </style>
  </head>
  <body class="min-h-screen relative overflow-x-hidden flex flex-col">
    <!-- Subtle Background Glows -->
    <div class="fixed top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
      <div class="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-indigo-900/30 blur-[120px]"></div>
      <div class="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-900/20 blur-[120px]"></div>
    </div>

    <main class="max-w-7xl mx-auto p-4 md:p-6 space-y-6 relative z-10 w-full flex-1 flex flex-col h-screen">
      <!-- Header -->
      <header class="flex flex-col md:flex-row md:items-center justify-between gap-4 glass-panel rounded-2xl p-4 md:px-6 flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="p-2 bg-indigo-500/20 rounded-xl border border-indigo-500/30 text-indigo-400">
            <svg class="w-6 h-6" viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" fill="currentColor"/></svg>
          </div>
          <h1 class="text-2xl font-bold tracking-tight gradient-text">Anti-Spam Shield</h1>
        </div>
        <div class="flex items-center gap-3">
          <span id="safeModeBadge" class="hidden px-3 py-1 rounded-full text-xs font-bold bg-amber-400/20 text-amber-400 border border-amber-400/30 shadow-[0_0_15px_rgba(251,191,36,0.1)]">SAFE MODE ON</span>
          <button id="refreshBtn" class="btn px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-600 transition-colors">
            <svg class="w-4 h-4 mr-2 inline" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            Refresh
          </button>
          <button id="logoutBtn" class="btn px-4 py-2 bg-rose-600/80 hover:bg-rose-500 text-white rounded-lg border border-rose-500/50">
            <svg class="w-4 h-4 mr-2 inline" stroke="currentColor" viewBox="0 0 24 24"><path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
            Logout
          </button>
        </div>
      </header>

      <!-- Main Workspace -->
      <div class="flex flex-col lg:flex-row gap-6 flex-1 min-h-0 overflow-hidden">
        
        <!-- Sidebar Navigation -->
        <nav class="glass-panel w-full lg:w-64 flex-shrink-0 rounded-2xl p-3 flex flex-col gap-1 lg:overflow-y-auto">
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-2 mb-1">Dashboard</div>
          
          <button class="nav-tab active" data-target="queue">
            <svg viewBox="0 0 24 24"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            Review Queue
            <span id="badge-queue" class="hidden ml-auto px-2 py-0.5 text-[10px] font-bold bg-amber-500 text-amber-950 rounded-full shadow-[0_0_8px_rgba(245,158,11,0.4)]"></span>
          </button>
          
          <button class="nav-tab" data-target="history">
            <svg viewBox="0 0 24 24"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            Action History
            <span id="badge-history" class="hidden ml-auto px-2 py-0.5 text-[10px] font-bold bg-blue-500 text-blue-950 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.4)]"></span>
          </button>
          
          <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-2 mt-4 mb-1 border-t border-slate-700/50 pt-4">Configuration</div>
          
          <button class="nav-tab" data-target="blacklist">
             <svg viewBox="0 0 24 24"><path d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
             Blacklist & Words
          </button>

          <button class="nav-tab" data-target="settings">
            <svg viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
            System Setup
          </button>
        </nav>

        <!-- Content Area -->
        <div class="glass-panel flex-1 rounded-2xl flex flex-col overflow-hidden relative">
          
          <!-- TAB: Review Queue -->
          <section id="tab-queue" class="tab-section active p-6">
            <h2 class="text-xl font-semibold mb-6 flex items-center gap-2">
              <span class="text-amber-400">Review Queue</span>
            </h2>
            <div class="flex-1 overflow-y-auto pr-2 space-y-3" id="quarantineList"></div>
            <div id="quarantinePager" class="flex-shrink-0 mt-4 pt-4 border-t border-slate-700/50 flex items-center justify-between gap-2 text-sm text-slate-400"></div>
          </section>

          <!-- TAB: Action History -->
          <section id="tab-history" class="tab-section p-6">
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 flex-shrink-0">
              <h2 class="text-xl font-semibold flex items-center gap-2">
                <span class="text-blue-400">Action History</span>
              </h2>
              <label class="flex items-center gap-2 text-sm px-3 py-1.5 bg-slate-800/50 rounded-lg border border-slate-700/50 cursor-pointer transition hover:bg-slate-700/50">
                <input id="includeSystemLogs" type="checkbox" class="checkbox-custom" />
                <span class="text-slate-300">Show System Logs</span>
              </label>
            </div>
            <div class="flex-1 overflow-y-auto pr-2 space-y-3 text-sm" id="logsList"></div>
            <div id="logsPager" class="flex-shrink-0 mt-4 pt-4 border-t border-slate-700/50 flex items-center justify-between gap-2 text-sm text-slate-400"></div>
          </section>

          <!-- TAB: Blacklist & Moderation -->
          <section id="tab-blacklist" class="tab-section p-6 overflow-y-auto">
            <h2 class="text-xl font-semibold mb-6 flex items-center gap-2">
              <span class="text-emerald-400">Filters & Moderation</span>
            </h2>

            <!-- Blacklist Manager -->
            <div class="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5 mb-8">
              <h3 class="text-lg font-medium text-slate-200 mb-4">Blacklist Manager</h3>
              <p class="text-sm text-slate-400 mb-4">Add exact phrases or regular expressions. Any matching messages will be automatically rejected or quarantined.</p>
              
              <div class="flex flex-col sm:flex-row gap-3 mb-6">
                <input id="pattern" class="input-field flex-1 rounded-lg p-3 text-sm" placeholder="Enter word, phrase, or regex..." />
                <div class="flex items-center gap-4 shrink-0">
                  <label class="flex items-center gap-2 cursor-pointer bg-slate-900/50 px-3 py-3 rounded-lg border border-slate-700/50">
                    <input id="isRegex" type="checkbox" class="checkbox-custom" />
                    <span class="text-sm text-slate-300 font-medium">Use Regex</span>
                  </label>
                  <button id="addPattern" class="btn px-6 py-3 bg-emerald-600 text-white rounded-lg shadow-lg shadow-emerald-600/20 whitespace-nowrap">Add Rule</button>
                </div>
              </div>
              
              <div class="bg-slate-900/50 rounded-lg border border-slate-700/50 flex flex-col h-[300px]">
                <div class="p-3 border-b border-slate-700/50 flex text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <div class="flex-1">Pattern</div>
                  <div class="w-24 text-center">Type</div>
                  <div class="w-20 text-right pr-2">Action</div>
                </div>
                <div id="blacklistList" class="flex-1 overflow-y-auto p-2 space-y-1"></div>
              </div>
              <div id="blacklistPager" class="mt-4 flex items-center justify-between text-sm text-slate-400"></div>
            </div>

            <!-- Soft Keywords -->
            <div class="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
              <h3 class="text-lg font-medium text-slate-200 mb-4">Soft Keywords</h3>
              <p class="text-sm text-slate-400 mb-4">Messages matching these words won't be outright banned if Safe Mode is disabled, but will trigger quarantine review.</p>
              
              <textarea
                id="softKeywords"
                rows="6"
                class="input-field rounded-lg p-4 w-full text-sm leading-relaxed mb-4 font-mono text-slate-300"
                placeholder="заработ\nбыстрые деньги\n..."
              ></textarea>
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <input id="safeMode" type="checkbox" class="checkbox-custom" />
                  <label for="safeMode" class="text-sm font-medium text-amber-200 cursor-pointer">Safe Mode (Simulate Only, Do not ban)</label>
                </div>
                <button id="saveModeration" class="btn px-6 py-2.5 bg-indigo-600 text-white rounded-lg shadow-lg shadow-indigo-600/20">Save Moderation Settings</button>
              </div>
            </div>
          </section>

          <!-- TAB: System Settings -->
          <section id="tab-settings" class="tab-section p-6 overflow-y-auto">
            <h2 class="text-xl font-semibold mb-6 flex items-center gap-2">
              <span class="text-indigo-400">System Setup</span>
            </h2>

            <!-- Core Setup -->
            <div class="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5 mb-8">
              <h3 class="text-lg font-medium text-slate-200 mb-4">Telegram Bot Settings</h3>
              
              <div class="space-y-4 mb-6">
                <div>
                  <label class="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Bot Token</label>
                  <input id="token" class="input-field rounded-lg p-3 w-full text-sm font-mono" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                  <p class="text-[11px] text-slate-500 mt-1">Get this from @BotFather</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label class="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Target Chat ID</label>
                    <input id="chatId" class="input-field rounded-lg p-3 w-full text-sm font-mono" placeholder="-1001234567890" />
                  </div>
                  <div>
                    <label class="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Admin User ID</label>
                    <input id="adminUserId" class="input-field rounded-lg p-3 w-full text-sm font-mono" placeholder="123456789" />
                  </div>
                </div>
              </div>
              
              <div class="flex items-center justify-between border-t border-slate-700/50 pt-4">
                <div id="webhookPathInfo" class="text-sm text-indigo-300 font-mono flex-1 truncate pr-4"></div>
                <button id="saveSettings" class="btn px-6 py-2.5 bg-indigo-600 text-white rounded-lg shadow-lg shadow-indigo-600/20 shrink-0">Save & Set Webhook</button>
              </div>
            </div>

            <!-- Pre-Moderation Setup -->
            <div class="bg-slate-800/40 border border-slate-700/50 rounded-xl p-5">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-medium text-slate-200">Pre-Moderation (Captcha)</h3>
                <label class="flex items-center gap-2 cursor-pointer bg-teal-500/10 px-3 py-1.5 rounded-lg border border-teal-500/20">
                  <input id="premoderationEnabled" type="checkbox" class="checkbox-custom accent-teal-500" />
                  <span class="text-sm font-medium text-teal-300">Enable Captcha</span>
                </label>
              </div>
              <p class="text-sm text-slate-400 mb-5">Force new users to pass a basic verification challenge before they can send messages.</p>
              
              <div class="space-y-4 mb-6">
                <div>
                  <label class="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Timeout (Seconds)</label>
                  <input id="premoderationTimeoutSec" type="number" min="10" max="300" class="input-field rounded-lg p-3 w-full md:w-48 text-sm" placeholder="30" />
                </div>
                <div>
                  <label for="premoderationPrompt" class="block text-xs font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">Captcha Prompt Message</label>
                  <div class="text-[11px] text-slate-400 mb-2 font-mono">Available variables: {user}, {digit}, {seconds}</div>
                  <textarea id="premoderationPrompt" rows="4" class="input-field rounded-lg p-3 w-full text-sm leading-relaxed" placeholder="Вітаємо, {user}! Для перевірки оберіть цифру {digit} протягом {seconds} сек."></textarea>
                </div>
              </div>

              <div class="flex justify-end border-t border-slate-700/50 pt-4">
                <button id="savePremoderation" class="btn px-6 py-2.5 bg-teal-600 text-white rounded-lg shadow-lg shadow-teal-600/20 shrink-0">Save Captcha Settings</button>
              </div>
            </div>

          </section>
        </div>
      </div>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const state = {
        blacklistPage: 1,
        quarantinePage: 1,
        logsPage: 1,
        pageSize: 50,
        topQueueId: 0,
        topHistoryId: 0
      };
      const memSeen = { queue: 0, history: 0 };

      function readSeen(key) {
        try {
          const raw = localStorage.getItem(key);
          const parsed = Number.parseInt(raw || '0', 10);
          return Number.isFinite(parsed) ? parsed : 0;
        } catch {
          return key === 'lastSeenQueueId' ? memSeen.queue : memSeen.history;
        }
      }

      function writeSeen(key, value) {
        const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
        if (key === 'lastSeenQueueId') memSeen.queue = safe;
        if (key === 'lastSeenHistoryId') memSeen.history = safe;
        try {
          localStorage.setItem(key, String(safe));
        } catch {
          // Ignore storage failures.
        }
      }

      // --- Tab Navigation Logic ---
      document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          // Remove active from all tabs and sections
          document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
          
          // Add active to clicked tab and corresponding section
          const target = e.currentTarget;
          target.classList.add('active');
          const targetId = 'tab-' + target.dataset.target;
          const section = $(targetId);
          if (section) section.classList.add('active');
          
          // Clear badges and track seen
          if (target.dataset.target === 'queue') {
            $('badge-queue').classList.add('hidden');
            if (state.topQueueId) writeSeen('lastSeenQueueId', state.topQueueId);
          } else if (target.dataset.target === 'history') {
            $('badge-history').classList.add('hidden');
            if (state.topHistoryId) writeSeen('lastSeenHistoryId', state.topHistoryId);
          }
        });
      });

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
        div.className = 'card-row rounded-xl p-4 transition duration-300 hover:bg-slate-800/60';
        div.innerHTML = content;
        return div;
      }

      function parseMeta(metaJson) {
        if (!metaJson) return null;
        try { return JSON.parse(metaJson); } catch { return null; }
      }

      function highlightText(text, terms) {
        let highlighted = esc(text);
        if (!terms || !terms.length) return highlighted;
        const cleanedTerms = terms.filter(t => t && t !== '[link]').map(t => esc(t)).sort((a,b) => b.length - a.length);
        if (!cleanedTerms.length) return highlighted;
        for (const term of cleanedTerms) {
          highlighted = highlighted.split(term).join('<mark class="bg-amber-400/20 text-amber-300 px-1 rounded font-medium">' + term + '</mark>');
        }
        return highlighted;
      }

      function pager(rootId, paging, onPageChange) {
        const root = $(rootId);
        if (!root) return;
        if (!paging) { root.innerHTML = ''; return; }
        const prevDisabled = paging.page <= 1;
        const nextDisabled = paging.page >= paging.totalPages;

        root.innerHTML =
          '<div class="font-medium text-slate-300 hidden sm:block">Page <span class="text-white">' + paging.page + '</span> / ' + paging.totalPages + ' <span class="mx-2 opacity-50">|</span> Total: ' + paging.total + '</div>' +
          '<div class="flex gap-2 w-full sm:w-auto justify-between sm:justify-start">' +
          '<button class="pager-prev btn px-4 py-1.5 text-sm rounded-lg border border-slate-600 bg-slate-800/80 hover:bg-slate-700 text-slate-200" ' + (prevDisabled ? 'disabled' : '') + '>Previous</button>' +
          '<button class="pager-next btn px-4 py-1.5 text-sm rounded-lg border border-slate-600 bg-slate-800/80 hover:bg-slate-700 text-slate-200" ' + (nextDisabled ? 'disabled' : '') + '>Next</button>' +
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
        $('adminUserId').value = data.data.adminUserId || '';
        $('softKeywords').value = (data.data.softKeywords || []).join('\\n');
        $('safeMode').checked = !!data.data.safeMode;
        $('premoderationEnabled').checked = !!data.data.premoderationEnabled;
        $('premoderationTimeoutSec').value = String(data.data.premoderationTimeoutSec || 30);
        $('premoderationPrompt').value = data.data.premoderationPrompt || '';
        $('safeModeBadge').classList.toggle('hidden', !data.data.safeMode);
        $('webhookPathInfo').textContent = data.data.webhookPath ? 'Webhook active: ' + data.data.webhookPath : 'Webhook not configured';
      }

      async function saveSettings() {
        const data = await api('/admin/api/settings', {
          method: 'POST', body: JSON.stringify({ token: $('token').value, chatId: $('chatId').value, adminUserId: $('adminUserId').value })
        });
        if (data.data && data.data.webhookPath) $('webhookPathInfo').textContent = 'Webhook active: ' + data.data.webhookPath;
      }

      async function saveModeration() {
        await api('/admin/api/settings/moderation', {
          method: 'POST', body: JSON.stringify({ keywords: $('softKeywords').value, safeMode: $('safeMode').checked })
        });
        $('safeModeBadge').classList.toggle('hidden', !$('safeMode').checked);
      }

      async function savePremoderation() {
        await api('/admin/api/settings/premoderation', {
          method: 'POST', body: JSON.stringify({ enabled: $('premoderationEnabled').checked, timeoutSec: Number($('premoderationTimeoutSec').value || '30'), prompt: $('premoderationPrompt').value })
        });
      }

      async function loadBlacklist() {
        const data = await api('/admin/api/blacklist?page=' + state.blacklistPage + '&pageSize=' + state.pageSize);
        const root = $('blacklistList');
        root.innerHTML = '';
        
        if (data.data.length === 0) {
           root.innerHTML = '<div class="text-center py-6 text-slate-500">No filters added yet.</div>';
        }

        for (const row of data.data) {
          const el = document.createElement('div');
          el.className = 'flex items-center p-2 rounded bg-slate-800/40 border border-slate-700/30 hover:bg-slate-700/40 transition-colors';
          el.innerHTML = '<div class="flex-1 truncate text-sm pr-2 text-slate-200 font-mono" title="' + esc(row.pattern) + '">' + esc(row.pattern) + '</div>' + 
             '<div class="w-24 text-center"><span class="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded ' + (row.is_regex ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-700 text-slate-400') + '">' + (row.is_regex ? 'Regex' : 'Text') + '</span></div>' +
             '<div class="w-20 text-right"><button data-id="' + row.id + '" class="del-pattern p-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors" title="Delete"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="mx-auto" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg></button></div>';
          root.appendChild(el);
        }

        root.querySelectorAll('.del-pattern').forEach(btn => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/blacklist/' + btn.dataset.id, { method: 'DELETE' });
            await loadBlacklist();
            refreshHistory();
          });
        });

        pager('blacklistPager', data.paging, (page) => { state.blacklistPage = page; loadBlacklist().catch(e => alert(e.message)); });
      }

      async function addPattern() {
        if(!$('pattern').value.trim()) return;
        await api('/admin/api/blacklist', {
          method: 'POST', body: JSON.stringify({ pattern: $('pattern').value, isRegex: $('isRegex').checked })
        });
        $('pattern').value = '';
        $('isRegex').checked = false;
        state.blacklistPage = 1;
        await loadBlacklist();
        refreshHistory();
      }

      async function loadQuarantine() {
        const data = await api('/admin/api/quarantine?page=' + state.quarantinePage + '&pageSize=' + state.pageSize);
        const root = $('quarantineList');
        root.innerHTML = '';
        
        if (data.data.length > 0) {
          state.topQueueId = Math.max(...data.data.map(r => r.id));
          const tempLastSeen = readSeen('lastSeenQueueId');
          const queueTab = document.querySelector('[data-target="queue"]');
          if (queueTab && queueTab.classList.contains('active')) {
            writeSeen('lastSeenQueueId', state.topQueueId);
            $('badge-queue').classList.add('hidden');
          } else if (state.topQueueId > tempLastSeen) {
            const unseenCount = data.data.filter(r => r.id > tempLastSeen).length;
            $('badge-queue').textContent = unseenCount + (unseenCount === state.pageSize ? '+' : '');
            $('badge-queue').classList.remove('hidden');
          }
        }
        
        if (data.data.length === 0) {
           root.innerHTML = '<div class="text-center py-10 h-full flex flex-col items-center justify-center text-slate-500"><div class="p-4 bg-slate-800/50 rounded-full mb-3"><svg class="w-8 h-8 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg></div><p>Queue is empty. Everything looks good!</p></div>';
        }

        for (const row of data.data) {
          const safeText = esc(row.text || '');
          const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ');
          const namePart = fullName ? ' <span class="text-slate-300">' + esc(fullName) + '</span>' : '';
          const usernamePart = row.username ? ' <span class="text-indigo-300">@' + esc(row.username) + '</span>' : '';
          const reporterName = [row.reporter_first_name, row.reporter_last_name].filter(Boolean).join(' ');
          
          let reporterHtml = '';
          if (row.reporter_user_id) {
             reporterHtml = '<div class="mt-2 text-xs p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200 flex items-start gap-2"><svg class="w-4 h-4 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg><div><span class="font-semibold">Reported by:</span> ' + esc(reporterName || String(row.reporter_user_id)) + (row.reporter_username ? ' (@' + esc(row.reporter_username) + ')' : '') + (row.reporter_message ? '<div class="mt-1 opacity-80 italic">"' + esc(row.reporter_message) + '"</div>' : '') + '</div></div>';
          }

          const el = rowCard(
            '<div class="flex flex-col gap-3">' +
              '<div class="flex justify-between items-start">' +
                '<div class="text-sm font-medium text-slate-400 flex items-center flex-wrap gap-x-2"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>' +
                'ID: ' + row.user_id + usernamePart + namePart +
                '</div>' +
                '<div class="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded font-mono">MSG ' + row.message_id + '</div>' +
              '</div>' +
              reporterHtml +
              '<div class="text-slate-200 bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 text-sm break-words whitespace-pre-wrap leading-relaxed shadow-inner font-mono">' + safeText + '</div>' +
              '<div class="flex gap-3 mt-2">' +
                '<button data-id="' + row.id + '" class="ban-delete btn flex-1 py-2 text-sm text-rose-100 bg-rose-600/90 hover:bg-rose-600 rounded-lg shadow-lg shadow-rose-600/20 font-semibold border border-rose-500/50">' +
                  '<svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>' +
                  'Ban & Delete' +
                '</button>' +
                '<button data-id="' + row.id + '" class="approve btn flex-1 py-2 text-sm text-slate-200 bg-slate-700/80 hover:bg-slate-700 rounded-lg font-semibold border border-slate-600">' +
                  '<svg class="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' +
                  'Approve' +
                '</button>' +
              '</div>' +
            '</div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.ban-delete').forEach(btn => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/ban-delete', { method: 'POST' });
            await Promise.all([loadQuarantine(), loadLogs()]);
          });
        });

        root.querySelectorAll('.approve').forEach(btn => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/quarantine/' + btn.dataset.id + '/approve', { method: 'POST' });
            await Promise.all([loadQuarantine(), loadLogs()]);
          });
        });

        pager('quarantinePager', data.paging, (page) => {
          state.quarantinePage = page;
          loadQuarantine().catch(e => alert(e.message));
        });
      }

      function actionTitle(action) {
        const titles = { ban_delete: 'Ban & Delete', ban_delete_partial: 'Ban/Delete Partial', quarantine: 'Quarantine', quarantine_report: 'Spam Report', premod_started: 'Pre-Mod Started', premod_passed: 'Pre-Mod Passed', premod_failed: 'Pre-Mod Failed', premod_error: 'Pre-Mod Error', premod_settings_updated: 'Pre-Mod Config', unban: 'Unban' };
        return titles[action] || action;
      }

      function actionColor(action) {
        action = String(action || '');
        if (action.includes('error') || action.includes('failed') || action === 'ban_delete' || action === 'ban_delete_partial') return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
        if (action.includes('passed') || action === 'unban' || action === 'quarantine_approved') return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
        if (action.includes('quarantine')) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
      }

      async function loadLogs() {
        const includeSystem = $('includeSystemLogs').checked ? '1' : '0';
        const data = await api('/admin/api/logs?page=' + state.logsPage + '&pageSize=' + state.pageSize + '&includeSystem=' + includeSystem);
        const root = $('logsList');
        root.innerHTML = '';
        
        if (data.data.length > 0) {
          state.topHistoryId = Math.max(...data.data.map(r => r.id));
          const tempLastSeen = readSeen('lastSeenHistoryId');
          const historyTab = document.querySelector('[data-target="history"]');
          if (historyTab && historyTab.classList.contains('active')) {
            writeSeen('lastSeenHistoryId', state.topHistoryId);
            $('badge-history').classList.add('hidden');
          } else if (state.topHistoryId > tempLastSeen) {
            const unseenCount = data.data.filter(r => r.id > tempLastSeen).length;
            $('badge-history').textContent = unseenCount + (unseenCount === state.pageSize ? '+' : '');
            $('badge-history').classList.remove('hidden');
          }
        }

        if (data.data.length === 0) {
           root.innerHTML = '<div class="text-center py-10 h-full flex flex-col items-center justify-center text-slate-500"><div class="p-4 bg-slate-800/50 rounded-full mb-3"><svg class="w-8 h-8 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></div><p>No log history found.</p></div>';
        }

        for (const row of data.data) {
          const meta = parseMeta(row.meta_json);
          const messageText = meta?.messageText || '';
          const matchedTerms = meta?.matchedTerms || [];
          const userName = [meta?.user?.firstName, meta?.user?.lastName].filter(Boolean).join(' ');
          const userLine = meta?.user
            ? '<div class="text-slate-300 flex items-center gap-2"><svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg><span class="font-medium">' + esc(userName || String(meta.user.id)) + '</span>' + (meta.user.username ? ' <span class="text-indigo-300">@' + esc(meta.user.username) + '</span>' : '') + '</div>' : '';
            
          const reporterName = [meta?.reporter?.firstName, meta?.reporter?.lastName].filter(Boolean).join(' ');
          const reporterLine = meta?.reporter
             ? '<div class="mt-2 text-xs p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-200 flex items-start gap-2"><svg class="w-4 h-4 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg><div><span class="font-semibold">Reported by:</span> ' + esc(reporterName || String(meta.reporter.id)) + (meta.reporter.username ? ' (@' + esc(meta.reporter.username) + ')' : '') + (meta.reporterMessage ? '<div class="mt-1 opacity-80 italic">"' + esc(meta.reporterMessage) + '"</div>' : '') + '</div></div>' : '';

          const matchLine = matchedTerms.length ? '<div class="text-xs text-amber-300/80 mt-2 flex flex-wrap gap-1 items-center"><span class="font-semibold mr-1">Matched:</span> ' + matchedTerms.map(t => '<span class="px-1.5 py-0.5 bg-amber-500/20 rounded border border-amber-500/30 font-mono text-[10px]">' + esc(t) + '</span>').join('') + '</div>' : '';
          const messageLine = messageText ? '<div class="mt-3 text-slate-300"><div class="p-3 text-xs rounded-lg bg-slate-900/80 border border-slate-700/80 break-words whitespace-pre-wrap leading-relaxed font-mono">' + highlightText(messageText, matchedTerms) + '</div></div>' : '';
          const detailsLine = messageText ? '' : '<div class="mt-3 text-slate-400 text-xs italic bg-slate-900/40 p-2.5 rounded border border-slate-800">' + esc(row.details || '') + '</div>';
          const unbanLine = meta?.unbannedAt ? '<div class="mt-2 text-xs text-emerald-400 flex items-center gap-1.5 font-medium"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>Unbanned ' + (meta.unbannedBy ? ' by ' + esc(meta.unbannedBy) : 'manually') + '</div>' : '';

          const canUnban = (row.action === 'ban_delete' || row.action === 'ban_delete_partial' || row.action === 'premod_failed') && !meta?.unbannedAt;
          const date = new Date(row.timestamp);
          const timeStr = date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) + ' <span class="text-[10px] ml-1 opacity-70">' + date.toLocaleDateString([], {month: 'short', day: 'numeric'}) + '</span>';

          const el = rowCard(
            '<div class="flex flex-col gap-2">' +
              '<div class="flex items-start justify-between gap-3">' +
                '<div class="flex items-center gap-2">' +
                  '<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ' + actionColor(row.action) + '">' + esc(actionTitle(row.action)) + '</span>' +
                '</div>' +
                '<div class="text-xs text-slate-400 whitespace-nowrap">' + timeStr + '</div>' +
              '</div>' +
              userLine + reporterLine + matchLine + unbanLine + messageLine + detailsLine +
              '<div class="flex gap-2 mt-2 justify-end border-t border-slate-700/30 pt-3">' +
                (canUnban ? '<button data-id="' + row.id + '" class="unban btn px-3 py-1.5 text-xs bg-emerald-600/80 hover:bg-emerald-600 text-white rounded font-medium border border-emerald-500/50 shadow-lg shadow-emerald-600/10">Unban</button>' : '') +
                '<button data-id="' + row.id + '" class="delete-log btn px-2.5 py-1.5 text-xs text-slate-400 bg-slate-800 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/30 rounded border border-slate-700 transition-colors" title="Delete Log"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>' +
              '</div>' +
            '</div>'
          );
          root.appendChild(el);
        }

        root.querySelectorAll('.delete-log').forEach(btn => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/logs/' + btn.dataset.id, { method: 'DELETE' });
            await loadLogs();
          });
        });

        root.querySelectorAll('.unban').forEach(btn => {
          btn.addEventListener('click', async () => {
            await api('/admin/api/logs/' + btn.dataset.id + '/unban', { method: 'POST' });
            await loadLogs();
          });
        });

        pager('logsPager', data.paging, (page) => { state.logsPage = page; loadLogs().catch(e => alert(e.message)); });
      }

      // Minor helper wrapper for updating history when creating rules
      function refreshHistory() {
        state.logsPage = 1;
        loadLogs().catch(() => {});
      }

      async function refreshAll() {
        $('refreshBtn').classList.add('opacity-50', 'cursor-wait');
        try {
          const results = await Promise.allSettled([loadSettings(), loadBlacklist(), loadQuarantine(), loadLogs()]);
          const firstFailed = results.find((item) => item.status === 'rejected');
          if (firstFailed && firstFailed.status === 'rejected') {
            throw firstFailed.reason;
          }
        } finally {
          setTimeout(() => $('refreshBtn').classList.remove('opacity-50', 'cursor-wait'), 300);
        }
      }

      $('saveSettings').addEventListener('click', () => saveSettings().then(() => alert('Saved')).catch(e => alert(e.message)));
      $('saveModeration').addEventListener('click', () => saveModeration().then(() => alert('Moderation settings saved')).catch(e => alert(e.message)));
      $('savePremoderation').addEventListener('click', () => savePremoderation().then(() => alert('Pre-moderation settings saved')).catch(e => alert(e.message)));
      $('addPattern').addEventListener('click', () => addPattern().catch(e => alert(e.message)));
      
      $('pattern').addEventListener('keypress', (e) => {
         if(e.key === 'Enter') addPattern().catch(e => alert(e.message));
      });

      $('refreshBtn').addEventListener('click', () => refreshAll().catch(e => alert(e.message)));
      $('logoutBtn').addEventListener('click', () => { window.location.href = '/cdn-cgi/access/logout'; });
      $('includeSystemLogs').addEventListener('change', () => { state.logsPage = 1; loadLogs().catch(e => alert(e.message)); });

      refreshAll().catch(e => alert(e.message));
    </script>
  </body>
</html>`;

export default app;
