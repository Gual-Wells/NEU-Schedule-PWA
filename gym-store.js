(() => {
  'use strict';

  const KEY = 'neu-schedule-gym-sessions-v1';
  const LEGACY_KEY = 'neu-schedule-gym-session-v7';

  function validSession(value) {
    return value && typeof value.id === 'string' && value.id.length > 0 &&
      Number.isSafeInteger(value.startAt) && value.startAt > 0 &&
      Number.isSafeInteger(value.closesAt) && value.closesAt > value.startAt &&
      (value.endAt === null || (Number.isSafeInteger(value.endAt) && value.endAt >= value.startAt && value.endAt <= value.closesAt)) &&
      (value.endReason === null || value.endReason === 'manual' || value.endReason === 'closing');
  }

  function create(storage, onChange = () => {}) {
    let sessions = [];
    try {
      const parsed = JSON.parse(storage.getItem(KEY) || '[]');
      if (Array.isArray(parsed)) sessions = parsed.filter(validSession).sort((a, b) => a.startAt - b.startAt);
    } catch (_) {}

    // The old value contained only a closing time, so it cannot become a truthful history entry.
    try { storage.removeItem(LEGACY_KEY); } catch (_) {}

    const list = () => sessions.map(session => ({ ...session }));
    const active = () => sessions.find(session => session.endAt === null) || null;
    function commit(next) {
      const before = list();
      storage.setItem(KEY, JSON.stringify(next));
      sessions = next;
      onChange(before, list());
      return list();
    }
    function replace(values) {
      if (!Array.isArray(values) || values.some(value => !validSession(value))) throw new Error('云端训练记录无效。');
      sessions = values.map(value => ({ ...value })).sort((a, b) => a.startAt - b.startAt);
      storage.setItem(KEY, JSON.stringify(sessions));
    }
    function reconcile(now) {
      const open = active();
      if (!open || now < open.closesAt) return false;
      commit(sessions.map(session => session.id === open.id
        ? { ...session, endAt: session.closesAt, endReason: 'closing' } : session));
      return true;
    }
    function start(startAt, closesAt) {
      if (active()) throw new Error('已有一段正在进行的训练。');
      if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(closesAt) || closesAt <= startAt)
        throw new Error('目前不在健身房开放时段。');
      const id = globalThis.crypto?.randomUUID?.() || `${startAt}-${Math.random().toString(36).slice(2)}`;
      const session = { id, startAt, endAt: null, closesAt, endReason: null };
      commit([...sessions, session]);
      return { ...session };
    }
    function stop(now) {
      const open = active();
      if (!open) return null;
      const endAt = Math.max(open.startAt, Math.min(now, open.closesAt));
      commit(sessions.map(session => session.id === open.id
        ? { ...session, endAt, endReason: endAt === open.closesAt ? 'closing' : 'manual' } : session));
      return endAt;
    }
    function revise(id, startAt, endAt) {
      const original = sessions.find(session => session.id === id);
      if (!original || original.endAt === null) throw new Error('只能修改已结束的训练。');
      if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt <= startAt || endAt > Date.now())
        throw new Error('结束时间必须晚于开始时间，且不能在未来。');
      if (sessions.some(session => session.id !== id && startAt < (session.endAt ?? Date.now()) && endAt > session.startAt))
        throw new Error('修改后的时间与另一段训练重叠。');
      const updated = { ...original, startAt, endAt, closesAt: Math.max(original.closesAt, endAt), endReason: 'manual' };
      commit(sessions.map(session => session.id === id ? updated : session).sort((a, b) => a.startAt - b.startAt));
    }
    function remove(id) {
      const original = sessions.find(session => session.id === id);
      if (!original || original.endAt === null) throw new Error('请先结束训练，再删除记录。');
      commit(sessions.filter(session => session.id !== id));
    }
    function importSessions(values) {
      if (!Array.isArray(values) || values.some(value => !validSession(value)))
        throw new Error('备份文件中的训练记录格式无效。');
      const byId = new Map(sessions.map(session => [session.id, session]));
      values.forEach(value => byId.set(value.id, value));
      const merged = [...byId.values()].sort((a, b) => a.startAt - b.startAt);
      if (merged.filter(session => session.endAt === null).length > 1 ||
        merged.some((session, index) => index && session.startAt < (merged[index - 1].endAt ?? merged[index - 1].closesAt)))
        throw new Error('备份文件包含重叠的训练记录。');
      commit(merged);
      reconcile(Date.now());
      return values.length;
    }
    return { list, active, reconcile, start, stop, revise, remove, importSessions, replace };
  }

  window.GymStore = { KEY, create };
})();
