import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8791';
const origin = 'https://gual-wells.github.io';
async function request(path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
const subscription = {
  endpoint: `https://web.push.apple.com/local-test-${crypto.randomUUID()}`,
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) }
};
const registered = await request('/register', { code: 'local-test', subscription });
assert.equal(registered.status, 200, JSON.stringify(registered.body));
const token = registered.body.token;
const job = { id: '2026-10-06-c3-p30', dueAt: Date.now() + 3_600_000, title: '课程提醒', body: '地点', ttl: 600 };
const synced = await request('/sync', { jobs: [job] }, token);
assert.equal(synced.status, 200, JSON.stringify(synced.body));
assert.equal(synced.body.count, 1);
const again = await request('/sync', { jobs: [job] }, token);
assert.equal(again.body.unchanged, true);
const replaced = await request('/sync', { jobs: [] }, token);
assert.equal(replaced.status, 200);
assert.equal(replaced.body.count, 0);
const disabled = await request('/disable', {}, token);
assert.equal(disabled.status, 200);
assert.equal((await request('/sync', { jobs: [] }, token)).status, 401);
console.log('Local D1 register/sync/replace/disable OK');
