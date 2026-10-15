(() => {
  'use strict';

  // Meeting times are absolute timestamps; display and time-grid projection use campus local time.
  const KEY = 'neu-schedule-meetings-v1';
  const HOUR = 3600000;
  const EXPECTED = 3 * HOUR;
  const MAXIMUM = 5 * HOUR;
  const valid = value => Boolean(value && typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(value.id) &&
    Number.isSafeInteger(value.startAt) && value.startAt > 0 &&
    (value.endAt === null || (Number.isSafeInteger(value.endAt) &&
      value.endAt >= value.startAt && value.endAt <= value.startAt + MAXIMUM)) &&
    (value.endReason === null || value.endReason === 'manual' || value.endReason === 'late') &&
    (value.endAt === null) === (value.endReason === null) &&
    (value.confirmedAt === null || (Number.isSafeInteger(value.confirmedAt) && value.confirmedAt >= value.startAt)));

  function state(meeting, now = Date.now()) {
    if (meeting.endAt !== null) return 'completed';
    if (now < meeting.startAt) return 'planned';
    if (now < meeting.startAt + EXPECTED) return 'ongoing';
    if (now < meeting.startAt + MAXIMUM) return 'extended';
    return 'capped';
  }
  const occupiedEnd = meeting => meeting.endAt ?? meeting.startAt + MAXIMUM;
  function dayRange(dayKey) {
    const [year, month, day] = dayKey.split('-').map(Number);
    const start = Date.UTC(year, month - 1, day, -8);
    return [start, Date.UTC(year, month - 1, day + 1, -8)];
  }
  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }
  function create(storage, onChange = () => {}) {
    let meetings = [];
    try {
      const raw = JSON.parse(storage.getItem(KEY) || '[]');
      if (Array.isArray(raw)) meetings = raw.filter(valid).sort((a, b) => a.startAt - b.startAt);
    } catch (_) {}
    const list = () => meetings.map(item => ({ ...item }));
    function commit(next) {
      const before = list();
      storage.setItem(KEY, JSON.stringify(next));
      meetings = next;
      onChange(before, list());
    }
    function replace(items) {
      if (!Array.isArray(items) || items.some(item => !valid(item))) throw new Error('云端组会记录无效。');
      meetings = items.map(item => ({ ...item })).sort((a, b) => a.startAt - b.startAt);
      storage.setItem(KEY, JSON.stringify(meetings));
    }
    function forDay(dayKey) {
      const [from, to] = dayRange(dayKey);
      return meetings.filter(item => overlaps(item.startAt, occupiedEnd(item), from, to));
    }
    function plan(startAt, now = Date.now()) {
      if (!Number.isSafeInteger(startAt) || startAt < now - 60000)
        throw new Error('请选择当前或未来的组会开始时间。');
      if (meetings.some(item => overlaps(startAt, startAt + MAXIMUM, item.startAt, occupiedEnd(item))))
        throw new Error('组会五小时窗口与已有组会重叠。');
      const id = globalThis.crypto?.randomUUID?.() || 'm_' + startAt + '_' + Math.random().toString(36).slice(2, 10);
      const item = { id, startAt, endAt: null, endReason: null, confirmedAt: null };
      commit([...meetings, item].sort((a, b) => a.startAt - b.startAt));
      return { ...item };
    }
    function stop(id, now = Date.now()) {
      const item = meetings.find(record => record.id === id);
      if (!item) throw new Error('未找到组会记录。');
      if (item.endAt !== null) return { ...item };
      if (now < item.startAt) throw new Error('组会尚未开始，无法结束。');
      const next = { ...item, endAt: Math.min(now, item.startAt + MAXIMUM),
        endReason: now > item.startAt + MAXIMUM ? 'late' : 'manual', confirmedAt: now };
      commit(meetings.map(record => record.id === id ? next : record));
      return { ...next };
    }
    function cancel(id, now = Date.now()) {
      const item = meetings.find(record => record.id === id);
      if (!item || item.endAt !== null || item.startAt <= now)
        throw new Error('只能取消尚未开始的组会。');
      commit(meetings.filter(record => record.id !== id));
    }
    return { list, forDay, plan, stop, cancel, replace };
  }
  window.MeetingStore = { KEY, EXPECTED, MAXIMUM, state, occupiedEnd, dayRange, create };
})();