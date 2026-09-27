import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validJob, validSubscription } from '../src/index.js';
import { generateVapidKeys } from '@mmmike/web-push/vapid';
import { sendPushNotification, rawPayload } from '@mmmike/web-push/send';

const env = {
  APP_ORIGIN: 'https://neu-schedule-push-api.pages.dev',
  APP_URL: 'https://neu-schedule-push-api.pages.dev/?view=day',
  VAPID_PUBLIC_KEY: 'public'
};
const sub = { endpoint: 'https://web.push.apple.com/Q', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };

test('subscription only accepts recognized HTTPS push endpoints', () => {
  assert(validSubscription(sub));
  assert(!validSubscription({ ...sub, endpoint: 'https://private.example/Q' }));
  assert(!validSubscription({ ...sub, endpoint: 'http://web.push.apple.com/Q' }));
});

test('reminder validation bounds timestamps and content', () => {
  const now = Date.now();
  const job = { id: '2026-10-01-c3-p30', dueAt: now + 60000, title: '上课', body: '地点', ttl: 600 };
  assert(validJob(job, now));
  assert(!validJob({ ...job, dueAt: now - 1000 }, now));
  assert(!validJob({ ...job, ttl: 100000 }, now));
  assert(!validJob({ ...job, id: '../escape' }, now));
});

test('health, CORS and authenticated push enrollment', async () => {
  const origin = { origin: env.APP_ORIGIN };
  const health = await worker.fetch(new Request('https://worker.test/health', { headers: origin }), env);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), env.APP_ORIGIN);
  const blocked = await worker.fetch(new Request('https://worker.test/config', { headers: { origin: 'https://evil.example' } }), env);
  assert.equal(blocked.status, 403);
  const unauthenticated = await worker.fetch(new Request('https://worker.test/register', {
    method: 'POST', headers: { ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub })
  }), env);
  assert.equal(unauthenticated.status, 401);
});

test('Web Push payload is encrypted and signed before sending', async () => {
  const vapid = { ...await generateVapidKeys(), subject: 'mailto:test@example.com' };
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const encode = bytes => Buffer.from(bytes).toString('base64url');
  const synthetic = {
    endpoint: 'https://web.push.apple.com/synthetic',
    keys: { p256dh: encode(publicBytes), auth: encode(crypto.getRandomValues(new Uint8Array(16))) }
  };
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, synthetic.endpoint);
    assert.equal(options.method, 'POST');
    assert(options.headers.Authorization || options.headers.authorization);
    assert(options.body.byteLength > 50);
    return new Response(null, { status: 201 });
  };
  try {
    const delivered = await sendPushNotification(synthetic, rawPayload(JSON.stringify({ web_push: 8030, notification: { title: '测试', navigate: env.APP_URL } })), vapid, { ttl: 600 });
    assert.equal(delivered, true);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('test push reports cooldown and a failed delivery does not lock future tests', async () => {
  const vapid = { ...await generateVapidKeys(), subject: 'mailto:test@example.com' };
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const encode = bytes => Buffer.from(bytes).toString('base64url');
  const device = {
    id: 'device-1', endpoint: 'https://web.push.apple.com/synthetic',
    p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    auth: encode(crypto.getRandomValues(new Uint8Array(16))), test_at: null
  };
  const db = {
    prepare(sql) {
      let args;
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes('FROM auth_sessions')) return { token_hash: 'session' };
          if (sql.includes('SELECT * FROM devices')) return device;
          if (sql.includes('SELECT test_at FROM devices')) return { test_at: device.test_at };
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          if (sql.includes('SET test_at = ?')) {
            if (device.test_at !== null && device.test_at > args[2]) return { meta: { changes: 0 } };
            device.test_at = args[0];
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET test_at = NULL')) {
            if (device.test_at === args[1]) device.test_at = null;
            return { meta: { changes: 1 } };
          }
          throw new Error(`Unexpected update: ${sql}`);
        }
      };
    }
  };
  const request = () => new Request('https://worker.test/test', {
    method: 'POST',
    headers: { origin: env.APP_ORIGIN, cookie: `__Host-neu_session=${'s'.repeat(43)}`, authorization: `Bearer ${'t'.repeat(43)}`, 'content-type': 'application/json' },
    body: '{}'
  });
  const previousFetch = globalThis.fetch;
  let providerStatus = 201;
  globalThis.fetch = async () => new Response(null, { status: providerStatus });
  const testEnv = { ...env, DB: db, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: vapid.subject };
  try {
    assert.equal((await worker.fetch(request(), testEnv)).status, 200);
    const limited = await worker.fetch(request(), testEnv);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /等待 \d+ 秒/);
    device.test_at = Date.now() - 10_001;
    providerStatus = 503;
    assert.equal((await worker.fetch(request(), testEnv)).status, 502);
    assert.equal(device.test_at, null);
    providerStatus = 201;
    assert.equal((await worker.fetch(request(), testEnv)).status, 200);
  } finally { globalThis.fetch = previousFetch; }
});
