(() => {
  'use strict';
  const QUEUE = 'neu-schedule-data-queue-v1';
  const MIGRATED = 'neu-schedule-data-migrated-v1';
  const base = () => String(window.PUSH_API_BASE || '').replace(/\/$/, '');
  const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const set = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
  let queue = [];
  try { const saved = JSON.parse(get(QUEUE) || '[]'); if (Array.isArray(saved)) queue = saved; } catch {}
  let snapshot = () => ({ sessions: [], skips: [], viewMode: 'week' });
  let apply = () => {};
  let status = () => {};
  let busy = null;
  const connected = () => Boolean(window.DATA_TOKEN && base());
  function saveQueue() { set(QUEUE, JSON.stringify(queue)); }
  async function request(path, body, token = window.DATA_TOKEN) {
    const response = await fetch(base() + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function enqueue(ops) {
    if (!ops.length) return;
    queue.push(...ops);
    saveQueue();
    if (connected()) sync().catch(error => status(`云端待同步：${error.message}`));
  }
  function recordSessions(before, after) {
    if (!connected() || get(MIGRATED) !== 'yes') return;
    const previous = new Map(before.map(item => [item.id, item]));
    const next = new Map(after.map(item => [item.id, item]));
    const ops = [];
    for (const item of after) if (JSON.stringify(item) !== JSON.stringify(previous.get(item.id))) ops.push({ type: 'session-upsert', session: item });
    for (const item of before) if (!next.has(item.id)) ops.push({ type: 'session-delete', id: item.id });
    enqueue(ops);
  }
  function recordSkips(ids) {
    if (connected() && get(MIGRATED) === 'yes') enqueue([{ type: 'skips', day: today(), ids }]);
  }
  function recordSettings(viewMode) {
    if (connected() && get(MIGRATED) === 'yes') enqueue([{ type: 'settings', settings: { viewMode } }]);
  }
  async function syncNow() {
    if (!connected()) return;
    if (get(MIGRATED) !== 'yes') {
      const local = snapshot();
      const initial = local.sessions.map(session => ({ type: 'session-upsert', session }));
      if (local.skips.length) initial.push({ type: 'skips', day: today(), ids: local.skips });
      if (get('neu-schedule-view-mode')) initial.push({ type: 'settings', settings: { viewMode: local.viewMode } });
      queue.unshift(...initial);
      saveQueue();
      set(MIGRATED, 'pending');
    }
    queue = queue.filter(op => op.type !== 'skips' || op.day === today());
    saveQueue();
    while (queue.length) {
      const batch = queue.slice(0, 100);
      await request('/state/commit', { ops: batch });
      queue.splice(0, batch.length);
      saveQueue();
    }
    set(MIGRATED, 'yes');
    const state = await request('/state');
    apply(state);
    status('云端已同步');
  }
  function sync() {
    if (busy) return busy;
    let completed = false;
    busy = syncNow().then(() => { completed = true; }).finally(() => {
      busy = null;
      if (completed && queue.length && connected()) setTimeout(() => sync().catch(error => status(`云端待同步：${error.message}`)), 1000);
    });
    return busy;
  }
  async function initialize(options) {
    snapshot = options.snapshot;
    apply = options.apply;
    status = options.status;
    if (!base()) { status('云端服务未配置'); return; }
    if (connected()) {
      try { await sync(); }
      catch (error) { status(error.status === 401 ? '云端身份已失效，请重新输入配对码' : `离线缓存中 · ${error.message}`); }
    } else status('输入配对码连接云端');
  }
  async function login(code) {
    if (!code) throw new Error('请输入配对码');
    const result = await request('/auth/login', { code }, null);
    window.DATA_TOKEN = result.token;
    await sync();
  }
  async function logout() {
    try { if (connected()) await request('/auth/logout', {}); }
    finally {
      window.DATA_TOKEN = '';
      set('neu-schedule-data-cache-v1', '');
    }
  }
  window.CloudSync = { initialize, login, logout, sync, connected, recordSessions, recordSkips, recordSettings };
})();
