CREATE TABLE IF NOT EXISTS auth_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 1,
  enrollment_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO auth_control (id, epoch, enrollment_until) VALUES (1, 1, 0);

CREATE TABLE IF NOT EXISTS auth_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  ticket_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('enroll', 'login')),
  challenge TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
