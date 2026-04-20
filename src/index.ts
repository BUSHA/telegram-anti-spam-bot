import { Hono } from 'hono';
import ADMIN_HTML from './dashboard.html';

type Env = {
  DB: D1Database;
  DELAY_QUEUE: Queue<{ chatId: string; challengeToken: string }>;
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
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    entities?: Array<{ type: string; offset: number; length: number }>;
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
  'Навчання оплачуємо',
  'Потрібен оператор чат',
  'Потрібні активні люди',
  'Чат-менеджер потрібен',
  'Без дзвінків і продажів',
  'Робота без дзвінків',
  'Шукаємо менеджера чатів',
  'Графік 5/2',
  'Не скам, не офіс'
];
const DEFAULT_PREMODERATION_TIMEOUT_SEC = 60;
const PREMODERATION_TIMEOUT_MARGIN_SEC = 3;
const DEFAULT_PREMODERATION_PROMPT =
  'Вітаю в чаті, {user}! Для перевірки оберіть цифру {digit} протягом {seconds} секунд. Інакше вас буде видалено.';
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

function formatFriendlyDate(date: Date): string {
  const months = ['Січня', 'Лютого', 'Березня', 'Квітня', 'Травня', 'Червня', 'Липня', 'Серпня', 'Вересня', 'Жовтня', 'Листопада', 'Грудня'];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hours}:${minutes}`;
}

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
const SYSTEM_CLEANUP_RE = /(deleted message|видалив повідомлення|повідомлення видалено)/iu;

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
      parse_mode: 'HTML',
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
  if (/\n\nСтатус:/u.test(message.text)) return;

  const statusLabel = `Статус: ${statusText}`;
  const newText = `${message.text}\n\n${statusLabel}`;
  const oldTextLength = message.text.length;

  try {
    await telegramApi<boolean>(token, 'editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: newText,
      entities: [
        ...(message.entities || []),
        {
          type: 'bold',
          offset: oldTextLength + 2, // account for \n\n
          length: statusLabel.length
        }
      ]
    });
  } catch {
    // Ignore edit failures.
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

function esc(str: string | number | undefined | null): string {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAdminNotification(
  type: 'premod_failure' | 'hard_match' | 'user_report' | 'soft_match',
  data: {
    userLabel: string;
    username?: string | null;
    reasonText?: string;
    banStatusText?: string;
    matchedTerms?: string[];
    text?: string;
    logId?: number | null;
    quarantineId?: number | null;
    reporterLabel?: string;
    reporterUsername?: string | null;
    reporterMessage?: string | null;
    targetLabel?: string;
    targetUsername?: string | null;
  }
): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
  let text = '';
  let buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  const userPart = `<b>Користувач:</b> ${esc(data.userLabel)} ${data.username ? `(@${esc(data.username)})` : ''}`;

  switch (type) {
    case 'premod_failure':
      text = [
        '<b>❌ Пре-модерацію провалено</b>\n',
        userPart,
        `<b>Причина:</b> ${esc(data.reasonText)}`,
        `<b>Статус бану:</b> ${data.banStatusText}`
      ].join('\n');
      if (data.logId) buttons = [[{ text: 'Розбанити', callback_data: `lg_unban:${data.logId}` }]];
      break;

    case 'hard_match':
      text = [
        '<b>🚫 Бан за чорним списком</b>\n',
        userPart,
        `<b>Збіг:</b> ${esc(data.matchedTerms?.join(', '))}`,
        `<b>Повідомлення:</b>\n<pre>${esc(data.text)}</pre>`
      ].join('\n');
      if (data.logId) buttons = [[{ text: 'Розбанити', callback_data: `lg_unban:${data.logId}` }]];
      break;

    case 'user_report':
      text = [
        '<b>⚠️ Скарга на спам</b>\n',
        `<b>Поскаржився:</b> ${esc(data.reporterLabel)} ${data.reporterUsername ? `(@${esc(data.reporterUsername)})` : ''}`,
        `<b>Коментар:</b> ${esc(data.reporterMessage || '(порожньо)')}\n`,
        `<b>Ціль:</b> ${esc(data.targetLabel)} ${data.targetUsername ? `(@${esc(data.targetUsername)})` : ''}`,
        `<b>Повідомлення:</b>\n<pre>${esc(data.text)}</pre>`
      ].join('\n');
      if (data.quarantineId) {
        buttons = [[
          { text: 'Бан та видалити', callback_data: `qr_ban:${data.quarantineId}` },
          { text: 'Дозволити', callback_data: `qr_app:${data.quarantineId}` }
        ]];
      }
      break;

    case 'soft_match':
      text = [
        '<b>⏳ Новий пункт у черзі перевірки</b>\n',
        userPart,
        `<b>Збіг:</b> ${esc(data.matchedTerms?.join(', ') || 'немає')}`,
        `<b>Повідомлення:</b>\n<pre>${esc(data.text)}</pre>`
      ].join('\n');
      if (data.quarantineId) {
        buttons = [[
          { text: 'Бан та видалити', callback_data: `qr_ban:${data.quarantineId}` },
          { text: 'Дозволити', callback_data: `qr_app:${data.quarantineId}` }
        ]];
      }
      break;
  }

  return { text, buttons };
}

function buildUserMention(userId: number, username?: string | null, firstName?: string | null): { html: string; plain: string } {
  if (username) {
    const handle = `@${username}`;
    return { html: handle, plain: handle };
  }
  const name = esc((firstName ?? '').trim() || 'користувач');
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
): { terms: string[] } {
  const terms = new Set<string>();

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
    terms: Array.from(terms)
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
  const reasonLabel = reason === 'timeout' ? 'час вичерпано' : reason === 'wrong_digit' ? 'невірна відповідь' : 'застарілий клік';
  const extra = typeof selectedDigit === 'number' ? `; обрано ${selectedDigit}, очікувано ${row.correct_digit}` : '';

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
    `пре-модерація провалена для ${userLabel} ${usernamePart}; причина: ${reasonLabel}${extra}; бан=${banRes.ok ? 'успішно' : 'помилка'}`,
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
        ? 'час вичерпано'
        : reason === 'wrong_digit'
          ? `невірна відповідь${typeof selectedDigit === 'number' ? ` (${selectedDigit} замість ${row.correct_digit})` : ''}`
          : 'застарілий клік';

    const { text, buttons } = formatAdminNotification('premod_failure', {
      userLabel,
      username: row.username,
      reasonText,
      banStatusText: banRes.ok ? '✅ успішно' : `❌ помилка${banRes.description ? ` (${banRes.description})` : ''}`,
      logId
    });
    await sendAdminMessage(settings.token, settings.adminUserId, text, buttons);
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
    `пре-модерацію пройдено для ${userLabelFromRow(row)}${row.username ? ` (@${row.username})` : ''}`,
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

function schedulePremoderationTimeout(
  env: Env,
  ctx: any,
  chatId: string,
  challengeToken: string,
  timeoutSec: number
): void {
  const sleepSec = Math.max(1, timeoutSec - PREMODERATION_TIMEOUT_MARGIN_SEC);
  ctx.waitUntil(
    env.DELAY_QUEUE.send(
      { chatId, challengeToken },
      { delaySeconds: sleepSec }
    ).catch(console.error)
  );
}

async function startPremoderationForUser(
  env: Env,
  ctx: any,
  db: D1Database,
  settings: RuntimeSettings,
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

  const insertRes = await db
    .prepare(
      `INSERT INTO premoderation_challenges(
        chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, expires_at
      ) 
      SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM premoderation_challenges
        WHERE chat_id = ? AND user_id = ? AND status = 'pending'
      )`
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
      expiresAt,
      settings.chatId,
      user.id
    )
    .run();

  if (insertRes.meta?.changes === 0) {
    return { ok: true, skipped: 'already_pending_race' };
  }

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
    `пре-модерацію розпочато для ${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() +
      `${user.username ? ` (@${user.username})` : ''}; завдання: ${plain}`,
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
  schedulePremoderationTimeout(env, ctx, settings.chatId, challengeToken, timeoutSec);
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
  const status = `вид.=${deleteResp.ok ? 'успішно' : 'помилка'} бан=${banResp.ok ? 'успішно' : 'помилка'}`;
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
  const details = `ручний бан за результатами перевірки користувача ${fullName || row.user_id}${row.username ? ` (@${row.username})` : ''}; текст: ${row.text}`;

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
  await logAction(db, 'quarantine_approved', null, `схвалено пункт черги ${id}`);
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
    return { ok: false, error: 'розбан доступний тільки для записів про бан' };
  }

  const userId = row.user_id;
  if (!userId) return { ok: false, error: 'у цьому записі історії немає id користувача' };

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
  if (!unbanRes.ok) return { ok: false, error: unbanRes.description ?? 'помилка розбану' };

  const now = new Date();
  const unbannedAtIso = now.toISOString();
  const unbannedAtFriendly = formatFriendlyDate(now);
  const mergedMeta: LogMeta = { ...meta, unbannedAt: unbannedAtIso, unbannedBy: source };
  const cleanedDetails = (row.details ?? '').replace(/\s*\|\s*UNBANNED.*$/u, '').trim();
  const detailsWithNote = `${cleanedDetails} | UNBANNED at ${unbannedAtFriendly} via ${source}`;
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
  // Queues now handle timeouts authoritatively via schedulePremoderationTimeout
  // await processExpiredPremoderationChallenges(db, settings);
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
      await answerCallbackQuery(settings.token, callbackQuery.id, 'Тільки адмін може використовувати цю дію');
      return c.json({ ok: true, skipped: 'callback_not_admin' });
    }

    if (data.startsWith('qr_ban:')) {
      const id = Number(data.slice('qr_ban:'.length));
      const result = Number.isFinite(id) ? await banDeleteQuarantineById(db, settings, id) : { ok: false, error: 'невірний id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Виконано' : result.error ?? 'помилка');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? '✅ Забанено' : `❌ Помилка: ${result.error ?? 'помилка'}`);
      return c.json({ ok: true, action: 'callback_qr_ban', result });
    }
    if (data.startsWith('qr_app:')) {
      const id = Number(data.slice('qr_app:'.length));
      const result = Number.isFinite(id) ? await approveQuarantineById(db, id) : { ok: false, error: 'невірний id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Схвалено' : result.error ?? 'помилка');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? '✅ Схвалено' : `❌ Помилка: ${result.error ?? 'помилка'}`);
      return c.json({ ok: true, action: 'callback_qr_app', result });
    }
    if (data.startsWith('lg_unban:')) {
      const id = Number(data.slice('lg_unban:'.length));
      const result = Number.isFinite(id)
        ? await unbanFromLogById(db, settings, id, 'telegram_callback')
        : { ok: false, error: 'невірний id' };
      await answerCallbackQuery(settings.token, callbackQuery.id, result.ok ? 'Розбанено' : result.error ?? 'помилка');
      await markCallbackMessageProcessed(settings.token, callbackQuery, result.ok ? '✅ Розбанено' : `❌ Помилка: ${result.error ?? 'помилка'}`);
      return c.json({ ok: true, action: 'callback_lg_unban', result });
    }

    await answerCallbackQuery(settings.token, callbackQuery.id, 'Невідома дія');
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
      const premodResult = await startPremoderationForUser(c.env, c.executionCtx, db, settings, joinedUser);
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

  // Secret command for admin to test notifications
  if (
    message.chat.type === 'private' &&
    settings.adminUserId &&
    String(message.from?.id) === String(settings.adminUserId) &&
    message.text?.trim() === 'Test notifications'
  ) {
    const dummyUser = { id: 12345, username: 'tester', firstName: 'Тест', lastName: 'Користувач' };
    const dummyLabel = `${dummyUser.firstName} ${dummyUser.lastName}`;

    const tests: Array<{ type: 'premod_failure' | 'hard_match' | 'user_report' | 'soft_match', data: any }> = [
      {
        type: 'premod_failure',
        data: { userLabel: dummyLabel, username: dummyUser.username, reasonText: 'невірна відповідь (3 замість 5)', banStatusText: '✅ успішно', logId: 999 }
      },
      {
        type: 'hard_match',
        data: { userLabel: dummyLabel, username: dummyUser.username, matchedTerms: ['заробляй', 'крипто', 'кешбек'], text: 'Привіт! Хочеш заробляти 500$ на день? Пиши мені!', logId: 999 }
      },
      {
        type: 'user_report',
        data: { reporterLabel: 'Адмін', reporterUsername: 'admin', reporterMessage: 'спамер у лічці', targetLabel: dummyLabel, targetUsername: dummyUser.username, text: 'Підписуйтесь на мій канал про крипту!', quarantineId: 888 }
      },
      {
        type: 'soft_match',
        data: { userLabel: dummyLabel, username: dummyUser.username, matchedTerms: ['Потрібен оператор чат'], text: 'Потрібен оператор чату, графік 5/2, висока зп.', quarantineId: 777 }
      }
    ];

    for (const test of tests) {
      const { text, buttons } = formatAdminNotification(test.type, test.data);
      await sendAdminMessage(settings.token, settings.adminUserId, text, buttons);
    }

    await telegramApi(settings.token, 'sendMessage', {
      chat_id: message.chat.id,
      text: '✅ Тестові повідомлення надіслано.'
    });

    return c.json({ ok: true, action: 'test_notifications_sent' });
  }

  if (String(message.chat.id) !== String(settings.chatId)) return c.json({ ok: true, skipped: 'wrong_chat' });

  if (message.new_chat_members?.length) {
    await deleteMessage(settings.token, settings.chatId, message.message_id);
    const results = [];
    for (const member of message.new_chat_members) {
      const result = await startPremoderationForUser(c.env, c.executionCtx, db, settings, member, message.message_id);
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
      const { text: adminText, buttons } = formatAdminNotification('hard_match', {
        userLabel,
        username: sender.username,
        matchedTerms: hardMatchTerms,
        text,
        logId: banResult.logId
      });
      await sendAdminMessage(settings.token, settings.adminUserId, adminText, buttons);
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
        `скарга користувача від ${reporterLabel} ${reporterUsername}; ціль ${targetLabel} ${targetUsername}; текст: ${reportedText}`,
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
        const { text: adminText, buttons } = formatAdminNotification('user_report', {
          userLabel: targetLabel, // used for userPart if we want, but user_report has custom fields
          reporterLabel,
          reporterUsername: sender.username,
          reporterMessage,
          targetLabel,
          targetUsername: reportedUser.username,
          text: reportedText,
          quarantineId
        });
        await sendAdminMessage(settings.token, settings.adminUserId, adminText, buttons);
      }
      return c.json({ ok: true, action: 'quarantine_report' });
    }
  }

  const softMatch = findSoftMatches(text, normalized, phraseText, settings.softKeywords);
  if (softMatch.terms.length === 0) {
    return c.json({ ok: true, action: 'allow' });
  }

  if (await isAdmin(db, settings.token, settings.chatId, sender.id)) return c.json({ ok: true, skipped: 'admin_user' });

  const softTerms = softMatch.terms;
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
    `м'який збіг у ${userLabel} ${usernamePart}; знайдено: ${softTerms.join(', ') || 'немає'}; текст: ${text}`,
    { ...metaBase, matchedTerms: softTerms, source: 'soft_match' }
  );
  if (settings.adminUserId && quarantineRow?.id) {
    const { text: adminText, buttons } = formatAdminNotification('soft_match', {
      userLabel,
      username: sender.username,
      matchedTerms: softTerms,
      text,
      quarantineId: quarantineRow.id
    });
    await sendAdminMessage(settings.token, settings.adminUserId, adminText, buttons);
  }
  return c.json({ ok: true, action: 'quarantine', matchedTerms: softTerms });
});

