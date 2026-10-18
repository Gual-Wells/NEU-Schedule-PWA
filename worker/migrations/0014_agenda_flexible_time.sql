ALTER TABLE agenda_items ADD COLUMN date_start TEXT;
ALTER TABLE agenda_items ADD COLUMN date_end TEXT;
ALTER TABLE agenda_items ADD COLUMN inference TEXT NOT NULL DEFAULT '';
ALTER TABLE agenda_imports ADD COLUMN canonical_id TEXT;
ALTER TABLE agenda_imports ADD COLUMN recognition_context TEXT;
CREATE INDEX agenda_imports_canonical ON agenda_imports(canonical_id);
CREATE TABLE agenda_application_items(application_id TEXT PRIMARY KEY REFERENCES agenda_imports(id),item_id TEXT NOT NULL UNIQUE REFERENCES agenda_items(id));
INSERT INTO agenda_application_items SELECT source_import_id,MIN(id) FROM agenda_items WHERE source_import_id IS NOT NULL GROUP BY source_import_id HAVING COUNT(*)=1;
CREATE TABLE agenda_item_sources(item_id TEXT NOT NULL REFERENCES agenda_items(id),import_id TEXT NOT NULL REFERENCES agenda_imports(id),source_images TEXT NOT NULL,applied_at INTEGER NOT NULL,PRIMARY KEY(item_id,import_id));
INSERT INTO agenda_item_sources SELECT id,source_import_id,source_images,updated_at FROM agenda_items WHERE source_import_id IS NOT NULL;
DROP TRIGGER agenda_single_item;
CREATE TRIGGER agenda_single_item BEFORE INSERT ON agenda_items
WHEN NEW.source_import_id IS NOT NULL
AND EXISTS(SELECT 1 FROM agenda_imports WHERE id=NEW.source_import_id AND extraction_protocol>=3)
AND EXISTS(SELECT 1 FROM agenda_items WHERE source_import_id=NEW.source_import_id)
BEGIN SELECT RAISE(ABORT,'one_item_per_application'); END;
