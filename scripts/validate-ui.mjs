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
const segments = ['week', 'day'].map(mode => {
  const element = node(`segment-${mode}`);
  element.dataset.mode = mode;
  return element;
});
node('monday-head').dataset.day = '1';
const store = new Map();
const sandbox = {
  Date: FixedDate,
  window: {},
  document: {
    getElementById: node,
    querySelectorAll(selector) { return selector === '.segment' ? segments : []; }
  },
  localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value) },
  navigator: {},
  requestAnimationFrame() {},
  setInterval(fn) { tick = fn; },
  Intl,
  console
};
vm.createContext(sandbox);
for (const file of ['data.js', 'app.js'])
  vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox, { filename: file });

assert.match(node('timelineGrid').innerHTML, /第7–8节/);
assert.match(node('timelineGrid').innerHTML, /16:00–17:40/);
assert.match(node('timelineGrid').innerHTML, /gym-odd/);
assert.match(node('timelineGrid').innerHTML, /gym-even/);
assert.match(node('timelineGrid').innerHTML, /period-slot/);
const sundayBand = node('timelineGrid').innerHTML.match(/class="day-lane (gym-(?:odd|even)) [^"]*" style="grid-column:8;grid-row:2"/)?.[1];
node('nextWeek').listeners.click();
const nextMondayBand = node('timelineGrid').innerHTML.match(/class="day-lane (gym-(?:odd|even)) [^"]*" style="grid-column:2;grid-row:2"/)?.[1];
assert.ok(sundayBand && nextMondayBand && sundayBand !== nextMondayBand, 'gym backgrounds must alternate across week boundaries');
node('prevWeek').listeners.click();

segments[1].listeners.click();
assert.match(node('dayDashboard').innerHTML, /现在可以去健身/);
assert.match(node('dayMap').innerHTML, /应用数理统计/);
assert.match(node('dayMap').innerHTML, /第7–8节 · 16:00–17:40/);
assert.match(node('dayMap').innerHTML, /day-progress/);

node('dayMap').listeners.click({ target: { closest: selector => selector === '[data-course]' ? { dataset: { course: '4' } } : null } });
node('skipCourseButton').listeners.click();
assert.doesNotMatch(node('dayMap').innerHTML, /data-course="4"/);
assert.match(node('dayDashboard').innerHTML, /已跳过 1 节/);

node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-undo]' ? { dataset: { undo: '4' } } : null } });
assert.match(node('dayMap').innerHTML, /data-course="4"/);

node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'start-gym' } } : null } });
assert.match(node('dayDashboard').innerHTML, /正在健身/);

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
assert.match(node('dayDashboard').innerHTML, /翘课去健身/);
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '[data-skip]' ? { dataset: { skip: '10', gym: 'yes' } } : null } });
assert.doesNotMatch(node('dayMap').innerHTML, /data-course="10"/);
assert.match(node('dayDashboard').innerHTML, /正在健身/);
console.log('UI state transitions OK');
