const DAY = 86_400_000;
const EMPTY = { holidays: [], makeups: [] };

function dayNumber(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === key ? date.getTime() / DAY : NaN;
}

function weeksOf(spec) {
  const weeks = new Set();
  for (const part of String(spec).split(/[、,，]/).map(value => value.trim())) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) for (let week = Number(range[1]); week <= Number(range[2]); week++) weeks.add(week);
    else if (/^\d+$/.test(part)) weeks.add(Number(part));
  }
  return weeks;
}

function baseCoursesOn(key, schedule) {
  const offset = dayNumber(key) - dayNumber(schedule.semester.week1Monday);
  const week = Math.floor(offset / 7) + 1;
  const weekday = ((offset % 7) + 7) % 7 + 1;
  return schedule.courses.filter(course => course.weekday === weekday && weeksOf(course.weeks).has(week));
}

function validateCalendar(value, schedule) {
  if (!value || !Array.isArray(value.holidays) || !Array.isArray(value.makeups) ||
      value.holidays.length > 150 || value.makeups.length > 75) throw new Error('放假与调休记录无效');
  const first = dayNumber(schedule.semester.week1Monday);
  const last = first + schedule.semester.totalWeeks * 7 - 1;
  const inTerm = key => { const day = dayNumber(key); return Number.isFinite(day) && day >= first && day <= last; };
  const holidays = new Set();
  for (const key of value.holidays) {
    if (!inTerm(key) || holidays.has(key)) throw new Error('放假日期不在本学期或重复');
    holidays.add(key);
  }
  const occupied = new Set();
  for (const item of value.makeups) {
    if (!item || !inTerm(item.target) || !inTerm(item.source) || item.target === item.source)
      throw new Error('调休日期无效');
    if (occupied.has(item.target) || occupied.has(item.source) || holidays.has(item.target))
      throw new Error('调休日期已被占用或目标日已放假');
    if (baseCoursesOn(item.target, schedule).length) throw new Error('补课目标日原本有课程');
    if (!baseCoursesOn(item.source, schedule).length) throw new Error('来源日没有可移动的课程');
    occupied.add(item.target);
    occupied.add(item.source);
  }
  return {
    holidays: [...holidays].sort(),
    makeups: value.makeups.map(({ target, source }) => ({ target, source })).sort((a, b) => a.target.localeCompare(b.target))
  };
}

async function readCalendar(env) {
  const row = await env.DB.prepare('SELECT content, revision, updated_at FROM calendar_overrides WHERE id = 1').first();
  return row ? { ...JSON.parse(row.content), revision: row.revision, updatedAt: row.updated_at }
    : { ...EMPTY, revision: 0, updatedAt: 0 };
}

export { baseCoursesOn, readCalendar, validateCalendar };
