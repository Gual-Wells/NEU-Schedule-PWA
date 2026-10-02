import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../data.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'data.js' });
const D = sandbox.window.APP_DATA;
if (!D) throw new Error('APP_DATA missing');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const monday = new Date(2026, 7, 31);
const target = new Date(2026, 8, 24);
const week = Math.floor((target - monday) / 86400000 / 7) + 1;
assert(D.semester.week1Monday === '2026-08-31', 'week 1 Monday drifted');
assert(week === 4, '2026-09-24 must remain teaching week 4');
assert(Object.keys(D.periods).length === 12, 'expected 12 teaching periods');
assert(D.courses.length === 12, 'expected 12 course records');
assert(D.courses.every(c => Object.hasOwn(c, 'className')), 'className field must remain present');
assert(JSON.stringify(D.courses.map(c => c.className)) === JSON.stringify([
  '02班（浑南）', '', '', '04班（浑南）', '04班（浑南）', '05班（浑南）',
  '04班（浑南）', '03班（浑南）', '03班（浑南）', '07班', '', ''
]), 'course class names must match the supplied enrollment timetable');
for (const day of [2, 4, 5]) {
  assert(JSON.stringify(D.gym.availability[day]) === JSON.stringify([['07:00','10:00'],['12:10','13:50'],['15:40','20:40']]), `Day ${day} gym schedule drifted`);
}
assert(JSON.stringify(D.gym.availability[3]) === JSON.stringify([['07:00','20:40']]), 'Wednesday gym schedule drifted');
assert(JSON.stringify(D.gym.availability[7]) === JSON.stringify([['07:00','20:40']]), 'Sunday gym opening hours drifted');
assert(JSON.stringify(D.gym.closures) === JSON.stringify([{ weekday: 7, weeks: '4-9', start: '15:30', end: '17:00', reason: '场地课程' }]), 'Sunday gym class closure drifted');

console.log('Static data invariants OK');