app.post('/webhook', (c) => jsonError('not_found', 404));

app.get('/admin/', async (c) => {
  await purgeOldLogs(c.env.DB);
  return c.html(ADMIN_HTML);
});

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
  const body = await c.req.json<{ token?: string; chatId?: string; adminUserId?: string; safeMode?: boolean }>();
  const token = (body.token ?? '').trim();
  const chatId = (body.chatId ?? '').trim();
  const adminUserId = (body.adminUserId ?? '').trim();
  if (!token || !chatId) return jsonError('токен та chatId обов’язкові');
  if (!/^-?\d+$/u.test(chatId)) return jsonError('chatId має бути числовим');
  if (adminUserId && !/^\d+$/u.test(adminUserId)) return jsonError('adminUserId має бути числовим');

  const workerUrl = new URL(c.req.url).origin;
  const { webhook, webhookPathToken } = await upsertCoreSettings(db, token, chatId, workerUrl);
  await setSetting(db, 'ADMIN_USER_ID', adminUserId);
  await setSetting(db, 'SAFE_MODE', body.safeMode ? '1' : '0');
  await logAction(db, 'settings_updated', null, `чат ${chatId}, вебхук ${webhook.ok ? 'успішно' : 'помилка'}, безп. режим ${body.safeMode ? 'увімкнено' : 'вимкнено'}`);

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

  if (list.length === 0) return jsonError('ключові слова обов’язкові');

  await setSetting(c.env.DB, 'SOFT_SUSPICIOUS_KEYWORDS', serializeSoftKeywords(list));
  await logAction(
    c.env.DB,
    'soft_keywords_updated',
    null,
    `оновлено налаштування модерації: м’які ключові слова (${list.length})`
  );
  return c.json({ ok: true, data: { keywords: list } });
});

