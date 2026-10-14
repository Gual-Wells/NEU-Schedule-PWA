import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const values = new Map([['neu-schedule-view-mode', 'gym']]);
const storage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value))
};
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
const localSession = { id: 'legacy-session', startAt: Date.now() - 3600000, endAt: Date.now() - 1800000, closesAt: Date.now(), endReason: 'manual' };
let serverSessions = [];
let serverRestores = [];
let serverSettings = {};
let commits = 0;
const fakeFetch = async (url, options = {}) => {
  const path = new URL(url, 'https://example.test').pathname;
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers?.authorization, undefined);
  if (path === '/state/commit') {
    commits++;
    for (const op of JSON.parse(options.body).ops) {
      if (op.type === 'session-upsert') serverSessions = [...serverSessions.filter(item => item.id !== op.session.id), op.session];
      if (op.type === 'session-delete') serverSessions = serverSessions.filter(item => item.id !== op.id);
      if (op.type === 'restores') { assert.equal(op.day, day); serverRestores = op.ids; }
      if (op.type === 'settings') serverSettings = op.settings;
    }
  }
  return { ok: true, status: 200, json: async () => ({ sessions: serverSessions, restores: serverRestores, skipDay: day, settings: serverSettings }) };
};
const context = {
  window: { AUTHENTICATED: true },
  localStorage: storage,
  fetch: fakeFetch,
  setTimeout,
  Date,
  Intl,
  JSON,
  console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8'), context);
const cloud = context.window.CloudSync;
let applied;
let lastStatus;
await cloud.initialize({
  snapshot: () => ({ sessions: [localSession], restores: [2], viewMode: 'gym' }),
  apply: state => { applied = state; },
  status: message => { lastStatus = message; }
});
assert.equal(serverSessions.length, 1, 'legacy session is uploaded before remote state replaces cache');
assert.equal(applied.sessions[0].id, localSession.id);
assert.deepEqual(Array.from(applied.restores), [2]);
assert.equal(serverSettings.viewMode, 'gym');
assert.equal(lastStatus, '云端已同步');
const afterMigration = commits;
await cloud.sync();
assert.equal(commits, afterMigration, 'second refresh does not reimport legacy sessions');
cloud.recordSessions([localSession], []);
await new Promise(resolve => setTimeout(resolve, 25));
await cloud.sync();
assert.equal(serverSessions.length, 0, 'deletion reaches D1 rather than being resurrected from local cache');
const earlyValues = new Map([['neu-schedule-view-mode', 'week']]);
let releaseFirstCommit;
const firstCommitHeld = new Promise(resolve => { releaseFirstCommit = resolve; });
let holdCommit = true;
let finalMode;
const earlyContext = {
  window: { AUTHENTICATED: true },
  localStorage: {
    getItem: key => earlyValues.get(key) ?? null,
    setItem: (key, value) => earlyValues.set(key, String(value))
  },
  fetch: async (url, options = {}) => {
    if (url === '/state/commit') {
      if (holdCommit) { holdCommit = false; await firstCommitHeld; }
      for (const op of JSON.parse(options.body).ops)
        if (op.type === 'settings') finalMode = op.settings.viewMode;
    }
    return { ok: true, status: 200, json: async () => ({ sessions: [], restores: [], skipDay: day, settings: { viewMode: finalMode } }) };
  },
  setTimeout, Date, Intl, JSON, console
};
vm.createContext(earlyContext);
vm.runInContext(fs.readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8'), earlyContext);
const earlyCloud = earlyContext.window.CloudSync;
const initializing = earlyCloud.initialize({
  snapshot: () => ({ sessions: [], restores: [], viewMode: 'week' }),
  apply() {}, status() {}
});
await new Promise(resolve => setTimeout(resolve, 0));
earlyCloud.recordSettings('day');
releaseFirstCommit();
await initializing;
assert.equal(finalMode, 'day', 'tab changes during first sync must reach the server');

const racing = new Map([['neu-schedule-data-migrated-v1', 'yes']]);
let releaseRead, readStarted = false;
const held = new Promise(resolve => { releaseRead = resolve; });
const raceContext = {
  window: { AUTHENTICATED: true },
  localStorage: { getItem: k => racing.get(k) ?? null, setItem: (k, v) => racing.set(k, String(v)) },
  fetch: async url => {
    if (url === '/state') { readStarted = true; await held; }
    return { ok: true, status: 200, json: async () => ({ sessions: [], restores: [], skipDay: day, settings: {} }) };
  },
  setTimeout, Date, Intl, JSON, console
};
vm.createContext(raceContext);
vm.runInContext(fs.readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8'), raceContext);
let raceApplied;
const raceCloud = raceContext.window.CloudSync;
const loading = raceCloud.initialize({ snapshot: () => ({ sessions: [], restores: [], viewMode: 'week' }), apply: s => { raceApplied = s; }, status() {} });
for (let i = 0; i < 20 && !readStarted; i++) await new Promise(resolve => setTimeout(resolve, 0));
assert(readStarted, 'cloud read must be in flight');
raceCloud.recordRestores([4]);
releaseRead();
await loading;
assert.deepEqual(Array.from(raceApplied.restores), [4], 'late cloud reads must not undo manual restoration');
console.log('Cloud migration, restores, deletion and in-flight race protection OK');
