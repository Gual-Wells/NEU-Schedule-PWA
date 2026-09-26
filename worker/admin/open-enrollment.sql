-- Run with Wrangler against the production D1 database only when ready to register.
-- The empty slot alone never opens registration.
UPDATE auth_control
SET enrollment_until = unixepoch('now') * 1000 + 300000
WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM auth_credential WHERE id = 1);
