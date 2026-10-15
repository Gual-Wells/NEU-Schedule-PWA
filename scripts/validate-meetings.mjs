import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const events = new Map();
const storage = { getItem: key => events.get(key) || null, setItem: (key, value) => events.set(key, String(value)) };
const at = Date.UTC(2026, 9, 14, 1, 0); // 09:00 on a Wednesday in China.
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [at])); }
  static now() { return at; }
}
const root = { window: {}, Date: FixedDate, Math, Intl, JSON, localStorage: storage,
  location: { search: '' }, URLSearchParams, setTimeout, clearTimeout, console };
vm.createContext(root);
for (const file of ['data.js', 'gym-store.js', 'meeting-store.js']) vm.runInContext(read(file), root);
const M = root.window.MeetingStore;
const meetingStore = M.create(storage);
const start = Date.UTC(2026, 9, 14, 6, 0); // 14:00 Asia/Shanghai
const first = meetingStore.plan(start, at);
assert.equal(first.endAt, null);
assert.equal(M.state(first, start - 1), 'planned');
assert.equal(M.state(first, start + 2 * 3600000), 'ongoing');
assert.equal(M.state(first, start + 4 * 3600000), 'extended');
assert.equal(M.state(first, start + 5 * 3600000), 'capped');
assert.equal(M.dayRange('2026-10-14')[0], Date.UTC(2026, 9, 13, 16));
assert.equal(meetingStore.forDay('2026-10-14').length, 1);
assert.throws(() => meetingStore.plan(start + 2 * 3600000, at), /重叠/);

const app = read('app.js').replace(/  boot\(\);\s*\}\)\(\);\s*$/,
  '  window.__meetTest = { dayFreeWindows, meetingBlock, buildPushJobs, meetingStore };\n})();');
assert.notEqual(app, read('app.js'), 'test hook should replace frontend bootstrap');
vm.runInContext(app, root);
const model = root.window.__meetTest;
assert.equal(JSON.stringify(model.dayFreeWindows(3, 7)),
  JSON.stringify([[420, 840], [1140, 1240]]), 'five-hour meeting holds gym availability');
const before = model.meetingBlock(first, '2026-10-14', 'day');
assert.match(before, /meeting-solid/);
assert.match(before, /meeting-extension/);
assert.match(before, /data-meeting=/);
const plans = model.buildPushJobs().filter(job => job.id.startsWith('meeting-'));
assert.equal(plans.length, 4, 'group meeting produces four distinct future reminder points');
assert.equal(new Set(plans.map(x => x.id)).size, 4);

const ended = model.meetingStore.stop(first.id, start + 2.5 * 3600000);
assert.equal(ended.endReason, 'manual');
assert.equal(M.state(ended, start + 7 * 3600000), 'completed');
assert.equal(JSON.stringify(model.dayFreeWindows(3, 7)),
  JSON.stringify([[420, 840], [990, 1240]]), 'manual ending releases remaining gym time');
assert.equal(model.buildPushJobs().filter(job => job.id.startsWith('meeting-')).length, 0);
assert.throws(() => model.meetingStore.cancel(first.id, at), /只能取消/);
const refreshed = M.create(storage);
assert.equal(refreshed.list()[0].endAt, ended.endAt, 'manual end survives reload');
assert.equal(refreshed.stop(first.id, start + 4 * 3600000).endAt, ended.endAt, 'end is immutable');
assert.doesNotMatch(model.meetingBlock(ended, '2026-10-14', 'day'), /meeting-extension(?! actual)/);

const late = refreshed.plan(start + 6 * 3600000, at);
const lateEnd = refreshed.stop(late.id, late.startAt + 7 * 3600000);
assert.equal(lateEnd.endAt, late.startAt + M.MAXIMUM);
assert.equal(lateEnd.endReason, 'late');
assert.equal(lateEnd.confirmedAt, late.startAt + 7 * 3600000);

const midnight = refreshed.plan(Date.UTC(2026, 9, 15, 14, 0), at); // 22:00 China
assert.equal(refreshed.forDay('2026-10-15').some(x => x.id === midnight.id), true);
assert.equal(refreshed.forDay('2026-10-16').some(x => x.id === midnight.id), true);
assert.match(model.meetingBlock(midnight, '2026-10-16', 'day'), /组会·续/);

const tomorrow = refreshed.plan(Date.UTC(2026, 9, 16, 6), at);
refreshed.cancel(tomorrow.id, at);
assert(!refreshed.list().some(x => x.id === tomorrow.id));
assert(!refreshed.list().some(x => x.id === tomorrow.id && x.endAt !== null));
console.log('Meeting scheduling, 3h/5h rendering, end immutability, late confirmation, day split, gym and push OK');
