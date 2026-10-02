-- Correct the 2026-09-04 gym timetable transcription. The day numbers are
-- Monday=1 through Sunday=7. Keep the rest of the schedule document intact.
UPDATE schedule_data
SET content = json_set(
      content,
      '$.gym.availability."2"', json('[["07:00","10:00"],["12:10","13:50"],["15:40","20:40"]]'),
      '$.gym.availability."4"', json('[["07:00","10:00"],["12:10","13:50"],["15:40","20:40"]]'),
      '$.gym.availability."5"', json('[["07:00","10:00"],["12:10","13:50"],["15:40","20:40"]]'),
      '$.gym.availability."7"', json('[["07:00","20:40"]]'),
      '$.gym.closures', json('[{"weekday":7,"weeks":"4-9","start":"15:30","end":"17:00","reason":"场地课程"}]')
    ),
    revision = revision + 1,
    updated_at = unixepoch('now') * 1000
WHERE id = 1;

-- Old gym notifications refer to the previous opening windows. They will be
-- regenerated from the new schedule when the PWA next opens on each device.
DELETE FROM reminders
WHERE sent_at IS NULL AND reminder_id GLOB '????-??-??-g*';
UPDATE devices SET plan_hash = NULL;
