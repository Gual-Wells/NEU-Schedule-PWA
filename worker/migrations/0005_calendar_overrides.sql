CREATE TABLE IF NOT EXISTS calendar_overrides (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO calendar_overrides (id, content, revision, updated_at)
VALUES (1, '{"holidays":[],"makeups":[]}', 1, 0);
