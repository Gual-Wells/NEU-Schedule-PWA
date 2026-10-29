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
store.set('neu-schedule-skipped-v7', JSON.stringify(['2026-09-24:6'])); // Ignored legacy skip.
store.set('neu-schedule-restored-v1', JSON.stringify(['2026-09-24:6'])); // Old day exception.
const lifecycle = new Map();
let remoteApply;
const sandbox = {
  Date: FixedDate,
  window: {
    addEventListener(name, fn) { lifecycle.set(`window:${name}`, fn); },
    CloudSync: {
      initialize({ apply }) { remoteApply = apply; return Promise.resolve(); },
      connected() { return true; },
      recordSessions() {}, recordMeetings() {}, recordRestores() {}, recordSettings() {},
      sync() { return Promise.resolve(); }
    }
  },
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
for (const file of ['daily-reminders.js', 'data.js', 'gym-store.js', 'meeting-store.js', 'app.js'])
  vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox, { filename: file });
assert.equal(store.get('neu-schedule-restored-v1'), '[]', 'old-day restores clear on startup');

assert.match(node('timelineGrid').innerHTML, /course-title/);
assert.match(node('timelineGrid').innerHTML, /course-skip-label">已翘/);
assert.equal(node('toolbarNote').textContent, '本周');
assert.doesNotMatch(node('timelineGrid').innerHTML, /course-period|course-time/);
assert.match(node('timelineGrid').innerHTML, /gym-odd/);
assert.match(node('timelineGrid').innerHTML, /gym-even/);
assert.match(node('timelineGrid').innerHTML, /period-slot/);
assert.equal((node('timelineGrid').innerHTML.match(/class="daily-marker /g)||[]).length,2,'only today has outing ticks');
const trainingTick = node('timelineGrid').innerHTML.match(/daily-marker training week[^>]+aria-label="12:30 外出训练"[^>]+top:([\d.]+)%/);
assert.ok(trainingTick && Math.abs(Number(trainingTick[1])-750/1440*100)<1e-9);
const mealTick = node('timelineGrid').innerHTML.match(/daily-marker meal week[^>]+top:([\d.]+)%/);
assert.ok(mealTick && Math.abs(Number(mealTick[1])-990/1440*100)<1e-9);

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
assert.doesNotMatch(node('timelineGrid').innerHTML,/daily-marker /,'other weeks have no today tick');
const nextMondayBand = node('timelineGrid').innerHTML.match(/class="day-lane (gym-(?:odd|even)) [^"]*" style="grid-column:2;grid-row:2"/)?.[1];
assert.ok(sundayBand && nextMondayBand && sundayBand !== nextMondayBand, 'gym backgrounds must alternate across week boundaries');
node('prevWeek').listeners.click();

segments[1].listeners.click();
assert.match(node('dayDashboard').innerHTML, /现在可以去健身/);
assert.match(node('dayMap').innerHTML, /应用数理统计/);
assert.match(node('dayMap').innerHTML, /class="map-course-time"><span>16:00–17:40<\/span><span class="map-course-period">第7–8节/);
assert.match(node('dayMap').innerHTML, /class="map-course-location">生命B101 · 04班（浑南）/);
assert.match(node('dayMap').innerHTML, /当日时间图/);
verifyFullDayAxis(node('dayMap').innerHTML, 'map-period');
assert.match(node('dayMap').innerHTML, /day-progress/);
assert.equal((node('dayMap').innerHTML.match(/class="daily-marker /g)||[]).length,2);
assert.match(node('dayMap').innerHTML, /daily-marker training day/);
assert.match(node('dayMap').innerHTML, /daily-marker meal day/);


const openCourse = id => node('dayMap').listeners.click({ target: { closest: s => s === '[data-course]' ? { dataset: { course: String(id) } } : null } });
const clickDay = (selector, dataset = {}) => node('dayDashboard').listeners.click({ target: { closest: s => s === selector ? { dataset } : null } });
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="4"/);
assert.match(node('dayDashboard').innerHTML, /已翘 1 节/);
openCourse(4);
assert.match(node('courseDetailBody').innerHTML, /04班（浑南）/);
assert.equal(node('skipCourseButton').textContent, '恢复这节课');
node('skipCourseButton').listeners.click();
assert.doesNotMatch(node('dayMap').innerHTML, /class="map-course skipped" data-course="4"/);
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-25:4/);
segments[0].listeners.click();
assert.doesNotMatch(node('timelineGrid').innerHTML, /class="course-block [^"]*skipped"[^>]*data-course="4"/);
segments[1].listeners.click();
openCourse(4);
assert.equal(node('skipCourseButton').textContent, '翘掉这节课');
node('skipCourseButton').listeners.click();
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="4"/);
assert.equal(store.get('neu-schedule-restored-v1'), '[]');
const undoTrigger = { dataset: {} };
node('dayDashboard').listeners.click({ target: { closest: selector => selector === '#undoTrigger' ? undoTrigger : null } });
assert.match(undoTrigger.outerHTML, /恢复第7–8节上课/);
clickDay('[data-undo]', { undo: '4' });
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-25:4/);
openCourse(4);
node('skipCourseButton').listeners.click();
clickDay('[data-undo-all]');
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-25:4/);
node('nextWeek').listeners.click();
openCourse(4);
assert.equal(node('skipCourseButton').disabled, true);
node('prevWeek').listeners.click();

fixedArgs = [2026, 8, 25, 15, 45];
tick();
assert.match(node('dayDashboard').innerHTML, /15 分钟后去 生命B101 上应用数理统计/);
fixedArgs = [2026, 8, 25, 11, 45];
tick();
assert.match(node('dayDashboard').innerHTML, /25 分钟后健身房开放/);

fixedArgs = [2026, 8, 21, 18, 45];
segments[0].listeners.click();
node('monday-head').listeners.click();
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="10"/);
assert.doesNotMatch(node('dayDashboard').innerHTML, /正在上 论文规范/);
openCourse(10);
node('skipCourseButton').listeners.click();
assert.match(node('dayDashboard').innerHTML, /正在上 论文规范/);
assert.match(node('dayDashboard').innerHTML, /data-action="start-gym"/);
const beforeTraining = store.get('neu-schedule-restored-v1');
clickDay('[data-action]', { action: 'start-gym' });
assert.match(node('dayDashboard').innerHTML, /正在健身/);
assert.equal(store.get('neu-schedule-restored-v1'), beforeTraining);
clickDay('[data-action]', { action: 'end-gym' });
clickDay('[data-skip]', { skip: '10' });
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="10"/);
assert.equal(store.get('neu-schedule-restored-v1'), '[]');

