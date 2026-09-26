import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validJob, validSubscription } from '../src/index.js';
import { generateVapidKeys } from '@mmmike/web-push/vapid';
import { sendPushNotification, rawPayload } from '@mmmike/web-push/send';

const env = {
  APP_ORIGIN: 'https://gual-wells.github.io',
  APP_URL: 'https://gual-wells.github.io/NEU-Schedule-PWA/?view=day',
  VAPID_PUBLIC_KEY: 'public',
  PAIRING_CODE: 'secret'
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

test('health, CORS and pairing protection', async () => {
  const origin = { origin: env.APP_ORIGIN };
  const health = await worker.fetch(new Request('https://worker.test/health', { headers: origin }), env);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), env.APP_ORIGIN);
  const blocked = await worker.fetch(new Request('https://worker.test/config', { headers: { origin: 'https://evil.example' } }), env);
  assert.equal(blocked.status, 403);
  const pairing = await worker.fetch(new Request('https://worker.test/register', {
    method: 'POST', headers: { ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'wrong', subscription: sub })
  }), env);
  assert.equal(pairing.status, 401);
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
