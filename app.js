(() => {
  'use strict';

  const D = window.APP_DATA;
  if (!D) throw new Error('APP_DATA missing');

  const $ = (id) => document.getElementById(id);
  const weekdayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  const weekdayLong = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const palette = ['#4F67E8','#E05A73','#2E9B78','#D17B35','#7B61C8','#2E86AB','#B35F8D','#5C7C3E','#C85A44'];

  const DAY_START = 7 * 60;
  const DAY_END = 22 * 60;
  const DAY_SPAN = DAY_END - DAY_START;

  const fmtHeader = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const fmtMD = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

  const pad = (n) => String(n).padStart(2, '0');
  const today = () => new Date();
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const mondayIndex = (d) => d.getDay() === 0 ? 7 : d.getDay();
  const parseLocalDate = (s) => {
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const timeToMinutes = (s) => {
    const [h,m] = s.split(':').map(Number);
    return h * 60 + m;
  };

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

  function stableColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  D.courses.forEach((c, index) => {
    c._weekSet = expandWeeks(c.weeks);
    c._id = index;
    c._color = stableColor(c.name);
  });

  function weekFromDate(d) {
    const w1 = parseLocalDate(D.semester.week1Monday);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((day - w1) / 86400000 / 7) + 1;
  }
  const currentWeek = () => clamp(weekFromDate(today()), 1, D.semester.totalWeeks);
  const weekStart = (week) => addDays(parseLocalDate(D.semester.week1Monday), (week - 1) * 7);
  const periodTime = (c) => ({ start: D.periods[c.start][0], end: D.periods[c.end][1] });
  const pct = (mins) => clamp((mins - DAY_START) / DAY_SPAN * 100, 0, 100);

  function activeCourses(day, week) {
    return D.courses
      .filter(c => c.weekday === day && c._weekSet.has(week))
      .sort((a,b) => timeToMinutes(periodTime(a).start) - timeToMinutes(periodTime(b).start));
  }

  function gymSlots(day) {
    return D.gym.availability[day] || [];
  }

  function gymTransitionTimes() {
    const all = new Set();
    Object.values(D.gym.availability).forEach(slots => {
      slots.forEach(([s,e]) => { all.add(s); all.add(e); });
    });
    return [...all].sort((a,b) => timeToMinutes(a) - timeToMinutes(b));
  }

  function courseBoundaryTimes() {
    const all = new Set();
    Object.values(D.periods).forEach(([s,e]) => { all.add(s); all.add(e); });
    return all;
  }

  const gymTransitions = gymTransitionTimes();
  const courseBoundaries = courseBoundaryTimes();

  let selectedWeek = currentWeek();
  let selectedDay = mondayIndex(today());
  let scheduleMode = localStorage.getItem('neu-schedule-mode') === 'day' ? 'day' : 'week';

  function renderHeader() {
    const d = today();
    $('headerDate').textContent = `${fmtHeader.format(d)} · ${D.semester.name}`;
    $('jumpToday').hidden = selectedWeek === currentWeek() && selectedDay === mondayIndex(d);
  }

  function renderWeekContext() {
    const start = weekStart(selectedWeek);
    const end = addDays(start, 6);
    $('weekTitle').textContent = `第 ${selectedWeek} 周`;
    $('weekRange').textContent = `${fmtMD.format(start)} – ${fmtMD.format(end)}`;
    renderDayStrip();
    renderHeader();
  }

  function renderDayStrip() {
    const start = weekStart(selectedWeek);
    const nowKey = dateKey(today());
    $('dayStrip').innerHTML = Array.from({length: 7}, (_, i) => {
      const day = i + 1;
      const date = addDays(start, i);
      const hasClass = activeCourses(day, selectedWeek).length > 0;
      return `<button class="day-chip ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === nowKey ? 'today' : ''} ${hasClass ? 'has-class' : ''}" data-day="${day}" type="button">
        <span class="dow">周${weekdayNames[day]}</span>
        <span class="dom">${date.getDate()}</span>
      </button>`;
    }).join('');
    $('dayStrip').querySelectorAll('.day-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedDay = Number(btn.dataset.day);
        renderAll();
        if (scheduleMode === 'week') scrollSelectedDayIntoView();
      });
    });
  }

  function renderSchedule() {
    renderWeekContext();
    document.querySelectorAll('.segment').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === scheduleMode));
    $('weekPanel').classList.toggle('active', scheduleMode === 'week');
    $('dayPanel').classList.toggle('active', scheduleMode === 'day');
    if (scheduleMode === 'week') renderTimetable();
    else renderAgenda();
  }

  function renderTimetable() {
    const grid = $('timetableGrid');
    const start = weekStart(selectedWeek);
    const now = today();
    const nowKey = dateKey(now);
    const pieces = ['<div class="corner-cell"><span>时间</span></div>'];

    for (let day = 1; day <= 7; day++) {
      const date = addDays(start, day - 1);
      pieces.push(`<button class="day-head-cell ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === nowKey ? 'today' : ''}" style="grid-column:${day + 1};grid-row:1" data-day="${day}" type="button">
        <strong>周${weekdayNames[day]}</strong><span>${date.getMonth()+1}/${date.getDate()}</span>
      </button>`);
    }

    pieces.push('<div class="time-axis" style="grid-column:1;grid-row:2">');
    for (let p = 1; p <= 12; p++) {
      const t = D.periods[p][0];
      const top = pct(timeToMinutes(t));
      pieces.push(`<div class="period-marker" style="top:${top}%"><strong>${p}</strong><span>${t}</span></div>`);
    }
    for (const t of gymTransitions) {
      const m = timeToMinutes(t);
      if (m < DAY_START || m > DAY_END) continue;
      const aligned = courseBoundaries.has(t);
      pieces.push(`<div class="gym-time-label ${aligned ? 'aligned' : 'aux'}" style="top:${pct(m)}%">${t}</div>`);
    }
    pieces.push('</div>');

    for (let day = 1; day <= 7; day++) {
      const selected = day === selectedDay ? ' selected-col' : '';
      pieces.push(`<div class="day-lane${selected}" style="grid-column:${day + 1};grid-row:2" data-day="${day}">`);

      for (const [s,e] of gymSlots(day)) {
        const sm = timeToMinutes(s), em = timeToMinutes(e);
        pieces.push(`<div class="gym-band" style="top:${pct(sm)}%;height:${pct(em)-pct(sm)}%" title="健身房开放 ${s}–${e}"></div>`);
      }

      for (let p = 1; p <= 12; p++) {
        const t = D.periods[p][0];
        pieces.push(`<div class="period-guide" style="top:${pct(timeToMinutes(t))}%"></div>`);
      }
      const dayGymTransitions = [...new Set(gymSlots(day).flat())]
        .sort((a,b) => timeToMinutes(a) - timeToMinutes(b));
      for (const t of dayGymTransitions) {
        const m = timeToMinutes(t);
        if (m < DAY_START || m > DAY_END) continue;
        const aligned = courseBoundaries.has(t);
        pieces.push(`<div class="gym-guide ${aligned ? 'aligned' : 'aux'}" style="top:${pct(m)}%"></div>`);
      }

      activeCourses(day, selectedWeek).forEach(c => {
        const t = periodTime(c);
        const sm = timeToMinutes(t.start), em = timeToMinutes(t.end);
        const duration = em - sm;
        pieces.push(`<button class="course-block ${duration < 60 ? 'compact' : ''}" data-course="${c._id}" style="top:${pct(sm)}%;height:${pct(em)-pct(sm)}%;background:${c._color}" type="button">
          <span class="course-title">${escapeHtml(shortCourseName(c.name, duration))}</span>
          <span class="course-sub">${escapeHtml(c.location)} · ${t.start}</span>
        </button>`);
      });

      if (selectedWeek === currentWeek() && day === mondayIndex(now)) {
        const mins = now.getHours() * 60 + now.getMinutes();
        if (mins >= DAY_START && mins <= DAY_END) {
          pieces.push(`<div class="current-time-line" style="top:${pct(mins)}%"></div>`);
        }
      }
      pieces.push('</div>');
    }

    grid.innerHTML = pieces.join('');
    grid.querySelectorAll('.day-head-cell').forEach(btn => btn.addEventListener('click', () => {
      selectedDay = Number(btn.dataset.day);
      renderAll();
    }));
    grid.querySelectorAll('.course-block').forEach(btn => btn.addEventListener('click', () => openCourse(Number(btn.dataset.course))));
    requestAnimationFrame(scrollSelectedDayIntoView);
  }

  function shortCourseName(name, duration) {
    const map = {
      '思想政治理论课（硕士必修）': '思政（硕士必修）',
      '思想政治理论课（硕士理工类必选）': '思政（理工必选）',
      '国际会议交流英语': '国际会议英语',
      '论文写作与学术规范': '论文写作与规范'
    };
    const n = map[name] || name;
    return duration < 60 && n.length > 8 ? n.slice(0, 7) + '…' : n;
  }

  function scrollSelectedDayIntoView() {
    if (window.innerWidth >= 700) return;
    const scroller = $('timetableScroll');
    const cell = scroller.querySelector(`.day-head-cell[data-day="${selectedDay}"]`);
    if (!cell) return;
    const target = Math.max(0, cell.offsetLeft - scroller.clientWidth * .32);
    scroller.scrollTo({ left: target, behavior: 'smooth' });
  }

  function subtractCoursesFromGym(day, week) {
    let intervals = gymSlots(day).map(([s,e]) => [timeToMinutes(s), timeToMinutes(e)]);
    const occupied = activeCourses(day, week).map(c => {
      const t = periodTime(c);
      return [timeToMinutes(t.start), timeToMinutes(t.end)];
    });
    for (const [os, oe] of occupied) {
      const next = [];
      for (const [s,e] of intervals) {
        if (oe <= s || os >= e) next.push([s,e]);
        else {
          if (os > s) next.push([s, os]);
          if (oe < e) next.push([oe, e]);
        }
      }
      intervals = next.filter(([s,e]) => e - s >= 20);
    }
    return intervals;
  }

  function formatDuration(mins) {
    if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`;
    if (mins >= 60) return `${Math.floor(mins/60)}h ${mins%60}m`;
    return `${mins}m`;
  }

  function renderAgenda() {
    const start = weekStart(selectedWeek);
    const date = addDays(start, selectedDay - 1);
    const courses = activeCourses(selectedDay, selectedWeek);
    const slots = gymSlots(selectedDay);
    const free = subtractCoursesFromGym(selectedDay, selectedWeek);

    $('daySummary').innerHTML = `
      <div class="day-summary-top">
        <div><strong>${weekdayLong[selectedDay]} · ${fmtMD.format(date)}</strong><span>第 ${selectedWeek} 周 · ${courses.length ? `${courses.length} 段课程` : '没有课程'}</span></div>
        <div class="day-gym-badge">健身 ${slots.map(x => `${x[0]}–${x[1]}`).join(' / ')}</div>
      </div>
      <div class="free-chips">
        ${free.length ? free.map(([s,e]) => `<span>${timeLabel(s)}–${timeLabel(e)} · ${formatDuration(e-s)}</span>`).join('') : '<span class="muted-chip">当天没有无课健身窗口</span>'}
      </div>`;

    $('agendaList').innerHTML = courses.length ? courses.map(c => {
      const t = periodTime(c);
      return `<button class="agenda-card" data-course="${c._id}" type="button">
        <div class="agenda-time"><strong>${t.start}</strong><span>${t.end}<br>${c.start}-${c.end}节</span></div>
        <div class="agenda-color" style="background:${c._color}"></div>
        <div><div class="agenda-name">${escapeHtml(c.name)}</div><div class="agenda-meta">${escapeHtml(c.location)} · ${escapeHtml(c.teacher)}${c.className ? ` · ${escapeHtml(c.className)}` : ''}</div></div>
      </button>`;
    }).join('') : '<div class="empty-state">这一天没有课程</div>';
    $('agendaList').querySelectorAll('.agenda-card').forEach(btn => btn.addEventListener('click', () => openCourse(Number(btn.dataset.course))));
  }

  function timeLabel(mins) {
    return `${pad(Math.floor(mins/60))}:${pad(mins%60)}`;
  }

  function openCourse(id) {
    const c = D.courses.find(x => x._id === id);
    if (!c) return;
    const t = periodTime(c);
    $('courseDetailTitle').textContent = c.name;
    $('courseDetailBody').innerHTML = [
      detail('时间', `${weekdayLong[c.weekday]} ${t.start}–${t.end} · ${c.start}-${c.end}节`),
      detail('地点', c.location),
      detail('教师', c.teacher),
      detail('周数', `第 ${c.weeks} 周`),
      detail('班级', c.className || '—', true)
    ].join('');
    $('courseDialog').showModal();
  }

  function detail(label, value, full = false) {
    return `<div class="detail-item ${full ? 'full' : ''}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function showWeekPicker() {
    const current = currentWeek();
    $('weekChoices').innerHTML = Array.from({length: D.semester.totalWeeks}, (_, i) => {
      const w = i + 1;
      return `<button type="button" class="week-choice ${w === selectedWeek ? 'active' : ''} ${w === current ? 'current' : ''}" data-week="${w}">${w}</button>`;
    }).join('');
    $('weekChoices').querySelectorAll('.week-choice').forEach(btn => btn.addEventListener('click', () => {
      selectedWeek = Number(btn.dataset.week);
      $('weekDialog').close();
      renderAll();
    }));
    $('weekDialog').showModal();
  }

  function changeWeek(delta) {
    selectedWeek = clamp(selectedWeek + delta, 1, D.semester.totalWeeks);
    renderAll();
  }

  function jumpToToday() {
    selectedWeek = currentWeek();
    selectedDay = mondayIndex(today());
    renderAll();
  }

  function setupInteractions() {
    $('prevWeek').addEventListener('click', () => changeWeek(-1));
    $('nextWeek').addEventListener('click', () => changeWeek(1));
    $('weekPickerButton').addEventListener('click', showWeekPicker);
    $('jumpToday').addEventListener('click', jumpToToday);

    document.querySelectorAll('.segment').forEach(btn => btn.addEventListener('click', () => {
      scheduleMode = btn.dataset.mode;
      localStorage.setItem('neu-schedule-mode', scheduleMode);
      renderSchedule();
    }));

    let touchX = null, touchY = null;
    $('weekSwipeZone').addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      touchX = t.clientX; touchY = t.clientY;
    }, {passive: true});
    $('weekSwipeZone').addEventListener('touchend', (e) => {
      if (touchX == null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchX, dy = t.clientY - touchY;
      touchX = touchY = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) changeWeek(dx < 0 ? 1 : -1);
    }, {passive: true});
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }

  function renderAll() {
    renderHeader();
    renderSchedule();
  }

  function boot() {
    setupInteractions();
    renderAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    setInterval(renderAll, 60000);
  }

  boot();
})();
