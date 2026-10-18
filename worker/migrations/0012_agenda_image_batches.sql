ALTER TABLE agenda_imports ADD COLUMN image_protocol INTEGER NOT NULL DEFAULT 1 CHECK(image_protocol IN (1,2));
ALTER TABLE agenda_imports ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready' CHECK(upload_state IN ('draft','ready'));
ALTER TABLE agenda_items ADD COLUMN source_images TEXT NOT NULL DEFAULT '[]';

CREATE TABLE agenda_import_images (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES agenda_imports(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 8),
  digest TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 5242880),
  received_at INTEGER,
  UNIQUE(import_id,position),
  UNIQUE(import_id,digest)
);
CREATE INDEX agenda_import_images_parent ON agenda_import_images(import_id,position);
CREATE TABLE agenda_image_chunks (
  image_id TEXT NOT NULL REFERENCES agenda_import_images(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(image_id,chunk_index)
);
CREATE TABLE agenda_image_upload_guards(id TEXT PRIMARY KEY,import_id TEXT NOT NULL,image_id TEXT NOT NULL,at INTEGER NOT NULL);
CREATE TRIGGER agenda_image_upload_guard BEFORE INSERT ON agenda_image_upload_guards
WHEN NOT EXISTS (
  SELECT 1 FROM agenda_imports p JOIN agenda_import_images i ON i.import_id=p.id
  WHERE p.id=NEW.import_id AND i.id=NEW.image_id AND p.image_protocol=2
    AND p.status='queued' AND p.upload_state='draft' AND p.expires_at>NEW.at AND i.received_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'stale_image_upload'); END;
