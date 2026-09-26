import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { encode } from '../worker/node_modules/@simplewebauthn/server/esm/helpers/iso/isoCBOR.js';

const base = 'http://127.0.0.1:8791';
const origin = 'https://neu-schedule-push-api.pages.dev';
const rpID = new URL(origin).hostname;
const b64 = value => Buffer.from(value).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
async function post(path, body, cookie, token) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}
async function get(path, cookie) {
  const response = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  return { status: response.status, body: await response.json() };
}

const offered = await post('/auth/enroll/options', { setupKey: 'local-test' });
assert.equal(offered.status, 200);
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const credentialID = randomBytes(32);
const credentialID64 = b64(credentialID);
const coseKey = encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
const rpHash = digest(rpID);
const registrationData = Buffer.concat([
  rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
  Buffer.from([0, credentialID.length]), credentialID, Buffer.from(coseKey)
]);
const registrationClient = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: offered.body.options.challenge, origin, crossOrigin: false }));
const registration = {
  id: credentialID64, rawId: credentialID64, type: 'public-key',
  response: { clientDataJSON: b64(registrationClient), attestationObject: b64(encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', registrationData]]))), transports: ['internal'] },
  clientExtensionResults: {}, authenticatorAttachment: 'platform'
};
const enrolled = await post('/auth/enroll/verify', { setupKey: 'local-test', ticket: offered.body.ticket, response: registration });
assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
assert.equal((await get('/auth/status')).body.enrolled, true);
assert.equal((await get('/auth/status')).body.enrollmentOpen, false);
assert.equal((await get('/state')).status, 401);
assert.equal((await post('/auth/enroll/options', { setupKey: 'local-test' })).status, 403);
assert.equal((await post('/auth/login', { code: 'local-test' })).status, 403);

const loginOptions = await post('/auth/login/options', {});
assert.equal(loginOptions.status, 200);
const assertionClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: loginOptions.body.options.challenge, origin, crossOrigin: false }));
const assertionData = Buffer.concat([rpHash, Buffer.from([0x05]), Buffer.alloc(4)]);
const signature = sign('sha256', Buffer.concat([assertionData, digest(assertionClient)]), privateKey);
const assertion = {
  id: credentialID64, rawId: credentialID64, type: 'public-key',
  response: { clientDataJSON: b64(assertionClient), authenticatorData: b64(assertionData), signature: b64(signature), userHandle: null },
  clientExtensionResults: {}, authenticatorAttachment: 'platform'
};
const loggedIn = await post('/auth/login/verify', { ticket: loginOptions.body.ticket, response: assertion });
assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
assert.match(loggedIn.cookie, /__Host-neu_session=.*HttpOnly; Secure; SameSite=Strict/);
const cookie = loggedIn.cookie.split(';')[0];
assert.equal((await get('/auth/status', cookie)).body.authenticated, true);
assert.equal((await get('/state', cookie)).status, 200);
const schedule = await get('/schedule', cookie);
assert.equal(schedule.status, 200);
assert.equal(schedule.body.data.courses.length, 12);
const now = Date.now();
const gymSession = { id: 'passkey-integration', startAt: now - 3600000, endAt: now - 1800000, closesAt: now, endReason: 'manual' };
const committed = await post('/state/commit', { ops: [{ type: 'session-upsert', session: gymSession }] }, cookie);
assert.equal(committed.status, 200, JSON.stringify(committed.body));
assert(committed.body.sessions.some(session => session.id === gymSession.id));
const subscription = { endpoint: `https://web.push.apple.com/local-${randomBytes(8).toString('hex')}`, keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
const registeredPush = await post('/register', { subscription }, cookie);
assert.equal(registeredPush.status, 200, JSON.stringify(registeredPush.body));
const job = { id: 'passkey-test-reminder', dueAt: now + 3600000, title: '课程提醒', body: '地点', ttl: 600 };
assert.equal((await post('/sync', { jobs: [job] }, cookie, registeredPush.body.token)).status, 200);
assert.equal((await post('/sync', { jobs: [job] }, undefined, registeredPush.body.token)).status, 401);
assert.equal((await post('/disable', {}, cookie, registeredPush.body.token)).status, 200);
assert.equal((await post('/auth/login/verify', { ticket: loginOptions.body.ticket, response: assertion })).status, 403);
assert.equal((await post('/auth/logout', {}, cookie)).status, 200);
assert.equal((await get('/state', cookie)).status, 401);
console.log('Single passkey registration, signed login, data and push authorization, replay rejection and logout OK');
