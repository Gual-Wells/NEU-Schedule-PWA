import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
let fixedArgs = [2026, 8, 25, 18, 45];
let tick;
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : fixedArgs)); }
  static now() { return new FixedDate().getTime(); }
}
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    id, dataset: {}, innerHTML: '', textContent: '', hidden: false, scrollTop: 0,
    clientHeight: 500, offsetTop: 0,
    classList: { toggle() {} },
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelectorAll(selector) {
      return this.id === 'timelineGrid' && selector === '.day-head, .lane-hitbox' ? [node('monday-head')] : [];
    },
    showModal() {}, close() {}
  });
  return nodes.get(id);
}
const segments = ['week', 'day', 'gym'].map(mode => {
  const element = node(`segment-${mode}`);
  element.dataset.mode = mode;
  return element;
});
node('monday-head').dataset.day = '1';
const store = new Map();
store.set('neu-schedule-skipped-v7', JSON.stringify(['2026-09-24:6']));
const lifecycle = new Map();
const sandbox = {
  Date: FixedDate,
  window: { addEventListener(name, fn) { lifecycle.set(`window:${name}`, fn); } },
  document: {
    getElementById: node,
    querySelectorAll(selector) { return selector === '.segment' ? segments : []; },
    addEventListener(name, fn) { lifecycle.set(`document:${name}`, fn); },
    hidden: false
  },
  localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
  navigator: {},
  location: { search: '' },
  URLSearchParams,
  requestAnimationFrame() {},
  setInterval(fn) { tick = fn; },
  setTimeout() {},
  clearTimeout() {},
  Intl,
  console
};
vm.createContext(sandbox);
for (const file of ['data.js', 'gym-store.js', 'app.js'])
  vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox, { filename: file });
assert.equal(store.get('neu-schedule-skipped-v7'), '[]', 'old-day skip records must clear on startup');

assert.match(node('timelineGrid').innerHTML, /第7–8节/);
assert.match(node('timelineGrid').innerHTML, /16:00–17:40/);
assert.match(node('timelineGrid').innerHTML, /gym-odd/);
assert.match(node('timelineGrid').innerHTML, /gym-even/);
assert.match(node('timelineGrid').innerHTML, /period-slot/);
const verifyFullDayAxis = (html, periodClass) => {
  assert.equal((html.match(/class="day-endpoint/g) || []).length, 2);
  assert.match(html, /class="day-endpoint first" style="top:0%">00:00<\/div>/);
  assert.match(html, /class="day-endpoint last" style="top:100%">24:00<\/div>/);
  assert.doesNotMatch(html, /hour-guide|hour-tick/);
  const seventh = html.match(new RegExp(`class="${periodClass}" style="top:([\\d.]+)%;height:([\\d.]+)%"[^>]*><strong>7节<\\/strong><span class="period-start">16:00<\\/span><span class="period-end">16:45<\\/span>`));
  assert.ok(seventh, 'seventh period must show both boundary times');
  assert.ok(Math.abs(Number(seventh[1]) - 100 * 16 / 24) < 1e-9);
  assert.ok(Math.abs(Number(seventh[2]) - 100 * 45 / 1440) < 1e-9);
};
verifyFullDayAxis(node('timelineGrid').innerHTML, 'period-slot');
assert.match(node('timelineGrid').innerHTML, /class="gym-time-tag aux" style="top:[^"]+">07:00<\/div>/);
const sundayBand = node('timelineGrid').innerHTML.match(/class="day-lane (gym-(?:odd|even)) [^"]*" style="grid-column:8;grid-row:2"/)?.[1];
node('nextWeek').listeners.click();
const nextMondayBand = node('timelineGrid').innerHTML.match(/class="day-lane (gym-(?:odd|even)) [^"]*" style="grid-column:2;grid-row:2"/)?.[1];
assert.ok(sundayBand && nextMondayBand && sundayBand !== nextMondayBand, 'gym backgrounds must alternate across week boundaries');
node('prevWeek').listeners.click();

segments[1].listeners.click();
assert.match(node('dayDashboard').innerHTML, /现在可以去健身/);
assert.match(node('dayMap').innerHTML, /应用数理统计/);
assert.match(node('dayMap').innerHTML, /第7–8节 · 16:00–17:40/);
assert.match(node('dayMap').innerHTML, /生命B101 · 04班（浑南）/);
verifyFullDayAxis(node('dayMap').innerHTML, 'map-period');
assert.match(node('dayMap').innerHTML, /00:00–24:00/);
assert.match(node('dayMap').innerHTML, /day-progress/);

node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: '4' } } : null } });
assert.match(node('courseDetailBody').innerHTML, /班级/);
assert.match(node('courseDetailBody').innerHTML, /04班（浑南）/);
node('skipCourseButton').listeners.click();
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="4"/);
segments[0].listeners.click();
assert.match(node('timelineGrid').innerHTML, /class="course-block [^"]*skipped"[^>]*data-course="4"/);
segments[1].listeners.click();
assert.match(node('dayDashboard').innerHTML, /已跳过 1 节/);
assert.match(node('dayDashboard').innerHTML, /一键撤销全部旷课/);
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-undo-all]' ? {} : null } });
assert.match(node('dayMap').innerHTML, /data-course="4"/);
assert.equal(store.get('neu-schedule-skipped-v7'), '[]');

