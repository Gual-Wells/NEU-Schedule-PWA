-- History remains on its original runner. Only new submissions choose cloud-v1.
ALTER TABLE agenda_imports ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(execution_mode IN ('legacy','cloud-v1'));
ALTER TABLE agenda_imports ADD COLUMN outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK(outcome_unknown IN (0,1));
CREATE INDEX agenda_imports_execution_queue ON agenda_imports(execution_mode,status,updated_at);
