-- Independent lifecycle for user-scheduled group meetings; does not alter classes, gym, or authentication.
CREATE TABLE IF NOT EXISTS group_meetings (
  id TEXT PRIMARY KEY,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  end_reason TEXT,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (start_at > 0),
  CHECK (end_at IS NULL OR (end_at >= start_at AND end_at <= start_at + 18000000)),
  CHECK ((end_at IS NULL AND end_reason IS NULL) OR
         (end_at IS NOT NULL AND end_reason IN ('manual', 'late')))
);
CREATE INDEX IF NOT EXISTS group_meetings_start ON group_meetings(start_at);
