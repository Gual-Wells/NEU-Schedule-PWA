import '../../daily-reminders.js';

const R = globalThis.ScheduleDailyReminders;

// These reminders are independent of client plans, attendance and gym occupancy.
export async function ensureDailyReminders(env, now = Date.now()) {
  const day = R.dayKey(now), jobs = R.jobs(day), content = JSON.stringify(jobs);
  await env.DB.batch([
    // Retire unsent schedules after a time correction; preserve delivered history.
    env.DB.prepare(`DELETE FROM reminders WHERE reminder_id LIKE ? AND sent_at IS NULL
      AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`)
      .bind(`daily-${day}-%`, content),
    env.DB.prepare(`
    INSERT OR IGNORE INTO reminders (device_id, reminder_id, due_at, title, body, ttl)
    SELECT d.id, json_extract(j.value, '$.id'), json_extract(j.value, '$.dueAt'),
      json_extract(j.value, '$.title'), json_extract(j.value, '$.body'), json_extract(j.value, '$.ttl')
    FROM devices d CROSS JOIN json_each(?) j
    `).bind(content)
  ]);
}

export const dailyReminders = R;
