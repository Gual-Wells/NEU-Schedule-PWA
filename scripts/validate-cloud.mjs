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
let serverSkips = [];
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
      if (op.type === 'skips') { assert.equal(op.day, day); serverSkips = op.ids; }
      if (op.type === 'settings') serverSettings = op.settings;
    }
  }
  return { ok: true, status: 200, json: async () => ({ sessions: serverSessions, skips: serverSkips, skipDay: day, settings: serverSettings }) };
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
  snapshot: () => ({ sessions: [localSession], skips: [2], viewMode: 'gym' }),
  apply: state => { applied = state; },
  status: message => { lastStatus = message; }
});
assert.equal(serverSessions.length, 1, 'legacy session is uploaded before remote state replaces cache');
assert.equal(applied.sessions[0].id, localSession.id);
assert.deepEqual(Array.from(applied.skips), [2]);
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
    return { ok: true, status: 200, json: async () => ({ sessions: [], skips: [], skipDay: day, settings: { viewMode: finalMode } }) };
  },
  setTimeout, Date, Intl, JSON, console
};
vm.createContext(earlyContext);
vm.runInContext(fs.readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8'), earlyContext);
const earlyCloud = earlyContext.window.CloudSync;
const initializing = earlyCloud.initialize({
  snapshot: () => ({ sessions: [], skips: [], viewMode: 'week' }),
  apply() {}, status() {}
});
await new Promise(resolve => setTimeout(resolve, 0));
earlyCloud.recordSettings('day');
releaseFirstCommit();
await initializing;
assert.equal(finalMode, 'day', 'tab changes during first sync must reach the server');
console.log('Cloud legacy import, refresh and deletion OK');
