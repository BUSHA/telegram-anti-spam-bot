CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_chats (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS known_chats (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  bot_status TEXT NOT NULL DEFAULT '',
  is_member INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bot_admins (
  user_id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS admin_chat_assignments (
  admin_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(admin_user_id, chat_id),
  FOREIGN KEY(admin_user_id) REFERENCES bot_admins(user_id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id) REFERENCES bot_chats(chat_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  is_regex INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL DEFAULT '',
  chat_title TEXT NOT NULL DEFAULT '',
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
  UNIQUE(chat_id, message_id, user_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  user_id INTEGER,
  chat_id TEXT,
  chat_title TEXT,
  details TEXT,
  meta_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS premoderation_challenges (
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
);

CREATE INDEX IF NOT EXISTS idx_quarantine_timestamp ON quarantine(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_quarantine_chat_timestamp ON quarantine(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_logs_chat_timestamp ON logs(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_premod_expiry ON premoderation_challenges(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_premod_user ON premoderation_challenges(chat_id, user_id, status);