fixedArgs = [2026, 8, 22, 0, 1];
tick();
assert.equal(store.get('neu-schedule-restored-v1'), '[]');
assert.match(node('dayDashboard').innerHTML, /周二/);
assert.ok(store.get('neu-schedule-gym-sessions-v1'), 'gym sessions persist across midnight');
openCourse(3);
node('skipCourseButton').listeners.click();
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-22:3/);
fixedArgs = [2026, 8, 23, 0, 1];
lifecycle.get('document:visibilitychange')();
assert.equal(store.get('neu-schedule-restored-v1'), '[]');
assert.match(node('dayDashboard').innerHTML, /周三/);
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="0"/);
assert.match(node('dayMap').innerHTML, /class="map-course skipped" data-course="5"/);
clickDay('[data-undo-all]');
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-23:0/);
assert.match(store.get('neu-schedule-restored-v1'), /2026-09-23:5/);
segments[2].listeners.click();
assert.equal(node('weekCard').hidden, true);
remoteApply({ sessions: [], restores: [], skipDay: '2026-09-23', settings: { viewMode: 'week' } });
assert.equal(node('weekCard').hidden, true, 'delayed remote sync must not change selected tab');
segments[1].listeners.click();
const existingMeeting = { id:'legacy-meeting',startAt:Date.UTC(2026,8,26,6),endAt:null,endReason:null,confirmedAt:null };
remoteApply({sessions:[],meetings:[existingMeeting],restores:[],skipDay:'2026-09-23',settings:{viewMode:'day'}});
fixedArgs = [Date.UTC(2026,8,26,5)];
tick();
assert.match(node('dayMap').innerHTML, /data-meeting="legacy-meeting"/);
node('dayMap').listeners.click({target:{closest:s=>s==='[data-meeting]'?{dataset:{meeting:'legacy-meeting'}}:null}});
const meetingList = JSON.parse(store.get('neu-schedule-meetings-v1'));
assert.equal(meetingList.length, 1, 'existing synced meetings remain available');
assert.equal(meetingList[0].endAt, null);
assert.equal(node('meetingEndButton').hidden, true, 'cannot end future meetings');
assert.equal(node('meetingCancelButton').hidden, false);
node('meetingDetailDialog').open = true;
fixedArgs = [Date.UTC(2026, 8, 26, 7)];
tick();
assert.equal(node('meetingEndButton').hidden, false, 'open meeting sheet refreshes when start passes');
node('meetingEndButton').listeners.click();
const closedMeeting = JSON.parse(store.get('neu-schedule-meetings-v1'))[0];
assert.equal(closedMeeting.endAt, Date.UTC(2026, 8, 26, 7));
assert.equal(closedMeeting.endReason, 'manual');
assert.equal(node('meetingEndButton').hidden, true);
assert.match(node('meetingDetailTitle').textContent, /已手动结束/);
console.log('Default-skipped attendance, toggles, gym, rollover and UI and meeting controls OK');
