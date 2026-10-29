(() => {
  'use strict';
  const entries = Object.freeze([
    Object.freeze({key:'training',minute:750,clock:'12:30',label:'外出训练'}),
    Object.freeze({key:'meal',minute:990,clock:'16:30',label:'外出就餐'})
  ]);
  const MAX_LATENESS = 2 * 60000;
  const isDaily = id => typeof id === 'string' && id.startsWith('daily-');
  const dayKey = now => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const jobs = day => entries.map(v => ({id:`daily-${day}-${v.key}-${v.minute}`,dueAt:Date.parse(`${day}T${v.clock}:00+08:00`),title:v.label+'提醒',body:v.clock+' · '+v.label,ttl:MAX_LATENESS/1000}));
  const api = Object.freeze({entries,MAX_LATENESS,isDaily,dayKey,jobs});
  if (typeof window === 'object') window.ScheduleDailyReminders = api;
  else globalThis.ScheduleDailyReminders = api;
})();
