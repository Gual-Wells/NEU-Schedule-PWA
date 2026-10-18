-- Preserve legacy results; only new/revised applications require extraction protocol 3.
ALTER TABLE agenda_imports ADD COLUMN extraction_protocol INTEGER NOT NULL DEFAULT 2;
ALTER TABLE agenda_imports ADD COLUMN processing_deadline INTEGER NOT NULL DEFAULT 0;
UPDATE agenda_imports SET processing_deadline=expires_at;
CREATE TABLE agenda_feedback (
  id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES agenda_imports(id),
  text TEXT NOT NULL, prior_result_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX agenda_feedback_parent ON agenda_feedback(import_id,created_at);
CREATE TABLE agenda_result_versions (
  import_id TEXT NOT NULL REFERENCES agenda_imports(id), generation INTEGER NOT NULL,
  result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(import_id,generation)
);
INSERT INTO agenda_result_versions SELECT id,generation,result_json,updated_at FROM agenda_imports WHERE result_json IS NOT NULL;
CREATE TABLE agenda_review_guards (
  id TEXT PRIMARY KEY, import_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
  expected_status TEXT NOT NULL, item_id TEXT, item_revision INTEGER
);
CREATE TRIGGER agenda_review_guard BEFORE INSERT ON agenda_review_guards
WHEN NOT EXISTS(SELECT 1 FROM agenda_imports WHERE id=NEW.import_id AND revision=NEW.expected_revision AND status=NEW.expected_status)
OR (NEW.item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agenda_items WHERE id=NEW.item_id AND revision=NEW.item_revision AND resolved_at IS NULL AND cancelled_at IS NULL))
BEGIN SELECT RAISE(ABORT,'stale_review'); END;
CREATE TRIGGER agenda_single_item BEFORE INSERT ON agenda_items
WHEN NEW.source_import_id IS NOT NULL
AND EXISTS(SELECT 1 FROM agenda_imports WHERE id=NEW.source_import_id AND extraction_protocol=3)
AND EXISTS(SELECT 1 FROM agenda_items WHERE source_import_id=NEW.source_import_id)
BEGIN SELECT RAISE(ABORT,'one_item_per_application'); END;
CREATE TABLE agenda_item_operation_guards(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,expected_revision INTEGER NOT NULL);
CREATE TRIGGER agenda_item_operation_guard BEFORE INSERT ON agenda_item_operation_guards
WHEN NOT EXISTS(SELECT 1 FROM agenda_items WHERE id=NEW.item_id AND revision=NEW.expected_revision AND resolved_at IS NULL AND cancelled_at IS NULL)
BEGIN SELECT RAISE(ABORT,'stale_item'); END;
