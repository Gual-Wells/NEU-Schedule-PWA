import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';

const encoder = new TextEncoder();
const MINUTE = 60_000;
const SESSION_AGE = 90 * 24 * 60 * MINUTE;
const COOKIE = '__Host-neu_session';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
const hash = async value => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const cookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const control = env => env.DB.prepare('SELECT epoch, enrollment_until FROM auth_control WHERE id = 1').first();
const credential = env => env.DB.prepare('SELECT * FROM auth_credential WHERE id = 1').first();

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}

function sessionToken(request) {
  const raw = request.headers.get('cookie') || '';
  const match = raw.match(/(?:^|;\s*)__Host-neu_session=([A-Za-z0-9_-]{40,60})(?:;|$)/);
  return match?.[1] || null;
}

export async function sessionFor(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  return env.DB.prepare(`SELECT s.token_hash FROM auth_sessions s
    JOIN auth_control c ON c.id = 1 AND c.epoch = s.epoch
    JOIN auth_credential k ON k.id = 1
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await hash(token), Date.now()).first();
}

export async function hasPasskey(env) { return Boolean(await credential(env)); }

async function challenge(env, kind, value, epoch, expiry) {
  const ticket = random();
  await env.DB.prepare('INSERT INTO auth_challenges (ticket_hash, kind, challenge, epoch, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hash(ticket), kind, value, epoch, expiry).run();
  return ticket;
}

async function consume(env, ticket, kind, epoch) {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(ticket)) return null;
  const ticketHash = await hash(ticket);
  const row = await env.DB.prepare('SELECT challenge FROM auth_challenges WHERE ticket_hash = ? AND kind = ? AND epoch = ? AND used_at IS NULL AND expires_at > ?')
    .bind(ticketHash, kind, epoch, Date.now()).first();
  if (!row) return null;
  const result = await env.DB.prepare('UPDATE auth_challenges SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(Date.now(), ticketHash, Date.now()).run();
  return result.meta.changes === 1 ? row.challenge : null;
}

async function issueSession(env, epoch, credentialId) {
  const token = random();
  const now = Date.now();
  const result = await env.DB.prepare(`INSERT INTO auth_sessions (token_hash, epoch, created_at, expires_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_control WHERE id = 1 AND epoch = ?)
    AND EXISTS (SELECT 1 FROM auth_credential WHERE id = 1 AND credential_id = ?)`)
    .bind(await hash(token), epoch, now, now + SESSION_AGE, epoch, credentialId).run();
  return result.meta.changes === 1 ? token : null;
}

export async function authRoute(request, env, input) {
  const path = new URL(request.url).pathname;
  if (path === '/auth/status' && request.method === 'GET') {
    const [settings, key, session] = await Promise.all([control(env), credential(env), sessionFor(request, env)]);
    return json({ enrolled: Boolean(key), authenticated: Boolean(session), enrollmentOpen: !key && settings.enrollment_until > Date.now() });
  }
  if (request.method !== 'POST') return json({ error: '未找到接口' }, 404);
  if (request.headers.get('origin') !== env.APP_ORIGIN) return json({ error: '来源不允许' }, 403);
  if (path === '/auth/logout') {
    const token = sessionToken(request);
    if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await hash(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  }
  const settings = await control(env);
  const key = await credential(env);
  const rpID = new URL(env.APP_ORIGIN).hostname;
  if (path === '/auth/enroll/options' || path === '/auth/enroll/verify') {
    if (key || settings.enrollment_until <= Date.now()) return json({ error: '登记窗口未开放' }, 403);
    if (!env.ENROLLMENT_KEY || !equal(input.setupKey, env.ENROLLMENT_KEY)) return json({ error: '初始化密钥无效' }, 401);
    if (path.endsWith('/options')) {
      const options = await generateRegistrationOptions({
        rpName: '个人课表', rpID, userName: 'owner', userDisplayName: '课表主人',
        userID: encoder.encode('neu-schedule-owner'), attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: [-7, -257]
      });
      const ticket = await challenge(env, 'enroll', options.challenge, settings.epoch, Math.min(Date.now() + 2 * MINUTE, settings.enrollment_until));
      return json({ options, ticket });
    }
    const expectedChallenge = await consume(env, input.ticket, 'enroll', settings.epoch);
    if (!expectedChallenge || settings.enrollment_until <= Date.now()) return json({ error: '登记已过期' }, 403);
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response: input.response, expectedChallenge, expectedOrigin: env.APP_ORIGIN, expectedRPID: rpID, requireUserVerification: true });
    } catch { return json({ error: '通行密钥验证失败' }, 400); }
    if (!verified.verified || !verified.registrationInfo) return json({ error: '通行密钥验证失败' }, 400);
    const passkey = verified.registrationInfo.credential;
    const inserted = await env.DB.prepare(`INSERT INTO auth_credential (id, credential_id, public_key, counter, transports, created_at)
      SELECT 1, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_control WHERE id = 1 AND epoch = ? AND enrollment_until > ?)`)
      .bind(passkey.id, b64url(passkey.publicKey), passkey.counter, JSON.stringify(passkey.transports || []), Date.now(), settings.epoch, Date.now()).run();
    if (inserted.meta.changes !== 1) return json({ error: '登记窗口已关闭' }, 409);
    await env.DB.batch([
      env.DB.prepare('UPDATE auth_control SET enrollment_until = 0 WHERE id = 1'),
      env.DB.prepare('DELETE FROM app_tokens'),
      env.DB.prepare('DELETE FROM auth_sessions'),
      env.DB.prepare('DELETE FROM devices')
    ]);
    return json({ ok: true });
  }
  if (path === '/auth/login/options') {
    if (!key) return json({ error: '尚未登记通行密钥' }, 403);
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: [{ id: key.credential_id, transports: JSON.parse(key.transports) }], userVerification: 'required' });
    const ticket = await challenge(env, 'login', options.challenge, settings.epoch, Date.now() + 2 * MINUTE);
    return json({ options, ticket });
  }
  if (path === '/auth/login/verify') {
    if (!key) return json({ error: '尚未登记通行密钥' }, 403);
    const expectedChallenge = await consume(env, input.ticket, 'login', settings.epoch);
    if (!expectedChallenge) return json({ error: '登录请求已过期' }, 403);
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: input.response, expectedChallenge, expectedOrigin: env.APP_ORIGIN, expectedRPID: rpID,
        requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: bytes(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) }
      });
    } catch { return json({ error: '通行密钥验证失败' }, 401); }
    if (!verified.verified) return json({ error: '通行密钥验证失败' }, 401);
    await env.DB.prepare('UPDATE auth_credential SET counter = ? WHERE id = 1 AND credential_id = ?')
      .bind(verified.authenticationInfo.newCounter, key.credential_id).run();
    const token = await issueSession(env, settings.epoch, key.credential_id);
    if (!token) return json({ error: '登录状态已变化，请重试' }, 409);
    return json({ ok: true }, 200, { 'set-cookie': cookie(token, Math.floor(SESSION_AGE / 1000)) });
  }
  return json({ error: '未找到接口' }, 404);
}
