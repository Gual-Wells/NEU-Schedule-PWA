(() => {
  'use strict';
  const QUEUE = 'neu-schedule-data-queue-v1';
  const MIGRATED = 'neu-schedule-data-migrated-v1';
  const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const set = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
  let queue = [];
  try { const saved = JSON.parse(get(QUEUE) || '[]'); if (Array.isArray(saved)) queue = saved; } catch {}
  let snapshot = () => ({ sessions: [], skips: [], viewMode: 'week' });
  let apply = () => {};
  let status = () => {};
  let busy = null;
  const connected = () => Boolean(window.AUTHENTICATED);
  function saveQueue() { set(QUEUE, JSON.stringify(queue)); }
  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin', cache: 'no-store'
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
    if (connected()) {
      try { await sync(); }
      catch (error) { status(error.status === 401 ? '登录已失效，请重新使用通行密钥' : `离线缓存中 · ${error.message}`); }
    } else status('请使用通行密钥登录');
  }
  async function logout() {
    try { if (connected()) await window.ScheduleAuth.logout(); }
    finally {
      window.AUTHENTICATED = false;
      set('neu-schedule-data-cache-v1', '');
    }
  }
  window.CloudSync = { initialize, logout, sync, connected, recordSessions, recordSkips, recordSettings };
})();
