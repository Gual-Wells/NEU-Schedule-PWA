import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8791';
const origin = 'https://gual-wells.github.io';
async function request(path, body, token) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
const denied = await request('/schedule');
assert.equal(denied.status, 401);
assert.equal((await request('/state')).status, 401);
assert.equal((await request('/auth/login', { code: 'wrong' })).status, 401);
const login = await request('/auth/login', { code: 'local-test' });
assert.equal(login.status, 200);
const token = login.body.token;
const schedule = await request('/schedule', undefined, token);
assert.equal(schedule.status, 200);
assert.equal(schedule.body.data.courses.length, 12);
assert.equal(schedule.body.data.gym.availability[1].length > 0, true);
assert.equal((await request('/schedule', { data: schedule.body.data }, token)).status, 401);
const start = Date.now() - 3600000;
const session = { id: 'local-test-session', startAt: start, endAt: start + 1800000, closesAt: start + 3600000, endReason: 'manual' };
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
const committed = await request('/state/commit', { ops: [
  { type: 'session-upsert', session },
  { type: 'skips', day, ids: [1, 2] },
  { type: 'settings', settings: { viewMode: 'gym' } }
] }, token);
assert.equal(committed.status, 200, JSON.stringify(committed.body));
assert(committed.body.sessions.some(item => item.id === session.id));
assert.deepEqual(committed.body.skips, [1, 2]);
assert.equal(committed.body.settings.viewMode, 'gym');
assert.equal((await request('/state/commit', { ops: [{ type: 'skips', day: '2026-01-01', ids: [1] }] }, token)).status, 400);
const removed = await request('/state/commit', { ops: [{ type: 'session-delete', id: session.id }, { type: 'skips', day, ids: [] }] }, token);
assert.equal(removed.status, 200);
assert(!removed.body.sessions.some(item => item.id === session.id));
assert.deepEqual(removed.body.skips, []);
assert.equal((await request('/auth/logout', {}, token)).status, 200);
assert.equal((await request('/schedule', undefined, token)).status, 401);
console.log('Local D1 login, private schedule, sessions, daily skips and settings OK');