app.post('/admin/api/settings/premoderation', async (c) => {
  const body = await c.req.json<{ enabled?: boolean; timeoutSec?: number; prompt?: string }>();
  const timeoutRaw = Number(body.timeoutSec ?? DEFAULT_PREMODERATION_TIMEOUT_SEC);
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 10 || timeoutRaw > 300) {
    return jsonError('timeoutSec має бути в межах 10..300');
  }
  const timeoutSec = Math.floor(timeoutRaw);
  const prompt = String(body.prompt ?? '').trim() || DEFAULT_PREMODERATION_PROMPT;
  if (prompt.length > 1000) return jsonError('повідомлення задовге');

  await setSetting(c.env.DB, 'PREMODERATION_ENABLED', body.enabled ? '1' : '0');
  await setSetting(c.env.DB, 'PREMODERATION_TIMEOUT_SEC', String(timeoutSec));
  await setSetting(c.env.DB, 'PREMODERATION_PROMPT', prompt);
  await logAction(
    c.env.DB,
    'premod_settings_updated',
    null,
    `пре-модерація ${body.enabled ? 'увімкнена' : 'вимкнена'}; тайм-аут ${timeoutSec}с`
  );
  return c.json({ ok: true, data: { enabled: !!body.enabled, timeoutSec, prompt } });
});

