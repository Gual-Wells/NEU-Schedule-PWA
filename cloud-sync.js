(() => {
  'use strict';
  const QUEUE = 'neu-schedule-data-queue-v1';
  const MIGRATED = 'neu-schedule-data-migrated-v1';
  const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const set = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
  let queue = [];
  try { const saved = JSON.parse(get(QUEUE) || '[]'); if (Array.isArray(saved)) queue = saved; } catch {}
  let snapshot = () => ({ sessions: [], meetings: [], restores: [], viewMode: 'week' });
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
  function recordMeetings(before, after) {
    if (!connected()) return;
    const old = new Map(before.map(item => [item.id, item]));
    const next = new Map(after.map(item => [item.id, item]));
    const ops = [];
    for (const item of after) {
      const previous = old.get(item.id);
      if (!previous) ops.push({ type: 'meeting-create', meeting: { id: item.id, startAt: item.startAt } });
      else if (previous.endAt === null && item.endAt !== null)
        ops.push({ type: 'meeting-end', id: item.id, confirmedAt: item.confirmedAt });
    }
    for (const item of before) if (!next.has(item.id))
      ops.push({ type: 'meeting-cancel', id: item.id, cancelledAt: Date.now() });
    enqueue(ops);
  }
  function overlayMeetings(items) {
    const byId = new Map((items || []).map(item => [item.id, item]));
    for (const op of queue) {
      if (op.type === 'meeting-create' && !byId.has(op.meeting.id))
        byId.set(op.meeting.id, { ...op.meeting, endAt: null, endReason: null, confirmedAt: null });
      else if (op.type === 'meeting-end' && byId.has(op.id)) {
        const item = byId.get(op.id);
        if (item.endAt === null) byId.set(op.id, { ...item,
          endAt: Math.min(op.confirmedAt, item.startAt + 5 * 3600000),
          endReason: op.confirmedAt > item.startAt + 5 * 3600000 ? 'late' : 'manual',
          confirmedAt: op.confirmedAt });
      } else if (op.type === 'meeting-cancel') byId.delete(op.id);
    }
    return [...byId.values()].sort((a, b) => a.startAt - b.startAt);
  }
  function recordRestores(ids) {
    if (connected()) enqueue([{ type: 'restores', day: today(), ids }]);
  }
  function recordSettings(viewMode) {
    if (connected()) enqueue([{ type: 'settings', settings: { viewMode } }]);
  }
  async function syncNow() {
    if (!connected()) return;
    if (get(MIGRATED) !== 'yes') {
      const local = snapshot();
      const initial = local.sessions.map(session => ({ type: 'session-upsert', session }));
      for (const meeting of local.meetings || []) {
        initial.push({ type: 'meeting-create', meeting: { id: meeting.id, startAt: meeting.startAt } });
        if (meeting.endAt !== null) initial.push({ type: 'meeting-end', id: meeting.id, confirmedAt: meeting.confirmedAt });
      }
      if (local.restores.length) initial.push({ type: 'restores', day: today(), ids: local.restores });
      if (get('neu-schedule-view-mode')) initial.push({ type: 'settings', settings: { viewMode: local.viewMode } });
      queue.unshift(...initial);
      saveQueue();
      set(MIGRATED, 'pending');
    }
    // Old skip-list writes cannot be replayed as restored-attendance exceptions.
    queue = queue.filter(op => op.type !== 'skips' && (op.type !== 'restores' || op.day === today()));
    saveQueue();
    while (queue.length) {
      const batch = queue.slice(0, 100);
      await request('/state/commit', { ops: batch });
      queue.splice(0, batch.length);
      saveQueue();
    }
    set(MIGRATED, 'yes');
    const state = await request('/state');
    // In-flight cloud reads cannot overwrite a later local attendance toggle.
    const pending = [...queue].reverse().find(op => op.type === 'restores' && op.day === today());
    if (pending) state.restores = pending.ids;
    state.meetings = overlayMeetings(state.meetings);
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
  window.CloudSync = { initialize, logout, sync, connected, recordSessions, recordMeetings, recordRestores, recordSettings };
})();
