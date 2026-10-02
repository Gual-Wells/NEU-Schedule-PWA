import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const dataSource = fs.readFileSync(new URL('../data.js', import.meta.url), 'utf8');
const gymSource = fs.readFileSync(new URL('../gym-store.js', import.meta.url), 'utf8');
const original = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
assert.equal((html.match(/<dialog\b/g) || []).length, (html.match(/<\/dialog>/g) || []).length, 'dialogs remain balanced');
for (const id of ['calendarDialog', 'holidayStart', 'holidayEnd', 'makeupTarget', 'makeupSource', 'pushDialog'])
  assert(html.includes(`id="${id}"`), `missing ${id}`);
assert(sw.includes("'/calendar'"), 'calendar API must bypass the service worker cache');
const appSource = original.replace(/  boot\(\);\s*\}\)\(\);\s*$/, '  window.__test = { rawCourses, activeCourses, dayFreeWindows, buildPushJobs };\n})();');
assert.notEqual(appSource, original, 'test hook must replace boot');
const at = new Date(2026, 8, 6, 10, 0);
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [at.getTime()])); }
  static now() { return at.getTime(); }
}
function model(calendar, skip = []) {
  const window = { APP_CALENDAR: { ...calendar, revision: 2 } };
  const localStorage = { getItem(key) { return key === 'neu-schedule-skipped-v7' ? JSON.stringify(skip) : null; } };
  const context = vm.createContext({ window, localStorage, location: { search: '' }, URLSearchParams, Date: FixedDate, Intl, setTimeout, clearTimeout });
  vm.runInContext(dataSource, context);
  vm.runInContext(gymSource, context);
  vm.runInContext(appSource, context);
  return window.__test;
}
const originalModel = model({ holidays: [], makeups: [] });
const moved = model({ holidays: ['2026-09-08'], makeups: [{ target: '2026-09-06', source: '2026-09-07' }] });
const source = originalModel.rawCourses(1, 2);
assert(source.length > 0, 'source day must have lessons');
assert.equal(originalModel.rawCourses(7, 1).length, 0, 'target must start blank');
assert.equal(moved.rawCourses(1, 2).length, 0, 'source day must clear');
assert.deepEqual([...moved.rawCourses(7, 1)].map(c => c._id), [...source].map(c => c._id), 'target receives source lessons');
assert.equal(moved.rawCourses(2, 2).length, 0, 'holiday cancels all lessons');
const jobs = moved.buildPushJobs();
assert(jobs.some(job => job.id.startsWith('2026-09-06-c')), 'moved lessons receive target-day reminders');
assert(!jobs.some(job => job.id.startsWith('2026-09-07-c')), 'source-day reminders clear');
assert(!jobs.some(job => job.id.startsWith('2026-09-08-c')), 'holiday reminders clear');
assert(moved.dayFreeWindows(7, 1).length < originalModel.dayFreeWindows(7, 1).length ||
  JSON.stringify(moved.dayFreeWindows(7, 1)) !== JSON.stringify(originalModel.dayFreeWindows(7, 1)), 'moved lessons change gym free windows');
const skipped = model({ holidays: [], makeups: [{ target: '2026-09-06', source: '2026-09-07' }] }, ['2026-09-06:10']);
assert(skipped.activeCourses(7, 1).length < skipped.rawCourses(7, 1).length, 'today skip follows the moved date');
console.log('Calendar overrides affect timetable, free gym windows, skips and push jobs');
