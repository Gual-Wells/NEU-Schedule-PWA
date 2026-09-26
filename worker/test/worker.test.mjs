import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { validJob, validSubscription } from '../src/index.js';

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