node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: '4' } } : null } });
node('skipCourseButton').listeners.click();
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="4"/);

node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-undo]' ? { dataset: { undo: '4' } } : null } });
assert.match(node('dayMap').innerHTML, /data-course="4"/);

node('nextWeek').listeners.click();
node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: '4' } } : null } });
assert.equal(node('skipCourseButton').disabled, true, 'future-day course must not be skippable');
node('skipCourseButton').listeners.click();
assert.equal(store.get('neu-schedule-skipped-v7'), '[]');
node('prevWeek').listeners.click();

node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'start-gym' } } : null } });
assert.match(node('dayDashboard').innerHTML, /正在健身/);
segments[2].listeners.click();
assert.match(node('gymPanel').innerHTML, /正在健身/);
assert.match(node('gymPanel').innerHTML, /训练趋势/);
node('gymPanel').listeners.click({ target: { closest: selector => selector === '[data-gym-command]' ? { dataset: { gymCommand: 'stop' } } : null } });
assert.match(store.get('neu-schedule-gym-sessions-v1'), /"endAt":/);
segments[1].listeners.click();

fixedArgs = [2026, 8, 25, 15, 45];
tick();
assert.match(node('dayDashboard').innerHTML, /15 分钟后去 生命B101 上应用数理统计/);
fixedArgs = [2026, 8, 25, 11, 45];
tick();
assert.match(node('dayDashboard').innerHTML, /25 分钟后健身房开放/);

fixedArgs = [2026, 8, 21, 18, 45];
segments[0].listeners.click();
node('monday-head').listeners.click();
assert.match(node('dayDashboard').innerHTML, /正在上 论文规范/);
assert.match(node('dayDashboard').innerHTML, /翘掉论文规范/);
assert.match(node('dayDashboard').innerHTML, /data-action="start-gym"/, 'training must remain available during a course');
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'start-gym' } } : null } });
assert.match(node('dayDashboard').innerHTML, /正在健身/);
assert.match(node('dayDashboard').innerHTML, /正在上 论文写作与学术规范/);
assert.equal(store.get('neu-schedule-skipped-v7'), '[]', 'starting training must not skip a course');
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'end-gym' } } : null } });
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-skip]' ? { dataset: { skip: '10' } } : null } });
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="10"/);
assert.doesNotMatch(node('dayDashboard').innerHTML, /正在健身/);
assert.match(store.get('neu-schedule-skipped-v7'), /2026-09-21:10/);

fixedArgs = [2026, 8, 22, 0, 1];
tick();
assert.equal(store.get('neu-schedule-skipped-v7'), '[]', 'midnight must clear every skip');
assert.doesNotMatch(node('dayDashboard').innerHTML, /已跳过/);
assert.match(node('dayDashboard').innerHTML, /周二/);
assert.ok(store.get('neu-schedule-gym-sessions-v1'), 'completed gym sessions must persist after midnight');

node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: '3' } } : null } });
node('skipCourseButton').listeners.click();
assert.match(store.get('neu-schedule-skipped-v7'), /2026-09-22:3/);
fixedArgs = [2026, 8, 23, 0, 1];
lifecycle.get('document:visibilitychange')();
assert.equal(store.get('neu-schedule-skipped-v7'), '[]', 'resuming on the next day must clear skips');
assert.match(node('dayDashboard').innerHTML, /周三/);

for (const id of ['0', '5']) {
  node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: id } } : null } });
  node('skipCourseButton').listeners.click();
}
assert.match(node('dayDashboard').innerHTML, /已跳过 2 节/);
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-undo-all]' ? {} : null } });
assert.equal(store.get('neu-schedule-skipped-v7'), '[]', 'one click must restore all skipped courses');
assert.match(node('dayMap').innerHTML, /data-course="0"/);
assert.match(node('dayMap').innerHTML, /data-course="5"/);
console.log('UI state transitions OK');