app.get('/admin/api/blacklist/sync', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT pattern FROM blacklist ORDER BY id ASC')
    .all<{ pattern: string }>();
  return c.json({ ok: true, data: (rows.results ?? []).map(r => r.pattern) });
});

app.post('/admin/api/blacklist/sync', async (c) => {
  const body = await c.req.json<{ patterns?: string[] }>();
  const patterns = body.patterns || [];
  
  const batch = [];
  batch.push(c.env.DB.prepare('DELETE FROM blacklist'));
  for (const p of patterns) {
    if (p.trim()) {
      batch.push(c.env.DB.prepare('INSERT INTO blacklist (pattern, is_regex) VALUES (?, 0)').bind(p.trim()));
    }
  }
  await c.env.DB.batch(batch);
  BLACKLIST_CACHE.delete('global');
  await logAction(c.env.DB, 'blacklist_add', null, `synced ${patterns.length} patterns`);
  return c.json({ ok: true });
});

app.get('/admin/api/quarantine', async (c) => {
  await purgeOldLogs(c.env.DB);
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

async function purgeOldLogs(db: D1Database, limit = 1000): Promise<void> {
  try {
    await db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)').bind(limit).run();
    await db.prepare('DELETE FROM premoderation_challenges WHERE id NOT IN (SELECT id FROM premoderation_challenges ORDER BY id DESC LIMIT ?)').bind(limit).run();
  } catch (err) {
    console.error('Failed to purge old logs:', err);
  }
}

app.get('/admin/api/logs', async (c) => {
  await purgeOldLogs(c.env.DB);
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

app.get('/admin', async (c) => {
  await purgeOldLogs(c.env.DB);
  return c.html(ADMIN_HTML);
});

export default {
  fetch: app.fetch,
  async queue(batch: any, env: Env) {
    const db = env.DB;
    for (const msg of batch.messages) {
      const { chatId, challengeToken } = msg.body as { chatId: string, challengeToken: string };
      const settings = await getRuntimeSettings(db);
      if (!settings || settings.chatId !== chatId) continue;
      const row = await db
        .prepare(
          `SELECT id, chat_id, user_id, username, first_name, last_name, join_message_id, captcha_message_id, challenge_token, correct_digit, status, failure_reason, expires_at
           FROM premoderation_challenges
           WHERE challenge_token = ?`
        )
        .bind(challengeToken)
        .first<PremodChallengeRow>();
      if (!row || row.status !== 'pending') continue;
      const expiresAtMs = Date.parse(row.expires_at);
      if (
        Number.isFinite(expiresAtMs) &&
        expiresAtMs - Date.now() > PREMODERATION_TIMEOUT_MARGIN_SEC * 1000
      ) {
        continue;
      }
      await resolvePremoderationFailure(db, settings, row, 'timeout');
      if (row.captcha_message_id) {
        await editMessageText(settings.token, settings.chatId, row.captcha_message_id, '⛔ Час перевірки вичерпано.', []);
      }
    }
  }
};
