(() => {
  'use strict';

  const D = window.APP_DATA;
  if (!D) throw new Error('APP_DATA missing');

  const $ = (id) => document.getElementById(id);
  const weekdayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  const weekdayLong = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const palette = ['#5A76F0', '#D76884', '#2EA27E', '#D88937', '#8165D1', '#2D8AB8', '#C4618D', '#65853C', '#D0674A'];
  const fmtHeader = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const fmtMD = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

  const DAY_START = 7 * 60;
  const DAY_END = 22 * 60;
  const DAY_SPAN = DAY_END - DAY_START;

  const pad = (n) => String(n).padStart(2, '0');
  const nowDate = () => new Date();
  const mondayIndex = (d) => d.getDay() === 0 ? 7 : d.getDay();
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const minutesToTime = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  const timeToMinutes = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const parseLocalDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  };
  const addDays = (d, n) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pct = (mins) => clamp(((mins - DAY_START) / DAY_SPAN) * 100, 0, 100);

  function expandWeeks(spec) {
    const out = new Set();
    String(spec).split(/[、,，]/).map(x => x.trim()).filter(Boolean).forEach(part => {
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

  D.courses.forEach((course, index) => {
    course._id = index;
    course._weekSet = expandWeeks(course.weeks);
    course._color = stableColor(course.name);
  });

  function weekFromDate(d) {
    const w1 = parseLocalDate(D.semester.week1Monday);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.floor((day - w1) / 86400000 / 7) + 1;
  }

  const currentWeek = () => clamp(weekFromDate(nowDate()), 1, D.semester.totalWeeks);
  const weekStart = (week) => addDays(parseLocalDate(D.semester.week1Monday), (week - 1) * 7);
  const periodTime = (course) => ({ start: D.periods[course.start][0], end: D.periods[course.end][1] });

  function activeCourses(day, week) {
    return D.courses
      .filter(course => course.weekday === day && course._weekSet.has(week))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function gymSlots(day) {
    return (D.gym.availability[day] || []).map(([start, end]) => [timeToMinutes(start), timeToMinutes(end)]);
  }

  function dayFreeWindows(day, week) {
    let intervals = gymSlots(day).map(([start, end]) => [start, end]);
    const occupied = activeCourses(day, week).map(course => {
      const time = periodTime(course);
      return [timeToMinutes(time.start), timeToMinutes(time.end)];
    });

    for (const [occupiedStart, occupiedEnd] of occupied) {
      const next = [];
      for (const [start, end] of intervals) {
        if (occupiedEnd <= start || occupiedStart >= end) {
          next.push([start, end]);
        } else {
          if (occupiedStart > start) next.push([start, occupiedStart]);
          if (occupiedEnd < end) next.push([occupiedEnd, end]);
        }
      }
      intervals = next.filter(([start, end]) => end - start >= 20);
    }
    return intervals;
  }

  function formatDuration(mins) {
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function shortCourseName(name, span) {
    const names = {
      '思想政治理论课（硕士必修）': '思政必修',
      '思想政治理论课（硕士理工类必选）': '思政理工',
      '国际会议交流英语': '国际英语',
      '论文写作与学术规范': '论文规范',
      '高级软件过程管理': '高软管理',
      '高级人工智能': '高级AI',
      '应用数理统计': '应用统计',
      '前沿软件体系结构': '前沿架构'
    };
    const value = names[name] || name;
    return span <= 2 && value.length > 8 ? `${value.slice(0, 7)}…` : value;
  }

  function intervalsEqual(a, b) {
    return a.length === b.length && a.every((item, i) => item[0] === b[i][0] && item[1] === b[i][1]);
  }

  const periodStarts = Object.values(D.periods).map(([start]) => timeToMinutes(start));
  const periodEnds = Object.values(D.periods).map(([, end]) => timeToMinutes(end));
  const academicBoundaries = new Set([...periodStarts, ...periodEnds]);
  const gymBoundaries = [...new Set(Object.values(D.gym.availability).flatMap(slots => slots.flat()).map(timeToMinutes))].sort((a, b) => a - b);

  let selectedWeek = currentWeek();
  let selectedDay = mondayIndex(nowDate());
  function readStorage(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  let viewMode = readStorage('neu-schedule-view-mode') === 'day' ? 'day' : 'week';
  let timelineScrollTop = null;
  let firstTimelineRender = true;

  function renderHeader() {
    const now = nowDate();
    $('headerMeta').textContent = `${fmtHeader.format(now)} · ${D.semester.name}`;
    $('jumpToday').hidden = selectedWeek === currentWeek() && selectedDay === mondayIndex(now);
    $('toolbarNote').textContent = selectedWeek === currentWeek() ? '本周' : `第 ${selectedWeek} 周`;
  }

  function renderWeekCard() {
    const start = weekStart(selectedWeek);
    const end = addDays(start, 6);
    $('weekTitle').textContent = `第 ${selectedWeek} 周`;
    $('weekRange').textContent = `${fmtMD.format(start)} – ${fmtMD.format(end)}`;
    $('weekCard').classList.toggle('show-days', viewMode === 'day');

    const todayKey = dateKey(nowDate());
    $('dayStrip').innerHTML = Array.from({ length: 7 }, (_, i) => {
      const day = i + 1;
      const date = addDays(start, i);
      const hasClass = activeCourses(day, selectedWeek).length > 0;
      return `<button class="day-chip ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === todayKey ? 'today' : ''} ${hasClass ? 'has-class' : ''}" data-day="${day}" type="button">
        <span class="dow">周${weekdayNames[day]}</span>
        <span class="dom">${date.getDate()}</span>
      </button>`;
    }).join('');

    $('dayStrip').querySelectorAll('.day-chip').forEach(button => {
      button.addEventListener('click', () => {
        selectedDay = Number(button.dataset.day);
        renderAll();
      });
    });
  }

  function renderPanels() {
    document.querySelectorAll('.segment').forEach(button => button.classList.toggle('active', button.dataset.mode === viewMode));
    $('weekPanel').classList.toggle('active', viewMode === 'week');
    $('dayPanel').classList.toggle('active', viewMode === 'day');
    $('weekCard').classList.toggle('show-days', viewMode === 'day');
    if (viewMode === 'week') renderWeekView();
    else renderDayView();
  }

  function renderWeekView() {
    const scroll = $('timelineScroll');
    if (!firstTimelineRender) timelineScrollTop = scroll.scrollTop;

    const weekMonday = weekStart(selectedWeek);
    const now = nowDate();
    const todayKey = dateKey(now);
    const pieces = ['<div class="corner-head"><span>时间</span></div>'];

    for (let day = 1; day <= 7; day++) {
      const date = addDays(weekMonday, day - 1);
      pieces.push(`<button class="day-head ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === todayKey ? 'today' : ''}" style="grid-column:${day + 1};grid-row:1" data-day="${day}" type="button">
        <strong>周${weekdayNames[day]}</strong><span>${date.getMonth() + 1}/${date.getDate()}</span>
      </button>`);
    }

    pieces.push('<div class="time-axis" style="grid-column:1;grid-row:2">');
    for (let period = 1; period <= 12; period++) {
      const start = timeToMinutes(D.periods[period][0]);
      const hasNearGym = gymBoundaries.some(boundary => boundary < start && start - boundary <= 15);
      pieces.push(`<div class="period-label ${hasNearGym ? 'after-near-gym' : ''}" style="top:${pct(start)}%"><strong>${period}</strong><span>${D.periods[period][0]}</span></div>`);
    }
    for (const boundary of gymBoundaries) {
      if (boundary < DAY_START || boundary > DAY_END) continue;
      const aligned = academicBoundaries.has(boundary);
      const nextPeriod = periodStarts.find(start => start > boundary);
      const nearNext = nextPeriod != null && nextPeriod - boundary <= 15;
      const edgeTop = boundary === DAY_START;
      pieces.push(`<div class="gym-time-tag ${aligned ? 'aligned' : 'aux'} ${nearNext ? 'near-next' : ''} ${edgeTop ? 'edge-top' : ''}" style="top:${pct(boundary)}%">${minutesToTime(boundary)}</div>`);
    }
    pieces.push('</div>');

    for (let day = 1; day <= 7; day++) {
      pieces.push(`<div class="day-lane ${day === selectedDay ? 'selected-col' : ''}" style="grid-column:${day + 1};grid-row:2" data-day="${day}">`);

      for (const [start, end] of gymSlots(day)) {
        pieces.push(`<div class="gym-band" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%"></div>`);
      }

      for (const start of periodStarts) {
        pieces.push(`<div class="period-guide" style="top:${pct(start)}%"></div>`);
      }
      for (const end of periodEnds) {
        pieces.push(`<div class="period-guide minor" style="top:${pct(end)}%"></div>`);
      }

      const localGymBoundaries = [...new Set(gymSlots(day).flat())].sort((a, b) => a - b);
      for (const boundary of localGymBoundaries) {
        const aligned = academicBoundaries.has(boundary);
        pieces.push(`<div class="gym-guide ${aligned ? 'aligned' : 'aux'}" style="top:${pct(boundary)}%"></div>`);
      }

      for (const course of activeCourses(day, selectedWeek)) {
        const time = periodTime(course);
        const start = timeToMinutes(time.start);
        const end = timeToMinutes(time.end);
        const duration = end - start;
        pieces.push(`<button class="course-block ${duration < 95 ? 'compact' : ''}" type="button" data-course="${course._id}" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%;background:${course._color}">
          <span class="course-title">${escapeHtml(shortCourseName(course.name, course.end - course.start + 1))}</span>
          <span class="course-sub">${escapeHtml(course.location)}</span>
        </button>`);
      }

      if (selectedWeek === currentWeek() && day === mondayIndex(now)) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        if (currentMinutes >= DAY_START && currentMinutes <= DAY_END) {
          pieces.push(`<div class="current-time-line" style="top:${pct(currentMinutes)}%"></div>`);
        }
      }

      pieces.push(`<button class="lane-hitbox" type="button" data-day="${day}" aria-label="查看周${weekdayNames[day]}日程"></button>`);
      pieces.push('</div>');
    }

    $('timelineGrid').innerHTML = pieces.join('');

    $('timelineGrid').querySelectorAll('.day-head, .lane-hitbox').forEach(button => {
      button.addEventListener('click', () => {
        selectedDay = Number(button.dataset.day);
        viewMode = 'day';
        writeStorage('neu-schedule-view-mode', viewMode);
        renderAll();
      });
    });

    $('timelineGrid').querySelectorAll('.course-block').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        openCourse(Number(button.dataset.course));
      });
    });

    requestAnimationFrame(() => {
      if (firstTimelineRender) {
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const focusMinutes = selectedWeek === currentWeek() && currentMinutes >= DAY_START && currentMinutes <= DAY_END
          ? currentMinutes
          : 8 * 60 + 20;
        const contentHeight = $('timelineGrid').getBoundingClientRect().height - 52;
        const target = (pct(focusMinutes) / 100) * contentHeight - scroll.clientHeight * 0.32;
        scroll.scrollTop = Math.max(0, target);
        firstTimelineRender = false;
      } else if (timelineScrollTop != null) {
        scroll.scrollTop = timelineScrollTop;
      }
    });
  }

  function renderDayView() {
    const start = weekStart(selectedWeek);
    const date = addDays(start, selectedDay - 1);
    const courses = activeCourses(selectedDay, selectedWeek);
    const open = gymSlots(selectedDay);
    const free = dayFreeWindows(selectedDay, selectedWeek);
    const sameAsOpen = intervalsEqual(open, free);

    const freeChips = free.length
      ? free.map(([s, e]) => `<span>${minutesToTime(s)}–${minutesToTime(e)} · ${formatDuration(e - s)}</span>`).join('')
      : '<span class="muted-chip">没有可直接去健身的空档</span>';

    const rawOpen = open.length ? open.map(([s, e]) => `${minutesToTime(s)}–${minutesToTime(e)}`).join(' / ') : '暂无开放时段';
    const gymRows = sameAsOpen
      ? `<div class="info-row"><span class="info-label">可去健身</span><div class="free-chips">${freeChips}</div><p class="sub-note">与当天课程无冲突 · 表更新 ${D.gym.updated.replaceAll('-', '.')}</p></div>`
      : `<div class="info-row"><span class="info-label">健身房开放</span><span class="info-value">${rawOpen}</span></div>
         <div class="info-row"><span class="info-label">扣除课程后可去</span><div class="free-chips">${freeChips}</div></div>`;

    $('dayOverview').innerHTML = `
      <div class="day-overview-top">
        <div><strong>${weekdayLong[selectedDay]} · ${fmtMD.format(date)}</strong><span>第 ${selectedWeek} 周 · ${courses.length ? `${courses.length} 段课程` : '没有课程'}</span></div>
        <div class="status-badge">${dateKey(date) === dateKey(nowDate()) && selectedWeek === currentWeek() ? '今天' : '日程'}</div>
      </div>
      ${gymRows}`;

    if (!courses.length) {
      $('agendaList').innerHTML = '<div class="empty-state">这一天没有课程。健身房时间已经在上方整理好。</div>';
      return;
    }

    $('agendaList').innerHTML = courses.map(course => {
      const time = periodTime(course);
      return `<button class="agenda-card" type="button" data-course="${course._id}">
        <div class="agenda-time"><strong>${time.start}</strong><span>${time.end}<br>${course.start}-${course.end}节</span></div>
        <div class="agenda-bar" style="background:${course._color}"></div>
        <div class="agenda-main"><div class="agenda-title">${escapeHtml(course.name)}</div><div class="agenda-meta">${escapeHtml(course.location)} · ${escapeHtml(course.teacher)}${course.className ? ` · ${escapeHtml(course.className)}` : ''}</div></div>
      </button>`;
    }).join('');

    $('agendaList').querySelectorAll('.agenda-card').forEach(button => {
      button.addEventListener('click', () => openCourse(Number(button.dataset.course)));
    });
  }

  function openCourse(id) {
    const course = D.courses.find(item => item._id === id);
    if (!course) return;
    const time = periodTime(course);
    $('courseDetailTitle').textContent = course.name;
    $('courseDetailBody').innerHTML = [
      detail('时间', `${weekdayLong[course.weekday]} ${time.start}–${time.end} · ${course.start}-${course.end}节`),
      detail('地点', course.location),
      detail('教师', course.teacher),
      detail('周数', `第 ${course.weeks} 周`),
      detail('班级', course.className || '—', true)
    ].join('');
    $('courseDialog').showModal();
  }

  function detail(label, value, full = false) {
    return `<div class="detail-item ${full ? 'full' : ''}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function showWeekPicker() {
    const current = currentWeek();
    $('weekChoices').innerHTML = Array.from({ length: D.semester.totalWeeks }, (_, i) => {
      const week = i + 1;
      return `<button type="button" class="week-choice ${week === selectedWeek ? 'active' : ''} ${week === current ? 'current' : ''}" data-week="${week}">${week}</button>`;
    }).join('');
    $('weekChoices').querySelectorAll('.week-choice').forEach(button => {
      button.addEventListener('click', () => {
        selectedWeek = Number(button.dataset.week);
        $('weekDialog').close();
        renderAll();
      });
    });
    $('weekDialog').showModal();
  }

  function changeWeek(delta) {
    selectedWeek = clamp(selectedWeek + delta, 1, D.semester.totalWeeks);
    renderAll();
  }

  function jumpToday() {
    selectedWeek = currentWeek();
    selectedDay = mondayIndex(nowDate());
    renderAll();
  }

  function setupInteractions() {
    $('prevWeek').addEventListener('click', () => changeWeek(-1));
    $('nextWeek').addEventListener('click', () => changeWeek(1));
    $('weekPickerButton').addEventListener('click', showWeekPicker);
    $('jumpToday').addEventListener('click', jumpToday);

    document.querySelectorAll('.segment').forEach(button => {
      button.addEventListener('click', () => {
        viewMode = button.dataset.mode;
        writeStorage('neu-schedule-view-mode', viewMode);
        renderWeekCard();
        renderPanels();
      });
    });

    let touchX = null;
    let touchY = null;
    $('weekSwipeZone').addEventListener('touchstart', event => {
      const touch = event.changedTouches[0];
      touchX = touch.clientX;
      touchY = touch.clientY;
    }, { passive: true });
    $('weekSwipeZone').addEventListener('touchend', event => {
      if (touchX == null) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - touchX;
      const dy = touch.clientY - touchY;
      touchX = touchY = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) changeWeek(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function renderAll() {
    renderHeader();
    renderWeekCard();
    renderPanels();
  }

  function boot() {
    setupInteractions();
    renderAll();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=6', { updateViaCache: 'none' }).catch(() => {});
    setInterval(() => {
      renderHeader();
      if (viewMode === 'week') renderWeekView();
      else renderDayView();
    }, 60000);
  }

  boot();
})();
