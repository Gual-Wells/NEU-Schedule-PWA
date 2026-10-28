import '../../daily-reminders.js';

const R = globalThis.ScheduleDailyReminders;

// These reminders are independent of client plans, attendance and gym occupancy.
export async function ensureDailyReminders(env, now = Date.now()) {
  const jobs = R.jobs(R.dayKey(now));
  await env.DB.prepare(`
    INSERT OR IGNORE INTO reminders (device_id, reminder_id, due_at, title, body, ttl)
    SELECT d.id, json_extract(j.value, '$.id'), json_extract(j.value, '$.dueAt'),
      json_extract(j.value, '$.title'), json_extract(j.value, '$.body'), json_extract(j.value, '$.ttl')
    FROM devices d CROSS JOIN json_each(?) j
  `).bind(JSON.stringify(jobs)).run();
}

export const dailyReminders = R;
