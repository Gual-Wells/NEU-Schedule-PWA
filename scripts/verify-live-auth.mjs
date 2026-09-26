import assert from 'node:assert/strict';

const base = 'https://neu-schedule-push-api.pages.dev';
const html = await fetch(base + '/', { cache: 'no-store' });
assert.equal(html.status, 200);
assert.match(await html.text(), /auth-client\.js\?v=21/);
const browser = await fetch(base + '/webauthn-browser.js?v=21');
assert.equal(browser.status, 200);
const statusResponse = await fetch(base + '/auth/status', { cache: 'no-store' });
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.enrolled, false);
assert.equal(status.enrollmentOpen, false);
assert.equal(status.authenticated, false);
assert.equal((await fetch(base + '/schedule')).status, 401);
assert.equal((await fetch(base + '/state')).status, 401);
const post = (path, body) => fetch(base + path, {
  method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body)
});
assert.equal((await post('/auth/login', { code: 'irrelevant' })).status, 403);
assert.equal((await post('/auth/enroll/options', { setupKey: 'irrelevant' })).status, 403);
assert.equal((await post('/register', { subscription: {} })).status, 401);
console.log('Production Pages assets, locked enrollment, disabled legacy login and protected data verified');
