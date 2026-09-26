import { rawPayload, sendPushNotification } from '@mmmike/web-push/send';

const encoder = new TextEncoder();
const MAX_JOBS = 1800;
const MAX_BODY = 180_000;
const DAY = 86_400_000;

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

function cors(request, env) {
  return request.headers.get('origin') === env.APP_ORIGIN ? {
    'access-control-allow-origin': env.APP_ORIGIN,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'Origin'
  } : null;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function validSubscription(value) {
  if (!value || typeof value !== 'object' || !value.keys) return false;
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed = host === 'fcm.googleapis.com' || host.endsWith('.push.apple.com') || host.endsWith('.push.services.mozilla.com');
    return url.protocol === 'https:' && allowed && value.endpoint.length <= 1200 &&
      /^[A-Za-z0-9_-]{80,200}$/.test(value.keys.p256dh) && /^[A-Za-z0-9_-]{12,50}$/.test(value.keys.auth);
  } catch { return false; }
}

async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new Error('请求过大');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('请求过大');
  return JSON.parse(text);
}

async function deviceFor(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)?.[1];
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await sha256(token)).first();
}

function validJob(job, now) {
  return job && typeof job === 'object' &&
    /^[a-z0-9:-]{4,90}$/.test(job.id) && Number.isSafeInteger(job.dueAt) &&
    job.dueAt > now + 5000 && job.dueAt < now + 210 * DAY &&
    typeof job.title === 'string' && job.title.length > 0 && job.title.length <= 80 &&
    typeof job.body === 'string' && job.body.length <= 180 &&
    Number.isInteger(job.ttl) && job.ttl >= 60 && job.ttl <= 3600;
}

function pushPayload(title, body, appUrl) {
  return rawPayload(JSON.stringify({
    web_push: 8030,
    notification: { title, body, navigate: appUrl, lang: 'zh-CN', dir: 'ltr', silent: false }
  }));
}

async function send(device, title, body, ttl, env) {
  return sendPushNotification(
    { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
    pushPayload(title, body, env.APP_URL),
    { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    { ttl, urgency: 'high', timeoutMs: 10000 }
  );
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
  if (request.method === 'GET' && url.pathname === '/config') return json({ publicKey: env.VAPID_PUBLIC_KEY });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: '未找到接口' }, 404);
  let input;
  try { input = await readJson(request); }
  catch { return json({ error: '无效的 JSON 或请求过大' }, 400); }

  if (url.pathname === '/register') {
    if (!env.PAIRING_CODE || !safeEqual(input.code, env.PAIRING_CODE)) return json({ error: '配对码不正确' }, 401);
    if (!validSubscription(input.subscription)) return json({ error: '无效的推送订阅' }, 400);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM devices WHERE endpoint = ?').bind(input.subscription.endpoint),
      env.DB.prepare('INSERT INTO devices (id, token_hash, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, await sha256(token), input.subscription.endpoint, input.subscription.keys.p256dh, input.subscription.keys.auth, now, now)
    ]);
    return json({ token });
  }

  const device = await deviceFor(request, env);
  if (!device) return json({ error: '订阅凭证已失效，请重新配对' }, 401);

  if (url.pathname === '/sync') {
    const jobs = input.jobs;
    const now = Date.now();
    if (!Array.isArray(jobs) || jobs.length > MAX_JOBS || !jobs.every(job => validJob(job, now))) return json({ error: '提醒计划无效' }, 400);
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) return json({ error: '提醒编号重复' }, 400);
    const hash = await sha256(JSON.stringify(jobs));
    if (hash === device.plan_hash) return json({ ok: true, count: jobs.length, unchanged: true });
    const commands = [env.DB.prepare('DELETE FROM reminders WHERE device_id = ? AND sent_at IS NULL').bind(device.id)];
    for (let i = 0; i < jobs.length; i += 75) {
      const part = jobs.slice(i, i + 75);
      const values = part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      const params = part.flatMap(job => [device.id, job.id, job.dueAt, job.title, job.body, job.ttl]);
      commands.push(env.DB.prepare(`INSERT OR IGNORE INTO reminders (device_id, reminder_id, due_at, title, body, ttl) VALUES ${values}`).bind(...params));
    }
    commands.push(env.DB.prepare('UPDATE devices SET plan_hash = ?, updated_at = ? WHERE id = ?').bind(hash, now, device.id));
    await env.DB.batch(commands);
    return json({ ok: true, count: jobs.length });
  }

  if (url.pathname === '/test') {
    const now = Date.now();
    if (device.test_at && now - device.test_at < 60000) return json({ error: '请稍后再试' }, 429);
    await env.DB.prepare('UPDATE devices SET test_at = ? WHERE id = ?').bind(now, device.id).run();
    const delivered = await send(device, '课表提醒测试', '后台推送已连接。', 300, env);
    if (!delivered) { await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run(); return json({ error: '订阅已失效，请重新开启' }, 410); }
    return json({ ok: true });
  }

  if (url.pathname === '/disable') {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
    return json({ ok: true });
  }
  return json({ error: '未找到接口' }, 404);
}

async function dispatchDue(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(`
    SELECT r.*, d.endpoint, d.p256dh, d.auth FROM reminders r
    JOIN devices d ON d.id = r.device_id
    WHERE r.due_at <= ? AND r.due_at > ? AND r.attempts < 4
      AND r.sent_at IS NULL AND (r.claim_at IS NULL OR r.claim_at < ?)
    ORDER BY r.due_at LIMIT 40
  `).bind(now, now - 15 * 60000, now - 2 * 60000).all();
  for (const row of results) {
    const claim = await env.DB.prepare(`
      UPDATE reminders SET claim_at = ?, attempts = attempts + 1
      WHERE device_id = ? AND reminder_id = ? AND sent_at IS NULL AND (claim_at IS NULL OR claim_at < ?)
    `).bind(now, row.device_id, row.reminder_id, now - 2 * 60000).run();
    if (!claim.meta.changes) continue;
    try {
      const delivered = await send(row, row.title, row.body, row.ttl, env);
      if (!delivered) {
        await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(row.device_id).run();
      } else {
        await env.DB.prepare('UPDATE reminders SET sent_at = ?, claim_at = NULL WHERE device_id = ? AND reminder_id = ?').bind(Date.now(), row.device_id, row.reminder_id).run();
      }
    } catch (error) {
      console.error('Push delivery failed', { status: error.statusCode || null, reminderId: row.reminder_id });
      await env.DB.prepare('UPDATE reminders SET claim_at = NULL WHERE device_id = ? AND reminder_id = ?').bind(row.device_id, row.reminder_id).run();
    }
  }
  await env.DB.prepare('DELETE FROM reminders WHERE due_at < ?').bind(now - DAY).run();
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (request.headers.has('origin') && !headers) return json({ error: '来源不允许' }, 403);
    try {
      const response = await route(request, env);
      if (headers) for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    } catch (error) {
      console.error('Request failed', error?.message || String(error));
      const response = json({ error: '服务暂时不可用' }, 500);
      if (headers) for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
  },
  async scheduled(_event, env) { await dispatchDue(env); }
};

export { validJob, validSubscription, pushPayload };
