(() => {
  'use strict';
  const D = window.APP_DATA;
  const weekdayNames = ['','周一','周二','周三','周四','周五','周六','周日'];
  const weekdayLong = ['','星期一','星期二','星期三','星期四','星期五','星期六','星期日'];
  const fmtDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const fmtMD = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

  const $ = (id) => document.getElementById(id);
  const now = () => new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const mondayIndex = (d) => d.getDay() === 0 ? 7 : d.getDay();
  const parseLocalDate = (s) => {
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m-1, d, 0, 0, 0, 0);
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate()+n);
    return x;
  };
  const weekFromDate = (d) => {
    const w1 = parseLocalDate(D.semester.week1Monday);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((day - w1) / 86400000 / 7) + 1;
  };
  const clampWeek = (n) => Math.min(D.semester.totalWeeks, Math.max(1, n));

  function expandWeeks(spec) {
    const out = new Set();
    String(spec).split(/[、,，]/).map(s => s.trim()).filter(Boolean).forEach(part => {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        for (let i = Number(m[1]); i <= Number(m[2]); i++) out.add(i);
      } else if (/^\d+$/.test(part)) out.add(Number(part));
    });
    return out;
  }
  D.courses.forEach(c => c._weekSet = expandWeeks(c.weeks));

  function periodTime(course) {
    return { start: D.periods[course.start][0], end: D.periods[course.end][1] };
  }
  function timeToMinutes(s) { const [h,m] = s.split(':').map(Number); return h*60+m; }
  function activeCoursesFor(day, week) {
    return D.courses
      .filter(c => c.weekday === day && c._weekSet.has(week))
      .sort((a,b) => a.start - b.start || a.end - b.end);
  }
  function selectedWeekStart(week) {
    return addDays(parseLocalDate(D.semester.week1Monday), (week-1)*7);
  }

  let selectedWeek = clampWeek(weekFromDate(now()));

  function courseCard(c, includeWeeks=false) {
    const t = periodTime(c);
    const classPart = c.className ? `<span>${escapeHtml(c.className)}</span>` : '';
    return `<article class="course-card">
      <div class="course-time"><strong>${t.start}</strong><span>${t.end} · ${c.start}-${c.end}节</span></div>
      <div>
        <div class="course-name">${escapeHtml(c.name)}</div>
        <div class="course-meta"><span>${escapeHtml(c.location)}</span><span>${escapeHtml(c.teacher)}</span>${classPart}</div>
        ${includeWeeks ? `<div class="course-weeks">第 ${escapeHtml(c.weeks)} 周</div>` : ''}
      </div>
    </article>`;
  }
  function escapeHtml(v) {
    return String(v).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function renderHeader() {
    const d = now();
    $('dateLabel').textContent = `${fmtDate.format(d)} · ${D.semester.name}`;
    $('weekButton').textContent = `第 ${selectedWeek} 周`;
  }

  function renderToday() {
    const d = now();
    const day = mondayIndex(d);
    const currentWeek = clampWeek(weekFromDate(d));
    const courses = activeCoursesFor(day, currentWeek);
    $('todaySummary').textContent = `第 ${currentWeek} 周 · ${courses.length ? `${courses.length} 段课` : '无课'}`;
    $('todayCourses').innerHTML = courses.length ? courses.map(c => courseCard(c)).join('') : `<div class="empty-card">今天没有课程</div>`;
    renderNextClass(courses, d);
    renderGym(day, d);
  }

  function renderNextClass(courses, d) {
    const mins = d.getHours()*60 + d.getMinutes();
    let current = null, next = null;
    for (const c of courses) {
      const t = periodTime(c);
      const s = timeToMinutes(t.start), e = timeToMinutes(t.end);
      if (mins >= s && mins <= e) { current = {c,t,e}; break; }
      if (mins < s && !next) next = {c,t,s};
    }
    const el = $('nextClassCard');
    if (current) {
      el.className = 'status-card soon';
      el.innerHTML = `<div class="status-kicker">正在上课</div><div class="status-main">${escapeHtml(current.c.name)}</div><div class="status-sub">到 ${current.t.end} · ${escapeHtml(current.c.location)}</div>`;
    } else if (next) {
      el.className = 'status-card soon';
      const delta = next.s - mins;
      el.innerHTML = `<div class="status-kicker">下一节</div><div class="status-main">${escapeHtml(next.c.name)}</div><div class="status-sub">${next.t.start} · ${escapeHtml(next.c.location)}${delta <= 90 ? ` · ${delta} 分钟后` : ''}</div>`;
    } else {
      el.className = 'status-card';
      el.innerHTML = `<div class="status-kicker">课程</div><div class="status-main">今天没课了</div><div class="status-sub">可以直接看健身房时段</div>`;
    }
  }

  function renderGym(day, d) {
    const slots = D.gym.availability[day] || [];
    const mins = d.getHours()*60 + d.getMinutes();
    const open = slots.find(([s,e]) => mins >= timeToMinutes(s) && mins < timeToMinutes(e));
    const next = slots.find(([s]) => mins < timeToMinutes(s));
    const el = $('gymNowCard');
    if (open) {
      el.className = 'status-card open';
      el.innerHTML = `<div class="status-kicker">健身房</div><div class="status-main">现在可用</div><div class="status-sub">开放至 ${open[1]}</div>`;
    } else if (next) {
      el.className = 'status-card closed';
      el.innerHTML = `<div class="status-kicker">健身房</div><div class="status-main">现在不可用</div><div class="status-sub">下一时段 ${next[0]}–${next[1]}</div>`;
    } else {
      el.className = 'status-card closed';
      el.innerHTML = `<div class="status-kicker">健身房</div><div class="status-main">今天结束</div><div class="status-sub">明天再看</div>`;
    }
    $('gymUpdated').textContent = `更新 ${D.gym.updated.replaceAll('-', '.')}`;
    $('gymToday').innerHTML = slots.map(([s,e]) => `<span class="gym-slot">${s}–${e}</span>`).join('') || `<div class="empty-card">今天暂无可用时段</div>`;
  }

  function renderWeek() {
    const start = selectedWeekStart(selectedWeek);
    const end = addDays(start, 6);
    $('weekTitle').textContent = `第 ${selectedWeek} 周`;
    $('weekRange').textContent = `${fmtMD.format(start)} – ${fmtMD.format(end)}`;
    const todayKey = dateKey(now());
    $('weekDays').innerHTML = Array.from({length:7}, (_,i) => {
      const weekday = i+1;
      const date = addDays(start, i);
      const courses = activeCoursesFor(weekday, selectedWeek);
      const body = courses.length ? courses.map(c => {
        const t = periodTime(c);
        return `<div class="day-course"><div class="day-course-time">${t.start}–${t.end}<br>${c.start}-${c.end}节</div><div><div class="day-course-name">${escapeHtml(c.name)}</div><div class="day-course-meta">${escapeHtml(c.location)} · ${escapeHtml(c.teacher)}</div></div></div>`;
      }).join('') : `<div class="day-empty">无课</div>`;
      const gym = D.gym.availability[weekday].map(([s,e]) => `${s}–${e}`).join(' / ');
      return `<section class="day-card ${dateKey(date)===todayKey ? 'today':''}"><div class="day-head"><strong>${weekdayLong[weekday]} · ${fmtMD.format(date)}</strong><span>健身 ${gym}</span></div>${body}</section>`;
    }).join('');
    renderHeader();
  }

  function renderAll() {
    $('allCourses').innerHTML = D.courses
      .slice()
      .sort((a,b) => a.weekday-b.weekday || a.start-b.start)
      .map(c => {
        const t = periodTime(c);
        return `<article class="course-card"><div class="course-time"><strong>${weekdayNames[c.weekday]}</strong><span>${t.start}–${t.end}</span></div><div><div class="course-name">${escapeHtml(c.name)}</div><div class="course-meta"><span>${escapeHtml(c.location)}</span><span>${escapeHtml(c.teacher)}</span>${c.className ? `<span>${escapeHtml(c.className)}</span>`:''}</div><div class="course-weeks">第 ${escapeHtml(c.weeks)} 周</div></div></article>`;
      }).join('');
  }

  function setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x===btn));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id===btn.dataset.view));
      if (btn.dataset.view === 'weekView') renderWeek();
    }));
    $('prevWeek').addEventListener('click', () => { selectedWeek = clampWeek(selectedWeek-1); renderWeek(); });
    $('nextWeek').addEventListener('click', () => { selectedWeek = clampWeek(selectedWeek+1); renderWeek(); });
  }

  function setupWeekDialog() {
    const dialog = $('weekDialog');
    const choices = $('weekChoices');
    const draw = () => {
      choices.innerHTML = Array.from({length:D.semester.totalWeeks}, (_,i) => {
        const w=i+1;
        return `<button type="button" class="week-choice ${w===selectedWeek?'active':''}" data-week="${w}">${w}</button>`;
      }).join('');
      choices.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        selectedWeek = Number(b.dataset.week);
        renderHeader(); renderWeek(); dialog.close();
      }));
    };
    $('weekButton').addEventListener('click', () => { draw(); dialog.showModal(); });
  }

  function boot() {
    renderHeader();
    renderToday();
    renderWeek();
    renderAll();
    setupNavigation();
    setupWeekDialog();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    setInterval(() => { renderHeader(); renderToday(); }, 60000);
  }
  boot();
})();
