CREATE TABLE IF NOT EXISTS schedule_data (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gym_sessions (
  id TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  closes_at INTEGER NOT NULL,
  end_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gym_sessions_start ON gym_sessions(start_at DESC);

CREATE TABLE IF NOT EXISTS daily_skips (
  day_key TEXT PRIMARY KEY,
  course_ids TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
