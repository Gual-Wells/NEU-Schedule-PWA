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

async function appTokenFor(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,60})$/)?.[1];
  if (!token) return null;
  return env.DB.prepare('SELECT token_hash FROM app_tokens WHERE token_hash = ? AND created_at > ?').bind(await sha256(token), Date.now() - 90 * DAY).first();
}

function shanghaiDay(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function validSession(value) {
  const now = Date.now();
  return value && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(value.id) &&
    Number.isSafeInteger(value.startAt) && value.startAt > 0 && value.startAt <= now + 60000 &&
    Number.isSafeInteger(value.closesAt) && value.closesAt > value.startAt &&
    value.closesAt - value.startAt <= DAY &&
    (value.endAt === null || (Number.isSafeInteger(value.endAt) && value.endAt >= value.startAt && value.endAt <= value.closesAt)) &&
    (value.endReason === null || value.endReason === 'manual' || value.endReason === 'closing');
}

async function issueAppToken(env) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare('INSERT INTO app_tokens (token_hash, created_at, last_used_at) VALUES (?, ?, ?)').bind(await sha256(token), now, now).run();
  return json({ token });
}

async function readState(env) {
  const today = shanghaiDay();
  const [sessions, skips, settings] = await Promise.all([
    env.DB.prepare('SELECT id, start_at, end_at, closes_at, end_reason FROM gym_sessions ORDER BY start_at').all(),
    env.DB.prepare('SELECT course_ids FROM daily_skips WHERE day_key = ?').bind(today).first(),
    env.DB.prepare('SELECT content FROM app_settings WHERE id = 1').first()
  ]);
  return {
    sessions: sessions.results.map(row => ({ id: row.id, startAt: row.start_at, endAt: row.end_at, closesAt: row.closes_at, endReason: row.end_reason })),
    skips: skips ? JSON.parse(skips.course_ids) : [],
    skipDay: today,
    settings: settings ? JSON.parse(settings.content) : {}
  };
}

async function commitState(input, env) {
  if (!Array.isArray(input.ops) || input.ops.length < 1 || input.ops.length > 500) return json({ error: '同步操作无效' }, 400);
  const now = Date.now();
  const today = shanghaiDay(now);
  const commands = [];
  for (const op of input.ops) {
    if (op.type === 'session-upsert' && validSession(op.session)) {
      const s = op.session;
      commands.push(env.DB.prepare('INSERT INTO gym_sessions (id, start_at, end_at, closes_at, end_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at, end_at=excluded.end_at, closes_at=excluded.closes_at, end_reason=excluded.end_reason, updated_at=excluded.updated_at')
        .bind(s.id, s.startAt, s.endAt, s.closesAt, s.endReason, now));
    } else if (op.type === 'session-delete' && typeof op.id === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(op.id)) {
      commands.push(env.DB.prepare('DELETE FROM gym_sessions WHERE id = ?').bind(op.id));
    } else if (op.type === 'skips' && op.day === today && Array.isArray(op.ids) && op.ids.length <= 300 &&
      op.ids.every(id => Number.isInteger(id) && id >= 0 && id < 300)) {
      commands.push(env.DB.prepare('INSERT INTO daily_skips (day_key, course_ids, updated_at) VALUES (?, ?, ?) ON CONFLICT(day_key) DO UPDATE SET course_ids=excluded.course_ids, updated_at=excluded.updated_at')
        .bind(today, JSON.stringify([...new Set(op.ids)]), now));
    } else if (op.type === 'settings' && op.settings && ['week', 'day', 'gym'].includes(op.settings.viewMode) && Object.keys(op.settings).length === 1) {
      commands.push(env.DB.prepare('INSERT INTO app_settings (id, content, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at')
        .bind(JSON.stringify(op.settings), now));
    } else return json({ error: '同步操作无效或日期已过' }, 400);
  }
  commands.push(env.DB.prepare('DELETE FROM daily_skips WHERE day_key < ?').bind(today));
  await env.DB.batch(commands);
  return json({ ok: true, ...await readState(env) });
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
  if (request.method === 'GET' && url.pathname === '/schedule') {
    if (!await appTokenFor(request, env)) return json({ error: '请先登录' }, 401);
    const row = await env.DB.prepare('SELECT content, revision, updated_at FROM schedule_data WHERE id = 1').first();
    return row ? json({ data: JSON.parse(row.content), revision: row.revision, updatedAt: row.updated_at }) : json({ error: '课表尚未导入' }, 503);
  }
  if (request.method === 'GET' && url.pathname === '/state') {
    if (!await appTokenFor(request, env)) return json({ error: '请连接云端数据' }, 401);
    return json(await readState(env));
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: '未找到接口' }, 404);
  let input;
  try { input = await readJson(request); }
  catch { return json({ error: '无效的 JSON 或请求过大' }, 400); }

  if (url.pathname === '/auth/login') {
    if (!env.PAIRING_CODE || !safeEqual(input.code, env.PAIRING_CODE)) return json({ error: '配对码不正确' }, 401);
    return issueAppToken(env);
  }
  if (url.pathname === '/auth/logout') {
    const credential = await appTokenFor(request, env);
    if (!credential) return json({ error: '登录已失效' }, 401);
    await env.DB.prepare('DELETE FROM app_tokens WHERE token_hash = ?').bind(credential.token_hash).run();
    return json({ ok: true });
  }
  if (url.pathname === '/state/commit') {
    if (!await appTokenFor(request, env)) return json({ error: '请连接云端数据' }, 401);
    return commitState(input, env);
  }

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
    for (let i = 0; i < jobs.length; i += 100) {
      const part = jobs.slice(i, i + 100);
      commands.push(env.DB.prepare(`
        INSERT OR IGNORE INTO reminders (device_id, reminder_id, due_at, title, body, ttl)
        SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.dueAt'),
          json_extract(value, '$.title'), json_extract(value, '$.body'), json_extract(value, '$.ttl')
        FROM json_each(?)
      `).bind(device.id, JSON.stringify(part)));
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
  await env.DB.prepare('DELETE FROM daily_skips WHERE day_key < ?').bind(shanghaiDay(now)).run();
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
