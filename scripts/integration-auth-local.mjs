import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:8791';
const origin = 'https://neu-schedule-push-api.pages.dev';
async function get(path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}
async function post(path, body, requestOrigin = origin) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const status = await get('/auth/status');
assert.equal(status.status, 200);
assert.equal(status.body.enrolled, false);
assert.equal(status.body.authenticated, false);
assert.equal((await get('/schedule')).status, 401);
assert.equal((await get('/state')).status, 401);
assert.equal((await post('/auth/login', { code: 'local-test' })).status, 403);
assert.equal((await post('/auth/enroll/options', { setupKey: 'local-test' }, 'https://evil.example')).status, 403);
if (process.env.EXPECT_OPEN === '1') {
  assert.equal(status.body.enrollmentOpen, true);
  assert.equal((await post('/auth/enroll/options', { setupKey: 'incorrect' })).status, 401);
  const offered = await post('/auth/enroll/options', { setupKey: 'local-test' });
  assert.equal(offered.status, 200);
  assert.equal(offered.body.options.rp.id, 'neu-schedule-push-api.pages.dev');
  assert.equal(offered.body.options.authenticatorSelection.userVerification, 'required');
  assert.equal(typeof offered.body.ticket, 'string');
  assert.equal((await post('/auth/enroll/verify', { setupKey: 'local-test', ticket: offered.body.ticket, response: {} })).status, 400);
  assert.equal((await post('/auth/enroll/verify', { setupKey: 'local-test', ticket: offered.body.ticket, response: {} })).status, 403);
  assert.equal((await get('/auth/status')).body.enrolled, false);
  console.log('Window, setup key, WebAuthn options and single-use challenge OK');
} else {
  assert.equal(status.body.enrollmentOpen, false);
  assert.equal((await post('/auth/enroll/options', { setupKey: 'local-test' })).status, 403);
  console.log('Locked empty slot, no legacy login, protected data and origin gate OK');
}
