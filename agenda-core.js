(() => {
  'use strict';
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const dayKey = (at = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  function dayRange(key) {
    const [y, m, d] = key.split('-').map(Number);
    return [Date.UTC(y, m - 1, d, -8), Date.UTC(y, m - 1, d + 1, -8)];
  }
  function localTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('请填写明确的日期和时间。');
    const at = Date.parse(value + ':00+08:00');
    if (!Number.isSafeInteger(at) || new Date(at + 8 * HOUR).toISOString().slice(0, 16) !== value) throw Error('日期或时间无效。');
    return at;
  }
  function windows(item) {
    const anchor = item.anchorAt;
    if (item.kind === 'deadline') return { from: anchor - 3 * HOUR, coreFrom: anchor - HOUR, coreTo: anchor, to: anchor };
    const to = item.explicitEndAt ?? anchor + 3 * HOUR;
    return { from: anchor, coreFrom: anchor, coreTo: item.explicitEndAt ?? anchor + HOUR, to };
  }
  function busyInterval(item, now = Date.now()) {
    const w = windows(item);
    if (item.cancelledAt != null) return null;
    const end = item.resolvedAt ?? (now >= w.from ? Infinity : w.to);
    return end > w.from ? [w.from, end] : null;
  }
  function meetingInterval(meeting, now = Date.now()) {
    const end = meeting.confirmedAt ?? meeting.endAt ?? (now >= meeting.startAt ? Infinity : meeting.startAt + 5 * HOUR);
    return end > meeting.startAt ? [meeting.startAt, end] : null;
  }
  function status(item, now = Date.now()) {
    if (item.cancelledAt != null) return 'cancelled';
    if (item.resolvedAt != null) return 'resolved';
    const w = windows(item);
    if (now < w.from) return 'planned';
    if (item.kind === 'deadline') return now >= item.anchorAt ? 'overdue' : now >= w.coreFrom ? 'urgent' : 'warning';
    return now >= w.to ? 'unconfirmed' : now >= w.coreTo ? 'extended' : 'ongoing';
  }
  function normalizeItem(value, now = Date.now()) {
    if (!value || !['activity', 'deadline'].includes(value.kind) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100) throw Error('事项类型或标题无效。');
    if (!Number.isSafeInteger(value.anchorAt) || value.anchorAt < now - 366 * DAY || value.anchorAt > now + 2 * 366 * DAY) throw Error('事项时间不在支持范围内。');
    const explicitEndAt = value.explicitEndAt ?? null;
    if (explicitEndAt !== null && (value.kind !== 'activity' || !Number.isSafeInteger(explicitEndAt) || explicitEndAt <= value.anchorAt || explicitEndAt - value.anchorAt > 14 * DAY)) throw Error('活动结束时间无效。');
    const location = value.location == null ? '' : String(value.location);
    const evidence = value.evidence == null ? '' : String(value.evidence);
    if (location.length > 200 || evidence.length > 1200) throw Error('地点或来源说明过长。');
    return { kind: value.kind, title: value.title.trim(), anchorAt: value.anchorAt, explicitEndAt, location, evidence };
  }
  function digest(items, meetings, at = Date.now()) {
    const entries = [];
    for (const item of items) {
      if (item.resolvedAt != null || item.cancelledAt != null) continue;
      if (item.anchorAt >= at + 3 * DAY) continue;
      entries.push({ id: item.id, kind: item.kind, title: item.title, at: item.anchorAt, state: status(item, at), location: item.location || '' });
    }
    for (const m of meetings) {
      if (m.endAt != null || m.startAt >= at + 3 * DAY) continue;
      entries.push({ id: 'meeting-' + m.id, kind: 'meeting', title: '组会', at: m.startAt, state: m.startAt <= at ? 'unconfirmed' : 'planned', location: '' });
    }
    return entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  const format = at => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  function digestText(entries) {
    if (!entries.length) return '未来三日暂无 DDL、活动或组会。';
    return entries.map(item => `${format(item.at)} ${item.kind === 'deadline' ? 'DDL' : item.kind === 'meeting' ? '组会' : '活动'} ${item.title}${['overdue', 'unconfirmed'].includes(item.state) ? '（待确认）' : ''}`).join('\n');
  }
  const api = { HOUR, DAY, dayKey, dayRange, localTime, windows, busyInterval, meetingInterval, status, normalizeItem, digest, digestText, format };
  globalThis.ScheduleAgenda = api;
  if (typeof window !== 'undefined') window.ScheduleAgenda = api;
})();
