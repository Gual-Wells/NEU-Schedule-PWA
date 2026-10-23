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
  function dateTime(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('日期无效。');
    return localTime(value+'T00:00');
  }
  function generatedItem(value,now=Date.now()) {
    return normalizeItem({...value,anchorAt:value.dateStart?undefined:localTime(value.localTime),
      explicitEndAt:value.dateStart?null:value.localEnd?localTime(value.localEnd):null},now);
  }
  function windows(item) {
    if(item.dateStart){const from=dateTime(item.dateStart),to=dateTime(item.dateEnd||item.dateStart)+DAY;return {from,coreFrom:from,coreTo:to,to};}
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
  // Calendar estimates are finite. Open gym occupancy is a separate state,
  // not an estimated end time to project onto every future calendar date.
  function displayInterval(item) {
    if (item.cancelledAt != null) return null;
    const w = windows(item), end = item.resolvedAt ?? w.to;
    return end > w.from ? [w.from, end] : null;
  }
  function meetingDisplayInterval(meeting) {
    const end = meeting.confirmedAt ?? meeting.endAt ?? meeting.startAt + 5 * HOUR;
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
    const dateStart=value.dateStart||null,dateEnd=dateStart?(value.dateEnd||dateStart):null;
    let anchorAt=value.anchorAt;
    if(dateStart){const start=dateTime(dateStart),end=dateTime(dateEnd)+DAY;if(end<=start||end-start>366*DAY)throw Error('日期范围无效。');anchorAt=value.kind==='deadline'?end:start;}
    else if(value.dateEnd)throw Error('日期范围缺少开始日期。');
    if (!Number.isSafeInteger(anchorAt) || anchorAt < now - 366 * DAY || anchorAt > now + 2 * 366 * DAY) throw Error('事项时间不在支持范围内。');
    const explicitEndAt = value.explicitEndAt ?? null;
    if (explicitEndAt !== null && (dateStart || value.kind !== 'activity' || !Number.isSafeInteger(explicitEndAt) || explicitEndAt <= anchorAt || explicitEndAt - anchorAt > 14 * DAY)) throw Error('活动结束时间无效。');
    const location = value.location == null ? '' : String(value.location);
    const evidence = value.evidence == null ? '' : String(value.evidence);
    if (location.length > 200 || evidence.length > 1200) throw Error('地点或来源说明过长。');
    const inference=value.inference||'';if(typeof inference!=='string'||inference.length>1200)throw Error('推断说明过长。');
    return { kind: value.kind, title: value.title.trim(), anchorAt, explicitEndAt, location, evidence,dateStart,dateEnd,inference };
  }
  function digest(items, meetings, at = Date.now()) {
    const entries = [];
    for (const item of items) {
      if (item.resolvedAt != null || item.cancelledAt != null) continue;
      if ((item.dateStart?dateTime(item.dateStart):item.anchorAt) >= at + 3 * DAY) continue;
      entries.push({ id: item.id, kind: item.kind, title: item.title, at: item.anchorAt,dateStart:item.dateStart||null,dateEnd:item.dateEnd||null, state: status(item, at), location: item.location || '' });
    }
    for (const m of meetings) {
      if (m.endAt != null || m.startAt >= at + 3 * DAY) continue;
      entries.push({ id: 'meeting-' + m.id, kind: 'meeting', title: '组会', at: m.startAt, state: m.startAt <= at ? 'unconfirmed' : 'planned', location: '' });
    }
    return entries.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  const format = at => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const timeLabel=item=>item.dateStart?item.dateStart+(item.dateEnd&&item.dateEnd!==item.dateStart?'—'+item.dateEnd:'')+' 全天':format(item.anchorAt)+(item.explicitEndAt?'—'+format(item.explicitEndAt):'');
  function digestText(entries) {
    if (!entries.length) return '未来三日暂无 DDL、活动或组会。';
    return entries.map(item => `${item.dateStart?timeLabel(item):format(item.at)} ${item.kind === 'deadline' ? 'DDL' : item.kind === 'meeting' ? '组会' : '活动'} ${item.title}${['overdue', 'unconfirmed'].includes(item.state) ? '（待确认）' : ''}`).join('\n');
  }
  // Connected overlap groups share a half-column; each time slice divides it equally.
  function layout(intervals) {
    const sorted=intervals.filter(v=>v.to>v.from).slice().sort((a,b)=>a.from-b.from||a.to-b.to||a.key.localeCompare(b.key)),groups=[];
    for(const v of sorted){let g=groups.at(-1);if(!g||v.from>=g.to){g={from:v.from,to:v.to,entries:[]};groups.push(g);}g.to=Math.max(g.to,v.to);g.entries.push(v);}
    return groups.map(g=>{const edges=[...new Set(g.entries.flatMap(v=>[v.from,v.to]))].sort((a,b)=>a-b),slices=[];
      for(let i=0;i<edges.length-1;i++){const from=edges[i],to=edges[i+1],active=g.entries.filter(v=>v.from<to&&from<v.to).sort((a,b)=>a.key.localeCompare(b.key));
        active.forEach((v,lane)=>slices.push({...v,from,to,left:lane/active.length,width:1/active.length}));}
      return {...g,slices};});
  }
  const api = { HOUR, DAY, dayKey, dayRange, localTime,dateTime,generatedItem,timeLabel,layout, windows, busyInterval, meetingInterval, displayInterval, meetingDisplayInterval, status, normalizeItem, digest, digestText, format };
  globalThis.ScheduleAgenda = api;
  if (typeof window !== 'undefined') window.ScheduleAgenda = api;
})();
