(() => {
  'use strict';

  const D = window.APP_DATA;
  if (!D) throw new Error('APP_DATA missing');

  const $ = (id) => document.getElementById(id);
  const weekdayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  const weekdayLong = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const palette = ['#4F67E8','#E05A73','#2E9B78','#D17B35','#7B61C8','#2E86AB','#B35F8D','#5C7C3E','#C85A44'];

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
  const minutesToTime = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

  function expandWeeks(spec) {
    const out = new Set();
    String(spec).split(/[、,，]/).map(s => s.trim()).filter(Boolean).forEach(part => {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        for (let i = Number(m[1]); i <= Number(m[2]); i++) out.add(i);
      } else if (/^\d+$/.test(part)) {
        out.add(Number(part));
      }
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

  function activeCourses(day, week) {
    return D.courses
      .filter(c => c.weekday === day && c._weekSet.has(week))
      .sort((a,b) => a.start - b.start || a.end - b.end);
  }

  let selectedWeek = currentWeek();
  let selectedDay = mondayIndex(today());
  let scheduleMode = localStorage.getItem('neu-schedule-mode') === 'day' ? 'day' : 'week';
  let activePage = 'schedulePage';

  function renderHeader() {
    const d = today();
    $('headerDate').textContent = `${fmtHeader.format(d)} · ${D.semester.name}`;
    $('headerTitle').textContent = activePage === 'gymPage' ? '健身房' : '课表';
    $('jumpToday').hidden = selectedWeek === currentWeek() && selectedDay === mondayIndex(d);
  }

  function renderWeekContext() {
    const start = weekStart(selectedWeek);
    const end = addDays(start, 6);
    $('weekTitle').textContent = `第 ${selectedWeek} 周`;
    $('weekRange').textContent = `${fmtMD.format(start)} – ${fmtMD.format(end)}`;
    $('scheduleHint').textContent = selectedWeek === currentWeek() ? '本周' : '非本周 · 点右上角返回';
    renderDayStrips();
    renderHeader();
  }

  function renderDayStrips() {
    const start = weekStart(selectedWeek);
    const nowKey = dateKey(today());
    const html = Array.from({length: 7}, (_, i) => {
      const day = i + 1;
      const date = addDays(start, i);
      const hasClass = activeCourses(day, selectedWeek).length > 0;
      return `<button class="day-chip ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === nowKey ? 'today' : ''} ${hasClass ? 'has-class' : ''}" data-day="${day}" type="button">
        <span class="dow">周${weekdayNames[day]}</span>
        <span class="dom">${date.getDate()}</span>
      </button>`;
    }).join('');
    $('dayStrip').innerHTML = html;
    $('gymDayStrip').innerHTML = html;
    document.querySelectorAll('.day-strip .day-chip').forEach(btn => {
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
    const pieces = ['<div class="corner-cell"></div>'];

    for (let day = 1; day <= 7; day++) {
      const date = addDays(start, day - 1);
      pieces.push(`<button class="day-head-cell ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === nowKey ? 'today' : ''}" style="grid-column:${day + 1};grid-row:1" data-day="${day}" type="button">
        <strong>周${weekdayNames[day]}</strong><span>${date.getMonth()+1}/${date.getDate()}</span>
      </button>`);
    }

    for (let p = 1; p <= 12; p++) {
      pieces.push(`<div class="period-cell" style="grid-column:1;grid-row:${p + 1}"><strong>${p}</strong><span>${D.periods[p][0]}</span></div>`);
      for (let day = 1; day <= 7; day++) {
        pieces.push(`<div class="grid-cell ${day === selectedDay ? 'selected-col' : ''}" style="grid-column:${day + 1};grid-row:${p + 1}"></div>`);
      }
    }

    D.courses.filter(c => c._weekSet.has(selectedWeek)).forEach(c => {
      const t = periodTime(c);
      const span = c.end - c.start + 1;
      pieces.push(`<button class="course-block" data-course="${c._id}" style="grid-column:${c.weekday + 1};grid-row:${c.start + 1}/${c.end + 2};background:${c._color}" type="button">
        <span class="course-title">${escapeHtml(shortCourseName(c.name, span))}</span>
        ${span >= 2 ? `<span class="course-sub">${escapeHtml(c.location)} · ${t.start}</span>` : ''}
      </button>`);
    });

    const current = currentTimeLinePosition(now);
    if (selectedWeek === currentWeek() && current) {
      const day = mondayIndex(now);
      pieces.push(`<div class="current-time-line" style="grid-column:${day + 1};grid-row:${current.row};transform:translateY(${current.offset}px)"></div>`);
    }

    grid.innerHTML = pieces.join('');
    grid.querySelectorAll('.day-head-cell').forEach(btn => btn.addEventListener('click', () => {
      selectedDay = Number(btn.dataset.day);
      renderAll();
    }));
    grid.querySelectorAll('.course-block').forEach(btn => btn.addEventListener('click', () => openCourse(Number(btn.dataset.course))));
    requestAnimationFrame(scrollSelectedDayIntoView);
  }

  function currentTimeLinePosition(d) {
    const mins = d.getHours() * 60 + d.getMinutes();
    for (let p = 1; p <= 12; p++) {
      const s = timeToMinutes(D.periods[p][0]);
      const e = timeToMinutes(D.periods[p][1]);
      if (mins >= s && mins <= e) {
        const ratio = (mins - s) / Math.max(1, e - s);
        const rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 54;
        return { row: p + 1, offset: ratio * rowHeight };
      }
    }
    return null;
  }

  function shortCourseName(name, span) {
    const map = {
      '思想政治理论课（硕士必修）': '思政（硕士必修）',
      '思想政治理论课（硕士理工类必选）': '思政（理工必选）',
      '国际会议交流英语': '国际会议英语',
      '论文写作与学术规范': '论文写作与规范'
    };
    const n = map[name] || name;
    return span === 1 && n.length > 8 ? n.slice(0, 7) + '…' : n;
  }

  function scrollSelectedDayIntoView() {
    if (window.innerWidth >= 700) return;
    const scroller = $('timetableScroll');
    const cell = scroller.querySelector(`.day-head-cell[data-day="${selectedDay}"]`);
    if (!cell) return;
    const target = Math.max(0, cell.offsetLeft - scroller.clientWidth * .32);
    scroller.scrollTo({ left: target, behavior: 'smooth' });
  }

  function renderAgenda() {
    const start = weekStart(selectedWeek);
    const date = addDays(start, selectedDay - 1);
    const courses = activeCourses(selectedDay, selectedWeek);
    $('daySummary').innerHTML = `<strong>${weekdayLong[selectedDay]} · ${fmtMD.format(date)}</strong><span>第 ${selectedWeek} 周 · ${courses.length ? `${courses.length} 段课程` : '没有课程'}</span>`;
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

  function renderGym() {
    const now = today();
    const isCurrentSelection = selectedWeek === currentWeek() && selectedDay === mondayIndex(now);
    const slots = D.gym.availability[selectedDay] || [];
    const free = subtractCoursesFromGym(selectedDay, selectedWeek);
    const mins = now.getHours() * 60 + now.getMinutes();
    const hero = $('gymHero');

    if (isCurrentSelection) {
      const gymOpen = slots.find(([s,e]) => mins >= timeToMinutes(s) && mins < timeToMinutes(e));
      const freeNow = free.find(([s,e]) => mins >= timeToMinutes(s) && mins < timeToMinutes(e));
      const nextFree = free.find(([s]) => mins < timeToMinutes(s));
      const currentCourse = activeCourses(selectedDay, selectedWeek).find(c => {
        const t = periodTime(c);
        return mins >= timeToMinutes(t.start) && mins < timeToMinutes(t.end);
      });

      if (freeNow) {
        hero.innerHTML = `<div class="hero-kicker">现在 · ${weekdayLong[selectedDay]}</div><div class="hero-main">现在可以去</div><div class="hero-sub">无课程冲突 · 可用至 ${freeNow[1]}</div>`;
      } else if (gymOpen && currentCourse) {
        hero.innerHTML = `<div class="hero-kicker">现在 · ${weekdayLong[selectedDay]}</div><div class="hero-main">现在有课</div><div class="hero-sub">${escapeHtml(shortCourseName(currentCourse.name, currentCourse.end-currentCourse.start+1))}${nextFree ? ` · 下一可去 ${nextFree[0]}–${nextFree[1]}` : ' · 今天没有后续可去时段'}</div>`;
      } else if (nextFree) {
        hero.innerHTML = `<div class="hero-kicker">现在 · ${weekdayLong[selectedDay]}</div><div class="hero-main">暂时不能去</div><div class="hero-sub">下一可去 ${nextFree[0]}–${nextFree[1]}</div>`;
      } else {
        hero.innerHTML = `<div class="hero-kicker">今天 · ${weekdayLong[selectedDay]}</div><div class="hero-main">今天没有后续可去时段</div><div class="hero-sub">切换上方日期可查看其他天</div>`;
      }
    } else {
      hero.innerHTML = `<div class="hero-kicker">第 ${selectedWeek} 周 · ${weekdayLong[selectedDay]}</div><div class="hero-main">${free.length ? '查看可去时段' : '没有可去时段'}</div><div class="hero-sub">已同时考虑健身房开放和这一天的课程冲突</div>`;
    }

    const selectedDate = addDays(weekStart(selectedWeek), selectedDay - 1);
    $('gymContextLabel').textContent = `第 ${selectedWeek} 周 · ${weekdayLong[selectedDay]} · ${fmtMD.format(selectedDate)}`;
    $('gymUpdated').textContent = `表更新 ${D.gym.updated.replaceAll('-', '.')}`;
    $('freeTitle').textContent = `第 ${selectedWeek} 周 · ${weekdayLong[selectedDay]} 可去健身`;

    $('freeWindows').innerHTML = free.length ? free.map(([s,e]) => {
      const dur = timeToMinutes(e) - timeToMinutes(s);
      return `<div class="free-window"><div><strong>${s}–${e}</strong><span> 无课程冲突</span></div><span class="duration">${formatDuration(dur)}</span></div>`;
    }).join('') : '<div class="empty-state">这一天没有同时满足“健身房开放 + 没课”的时段</div>';

    renderGymMatrix();
    renderGymDayDetail();
  }

  function subtractCoursesFromGym(day, week) {
    let intervals = (D.gym.availability[day] || []).map(([s,e]) => [timeToMinutes(s), timeToMinutes(e)]);
    const occupied = activeCourses(day, week).map(c => {
      const t = periodTime(c);
      return [timeToMinutes(t.start), timeToMinutes(t.end)];
    });
    for (const [os, oe] of occupied) {
      const next = [];
      for (const [s,e] of intervals) {
        if (oe <= s || os >= e) next.push([s,e]);
        else {
          if (os > s) next.push([s, Math.max(s, os)]);
          if (oe < e) next.push([Math.min(e, oe), e]);
        }
      }
      intervals = next.filter(([s,e]) => e - s >= 20);
    }
    return intervals.map(([s,e]) => [minutesToTime(s), minutesToTime(e)]);
  }

  function formatDuration(mins) {
    if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`;
    if (mins >= 60) return `${Math.floor(mins/60)}h ${mins%60}m`;
    return `${mins}m`;
  }

  function renderGymMatrix() {
    const bounds = ['07:00','10:00','12:10','13:50','17:40','20:40'];
    const nowDay = mondayIndex(today());
    const pieces = ['<div class="matrix-head">时段</div>'];
    for (let d = 1; d <= 7; d++) pieces.push(`<div class="matrix-head ${d === nowDay ? 'today' : ''}">周${weekdayNames[d]}</div>`);
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i], e = bounds[i+1];
      pieces.push(`<div class="matrix-time">${s}<br>${e}</div>`);
      for (let d = 1; d <= 7; d++) {
        const open = (D.gym.availability[d] || []).some(([a,b]) => timeToMinutes(a) <= timeToMinutes(s) && timeToMinutes(b) >= timeToMinutes(e));
        pieces.push(`<div class="${open ? 'matrix-open' : 'matrix-closed'} ${d === nowDay ? 'today' : ''}">${open ? '可用' : '—'}</div>`);
      }
    }
    $('gymMatrix').innerHTML = pieces.join('');
  }

  function renderGymDayDetail() {
    const slots = D.gym.availability[selectedDay] || [];
    $('gymDayDetail').innerHTML = slots.length
      ? `<div class="gym-slot-list">${slots.map(([s,e]) => `<div class="gym-slot-row"><strong>${s}–${e}</strong><span>开放</span></div>`).join('')}</div>`
      : '<div class="empty-state">暂无可用时段</div>';
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

    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
      activePage = btn.dataset.page;
      document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === btn));
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === activePage));
      renderAll();
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
    renderGym();
  }

  function boot() {
    setupInteractions();
    renderAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    setInterval(() => renderAll(), 60000);
  }

  boot();
})();
