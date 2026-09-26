CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  plan_hash TEXT,
  test_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  reminder_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  sent_at INTEGER,
  claim_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, reminder_id)
);

CREATE INDEX IF NOT EXISTS reminders_due ON reminders(due_at, sent_at);
