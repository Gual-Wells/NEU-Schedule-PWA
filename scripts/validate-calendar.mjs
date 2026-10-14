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
const at = new Date(2026, 8, 5, 10, 0);
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [at.getTime()])); }
  static now() { return at.getTime(); }
}
function model(calendar, restores = []) {
  const window = { APP_CALENDAR: { ...calendar, revision: 2 } };
  const localStorage = { getItem(key) { return key === 'neu-schedule-restored-v1' ? JSON.stringify(restores) : null; } };
  const context = vm.createContext({ window, localStorage, location: { search: '' }, URLSearchParams, Date: FixedDate, Intl, setTimeout, clearTimeout });
  vm.runInContext(dataSource, context);
  vm.runInContext(gymSource, context);
  vm.runInContext(appSource, context);
  return window.__test;
}
const originalModel = model({ holidays: [], makeups: [] });
const moved = model({ holidays: ['2026-09-08'], makeups: [{ target: '2026-09-05', source: '2026-09-07' }] });
const source = originalModel.rawCourses(1, 2);
assert(source.length > 0, 'source day must have lessons');
assert.equal(originalModel.rawCourses(6, 1).length, 0, 'target must start blank');
assert.equal(moved.rawCourses(1, 2).length, 0, 'source day must clear');
assert.deepEqual([...moved.rawCourses(6, 1)].map(c => c._id), [...source].map(c => c._id), 'target receives source lessons');
assert.equal(moved.rawCourses(2, 2).length, 0, 'holiday cancels all lessons');
const jobs = moved.buildPushJobs();
assert(jobs.some(job => job.id.startsWith('2026-09-05-c')), 'moved lessons receive target-day reminders');
assert(!jobs.some(job => job.id.startsWith('2026-09-07-c')), 'source-day reminders clear');
assert(!jobs.some(job => job.id.startsWith('2026-09-08-c')), 'holiday reminders clear');
assert.equal(originalModel.activeCourses(1, 2).length, 0, 'all lessons start skipped');
assert.equal(moved.activeCourses(6, 1).length, 0, 'moved lessons also start skipped');
const restored = model({ holidays: [], makeups: [{ target: '2026-09-05', source: '2026-09-07' }] }, ['2026-09-05:10']);
assert.equal(restored.activeCourses(6, 1).length, 1, 'only manual restoration activates a moved lesson');
assert.notEqual(JSON.stringify(restored.dayFreeWindows(6, 1)), JSON.stringify(moved.dayFreeWindows(6, 1)), 'restoration divides gym time');
assert(jobs.some(job => job.title.startsWith('已翘课程')), 'default skipped classes get skipped notifications');
console.log('Calendar overrides, default skips, restored lessons, gym windows and reminders OK');
