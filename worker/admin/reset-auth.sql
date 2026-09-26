-- Owner-only manual recovery. Never run automatically during deploy.
UPDATE auth_control SET epoch = epoch + 1, enrollment_until = 0 WHERE id = 1;
DELETE FROM auth_credential;
DELETE FROM auth_challenges;
DELETE FROM auth_sessions;
DELETE FROM app_tokens;
DELETE FROM devices;
