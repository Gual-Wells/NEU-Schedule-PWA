CREATE TABLE agenda_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('activity','deadline')),
  title TEXT NOT NULL,
  anchor_at INTEGER NOT NULL,
  explicit_end_at INTEGER,
  location TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  source_import_id TEXT,
  source_item_key TEXT,
  resolved_at INTEGER,
  cancelled_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_import_id,source_item_key),
  CHECK(explicit_end_at IS NULL OR (kind='activity' AND explicit_end_at>anchor_at))
);
CREATE INDEX agenda_items_time ON agenda_items(anchor_at);
CREATE TABLE agenda_imports (
  id TEXT PRIMARY KEY,
  client_nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','review','applied','failed','cancelled')),
  digest TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reference_at INTEGER NOT NULL,
  result_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  claim_hash TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  error TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agenda_imports_queue ON agenda_imports(status,created_at);
CREATE TRIGGER agenda_image_quota BEFORE INSERT ON agenda_imports
WHEN (SELECT COALESCE(SUM(byte_length),0) FROM agenda_imports WHERE expires_at>NEW.created_at AND status<>'cancelled')+NEW.byte_length>52428800
OR (SELECT COUNT(*) FROM agenda_imports WHERE status IN ('queued','running'))>=20
BEGIN SELECT RAISE(ABORT,'image_quota'); END;
CREATE TABLE agenda_import_chunks (
  import_id TEXT NOT NULL REFERENCES agenda_imports(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(import_id,chunk_index)
);
CREATE TABLE agenda_operations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE agenda_digests (
  id TEXT PRIMARY KEY,
  slot_at INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE agenda_digest_deliveries (
  digest_id TEXT NOT NULL REFERENCES agenda_digests(id),
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  claim_at INTEGER,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(digest_id,device_id)
);
CREATE TABLE agenda_meta(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO agenda_meta VALUES(1,1);
CREATE TRIGGER agenda_items_insert AFTER INSERT ON agenda_items BEGIN UPDATE agenda_meta SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER agenda_items_update AFTER UPDATE ON agenda_items BEGIN UPDATE agenda_meta SET revision=revision+1 WHERE id=1; END;
-- A receipt inserted first in a batch makes a stale apply a transaction error.
CREATE TABLE agenda_apply_guards(id TEXT PRIMARY KEY, import_id TEXT NOT NULL, expected_revision INTEGER NOT NULL);
CREATE TRIGGER agenda_apply_guard BEFORE INSERT ON agenda_apply_guards
WHEN NOT EXISTS(SELECT 1 FROM agenda_imports WHERE id=NEW.import_id AND revision=NEW.expected_revision AND status='review')
BEGIN SELECT RAISE(ABORT,'stale_import'); END;
-- Group meetings now belong to the two daily digests, including plans from old clients.
DELETE FROM reminders WHERE sent_at IS NULL AND reminder_id LIKE 'meeting-%';
UPDATE devices SET plan_hash=NULL;
