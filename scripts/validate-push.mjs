import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const dataSource = fs.readFileSync(new URL('../data.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/  boot\(\);\s*\}\)\(\);\s*$/, '  window.__test = { buildPushJobs };\n})();');
assert.notEqual(appSource, fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8'), 'test hook must replace boot');
function makeJobs(skipped, at = new Date(2026, 9, 6, 12, 0)) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [at.getTime()])); }
    static now() { return at.getTime(); }
  }
  const window = {};
  const localStorage = { getItem(key) { return key === 'neu-schedule-skipped-v7' ? JSON.stringify(skipped) : null; } };
  const context = vm.createContext({ window, localStorage, location: { search: '' }, URLSearchParams, Date: FixedDate, Intl, setTimeout, clearTimeout });
  vm.runInContext(dataSource, context);
  vm.runInContext(appSource, context);
  return window.__test.buildPushJobs();
}
const normal = makeJobs([]);
const skipped = makeJobs(['2026-10-06:3']);
assert(normal.length > 300 && normal.length <= 1800, `unexpected job count ${normal.length}`);
assert(Buffer.byteLength(JSON.stringify({ jobs: normal }), 'utf8') < 180000, 'plan exceeds Worker body limit');
assert.equal(new Set(normal.map(job => job.id)).size, normal.length, 'duplicate reminder IDs');
assert(normal.some(job => job.id === '2026-10-06-c3-p30'), 'Tuesday class reminder missing');
assert(!skipped.some(job => job.id.startsWith('2026-10-06-c3-')), 'skipped class reminder remained');
assert(skipped.length < normal.length, 'skip should remove class reminders');
const today = makeJobs([], new Date(2026, 8, 26, 15, 33));
assert(today.some(job => job.id === '2026-09-26-c12-p5'), '15:45 test class reminder missing');
assert(today.some(job => job.id === '2026-09-26-c12-start'), '15:50 test class start reminder missing');
assert(today.some(job => job.id === '2026-09-26-gym-physical-0'), '15:50 gym opening reminder missing');
assert.equal(today.find(job => job.id === '2026-09-26-c12-start').dueAt, new Date(2026, 8, 26, 15, 50).getTime());
assert.equal(today.find(job => job.id === '2026-09-26-gym-physical-0').dueAt, new Date(2026, 8, 26, 15, 50).getTime());
console.log(`Push plan OK: ${normal.length} jobs, ${JSON.stringify(normal).length} characters`);
