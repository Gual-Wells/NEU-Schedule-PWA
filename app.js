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

  const DAY_START = 0;
  const DAY_END = 24 * 60;
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
  const gymVersion = (day, week) => {
    const date = addDays(weekStart(week), day - 1);
    const ordinal = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
    return ordinal % 2 ? 'gym-odd' : 'gym-even';
  };
  const skipKey = (date, course) => `${dateKey(date)}:${course._id}`;
  const courseDate = (course, week) => addDays(weekStart(week), course.weekday - 1);
  let skipped;
  try { skipped = new Set(JSON.parse(localStorage.getItem('neu-schedule-skipped-v7') || '[]')); }
  catch (_) { skipped = new Set(); }
  let activeDateKey = dateKey(nowDate());
  const cloud = window.CloudSync;
  const gymStore = window.GymStore.create(localStorage, (before, after) => cloud?.recordSessions(before, after));
  let gymMessage = '';
  const activeGymSession = () => gymStore.active();
  const formatDuration = (ms, withSeconds = false) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return withSeconds ? `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}` : `${hours ? `${hours}h` : ''}${minutes}m`;
  };

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

  function rawCourses(day, week) {
    return D.courses
      .filter(course => course.weekday === day && course._weekSet.has(week))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const isSkipped = (course, week) => skipped.has(skipKey(courseDate(course, week), course));
  function activeCourses(day, week) {
    return rawCourses(day, week).filter(course => !isSkipped(course, week));
  }

  function gymSlots(day) {
    return (D.gym.availability[day] || []).map(([start, end]) => [timeToMinutes(start), timeToMinutes(end)]);
  }
  const isInside = (intervals, minute) => intervals.some(([start, end]) => start <= minute && minute < end);

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
      intervals = next.filter(([start, end]) => end > start);
    }
    return intervals;
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

  const periodStarts = Object.values(D.periods).map(([start]) => timeToMinutes(start));
  const periodEnds = Object.values(D.periods).map(([, end]) => timeToMinutes(end));
  const academicBoundaries = new Set([...periodStarts, ...periodEnds]);
  const gymBoundaries = [...new Set(Object.values(D.gym.availability).flatMap(slots => slots.flat()).map(timeToMinutes))].sort((a, b) => a - b);

  let selectedWeek = currentWeek();
  let selectedDay = mondayIndex(nowDate());
  const selectedDate = () => addDays(weekStart(selectedWeek), selectedDay - 1);
  function readStorage(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function writeStorage(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  const requestedView = new URLSearchParams(location.search).get('view') || readStorage('neu-schedule-view-mode');
  let viewMode = ['week', 'day', 'gym'].includes(requestedView) ? requestedView : 'week';
  let timelineScrollTop = null;
  let firstTimelineRender = true;
  let dayFocus = true;
  let gymPeriod = 'week';
  let gymChartWeeks = 12;
  let gymChartMetric = 'duration';
  let gymShowAll = false;

  function renderHeader() {
    const now = nowDate();
    $('headerMeta').textContent = `${fmtHeader.format(now)} · ${D.semester.name}`;
    $('jumpToday').hidden = viewMode === 'gym' || selectedWeek === currentWeek() && selectedDay === mondayIndex(now);
    $('toolbarNote').textContent = viewMode === 'gym' ? '' : selectedWeek === currentWeek() ? '本周' : `第 ${selectedWeek} 周`;
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
      const hasClass = rawCourses(day, selectedWeek).length > 0;
      return `<button class="day-chip ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === todayKey ? 'today' : ''} ${hasClass ? 'has-class' : ''}" data-day="${day}" type="button">
        <span class="dow">周${weekdayNames[day]}</span>
        <span class="dom">${date.getDate()}</span>
      </button>`;
    }).join('');

    $('dayStrip').querySelectorAll('.day-chip').forEach(button => {
      button.addEventListener('click', () => {
        selectedDay = Number(button.dataset.day);
        dayFocus = true;
        renderAll();
      });
    });
  }

  function renderPanels() {
    document.querySelectorAll('.segment').forEach(button => button.classList.toggle('active', button.dataset.mode === viewMode));
    $('app').classList.toggle('gym-mode', viewMode === 'gym');
    $('weekCard').hidden = viewMode === 'gym';
    $('weekPanel').classList.toggle('active', viewMode === 'week');
    $('dayPanel').classList.toggle('active', viewMode === 'day');
    $('gymPanel').classList.toggle('active', viewMode === 'gym');
    $('weekCard').classList.toggle('show-days', viewMode === 'day');
    if (viewMode === 'week') renderWeekView();
    else if (viewMode === 'day') renderDayView();
    else renderGymView();
  }

  function renderWeekView() {
    const scroll = $('timelineScroll');
    if (!firstTimelineRender) timelineScrollTop = scroll.scrollTop;

    const weekMonday = weekStart(selectedWeek);
    const now = nowDate();
    const todayKey = dateKey(now);
    const pieces = ['<div class="corner-head"><span>节次·时间</span></div>'];

    for (let day = 1; day <= 7; day++) {
      const date = addDays(weekMonday, day - 1);
      pieces.push(`<button class="day-head ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === todayKey ? 'today' : ''}" style="grid-column:${day + 1};grid-row:1" data-day="${day}" type="button">
        <strong>周${weekdayNames[day]}</strong><span>${date.getMonth() + 1}/${date.getDate()}</span>
      </button>`);
    }

    pieces.push('<div class="time-axis" style="grid-column:1;grid-row:2">');
    pieces.push('<div class="day-endpoint first" style="top:0%">00:00</div><div class="day-endpoint last" style="top:100%">24:00</div>');
    for (let period = 1; period <= 12; period++) {
      const start = timeToMinutes(D.periods[period][0]);
      const end = timeToMinutes(D.periods[period][1]);
      pieces.push(`<div class="period-slot" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%"><strong>${period}节</strong><span class="period-start">${D.periods[period][0]}</span><span class="period-end">${D.periods[period][1]}</span></div>`);
    }
    for (const boundary of gymBoundaries) {
      if (boundary <= DAY_START || boundary >= DAY_END || academicBoundaries.has(boundary)) continue;
      pieces.push(`<div class="gym-time-tag aux" style="top:${pct(boundary)}%">${minutesToTime(boundary)}</div>`);
    }
    pieces.push('</div>');

    for (let day = 1; day <= 7; day++) {
      pieces.push(`<div class="day-lane ${gymVersion(day, selectedWeek)} ${day === selectedDay ? 'selected-col' : ''}" style="grid-column:${day + 1};grid-row:2" data-day="${day}">`);

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

      for (const course of rawCourses(day, selectedWeek)) {
        const time = periodTime(course);
        const start = timeToMinutes(time.start);
        const end = timeToMinutes(time.end);
        const duration = end - start;
        const skippedToday = isSkipped(course, selectedWeek);
        pieces.push(`<button class="course-block ${duration < 95 ? 'compact' : ''} ${skippedToday ? 'skipped' : ''}" type="button" data-course="${course._id}" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%;--course-color:${course._color}">
          <span class="course-title">${escapeHtml(shortCourseName(course.name, course.end - course.start + 1))}</span>
          <span class="course-period">第${course.start}–${course.end}节</span>
          <span class="course-time">${time.start}–${time.end}</span>
          ${skippedToday ? '<span class="course-skip-label">已翘</span>' : ''}
        </button>`);
      }

      if (dateKey(addDays(weekMonday, day - 1)) === dateKey(now)) {
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
        dayFocus = true;
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
        const contentHeight = $('timelineGrid').querySelector('.day-lane').getBoundingClientRect().height;
        const target = (pct(focusMinutes) / 100) * contentHeight - scroll.clientHeight * 0.32;
        scroll.scrollTop = Math.max(0, target);
        firstTimelineRender = false;
      } else if (timelineScrollTop != null) {
        scroll.scrollTop = timelineScrollTop;
      }
    });
  }

  function persistSkipped() {
    writeStorage('neu-schedule-skipped-v7', JSON.stringify([...skipped]));
    cloud?.recordSkips([...skipped].map(key => Number(key.split(':').pop())).filter(Number.isInteger));
    schedulePushSync();
  }
  function refreshDailyState() {
    const now = nowDate();
    const today = dateKey(now);
    const changedDay = today !== activeDateKey;
    const wasShowingToday = changedDay && dateKey(selectedDate()) === activeDateKey;
    const validKeys = new Set(rawCourses(mondayIndex(now), currentWeek()).map(course => skipKey(now, course)));
    if (changedDay || [...skipped].some(key => !validKeys.has(key))) {
      skipped = new Set([...skipped].filter(key => validKeys.has(key)));
      persistSkipped();
    }
    try { if (gymStore.reconcile(now.getTime())) schedulePushSync(); }
    catch (error) { gymMessage = `训练记录保存失败：${error.message}`; }
    activeDateKey = today;
    if (wasShowingToday) {
      selectedWeek = currentWeek();
      selectedDay = mondayIndex(now);
      dayFocus = true;
      timelineScrollTop = null;
      firstTimelineRender = true;
    }
    return changedDay;
  }
  const canSkipCourse = (course) => Boolean(course && course._weekSet.has(selectedWeek) && dateKey(courseDate(course, selectedWeek)) === dateKey(nowDate()));
  function startGymSession() {
    const now = nowDate();
    const minute = now.getHours() * 60 + now.getMinutes();
    const slot = gymSlots(mondayIndex(now)).find(([start, end]) => start <= minute && minute < end);
    if (!slot) { gymMessage = '现在不在健身房开放时段。'; return; }
    try {
      const closesAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, slot[1]).getTime();
      gymStore.start(now.getTime(), closesAt);
      gymMessage = '训练已开始，离开页面后计时仍按开始时间计算。';
      schedulePushSync();
    } catch (error) { gymMessage = `开始失败：${error.message}`; }
  }
  function endGymSession() {
    try {
      gymStore.stop(Date.now());
      gymMessage = '训练已保存。';
      schedulePushSync();
    } catch (error) { gymMessage = `结束失败：${error.message}`; }
  }
  function skipCourse(course) {
    refreshDailyState();
    if (!canSkipCourse(course)) return false;
    skipped.add(skipKey(courseDate(course, selectedWeek), course));
    persistSkipped();
    renderAll();
    return true;
  }
  function restoreCourse(course) {
    refreshDailyState();
    if (!canSkipCourse(course)) return false;
    skipped.delete(skipKey(courseDate(course, selectedWeek), course));
    persistSkipped();
    renderAll();
    return true;
  }
  function dayState(date, courses, skippedCourses) {
    const now = nowDate();
    const live = dateKey(date) === dateKey(now);
    const minute = now.getHours() * 60 + now.getMinutes();
    const open = gymSlots(selectedDay);
    const free = dayFreeWindows(selectedDay, selectedWeek);
    if (!live) return { live, minute, title: '查看这一天', subtitle: '课程与健身房按真实时间排列', notices: [], actions: '' };
    const ongoing = courses.find(course => {
      const t = periodTime(course);
      return timeToMinutes(t.start) <= minute && minute < timeToMinutes(t.end);
    });
    const soon = courses.filter(course => {
      const start = timeToMinutes(periodTime(course).start);
      return start > minute && start - minute <= 30;
    });
    const openNow = isInside(open, minute);
    const freeNow = isInside(free, minute);
    const session = activeGymSession();
    const gymActive = Boolean(session);
    const notices = [];
    if (ongoing) {
      const end = timeToMinutes(periodTime(ongoing).end);
      notices.push({ kind: 'class', text: `正在上 ${ongoing.name} · ${ongoing.location}`, note: ongoing.note });
      if (end - minute <= 30) notices.push({ kind: 'soon', text: `${end - minute} 分钟后下课` });
    }
    for (const course of soon) {
      const start = timeToMinutes(periodTime(course).start);
      notices.push({ kind: 'soon', text: `${start - minute} 分钟后去 ${course.location} 上${course.name}`, note: course.note });
    }
    if (gymActive) notices.push({ kind: 'gym', text: `正在健身 · ${formatDuration(now.getTime() - session.startAt)}` });
    else if (freeNow) notices.push({ kind: 'gym', text: '健身房开放，现在可以去' });
    else if (openNow && ongoing) notices.push({ kind: 'gym', text: '健身房开放，与当前课程时间重叠' });
    const nextFree = free.find(([start]) => start > minute && start - minute <= 30);
    if (nextFree) {
      const physicalOpening = open.some(([start]) => start === nextFree[0]);
      notices.push({ kind: 'soon', text: `${nextFree[0] - minute} 分钟后${physicalOpening ? '健身房开放' : '可以去健身'}` });
    }
    const closing = open.find(([start, end]) => start <= minute && minute < end && end - minute <= 30);
    if (closing) notices.push({ kind: 'soon', text: `健身房 ${closing[1] - minute} 分钟后关闭` });
    let actions = '';
    if (openNow || gymActive) actions += `<button type="button" class="action-button gym-action" data-action="${gymActive ? 'end-gym' : 'start-gym'}">${gymActive ? '结束健身' : '开始健身'}</button>`;
    for (const course of [ongoing, ...soon].filter(Boolean)) {
      actions += `<button type="button" class="action-button skip-action" data-skip="${course._id}">翘掉${shortCourseName(course.name, course.end - course.start + 1)}</button>`;
    }
    for (const course of skippedCourses) {
      const time = periodTime(course);
      const start = timeToMinutes(time.start), end = timeToMinutes(time.end);
      if (start <= minute && minute < end) notices.push({ kind: 'skip', text: `已翘 · ${course.name}正在进行，${time.end}结束` });
      else if (start > minute && start - minute <= 30) notices.push({ kind: 'skip', text: `已翘 · ${course.name}将在 ${start - minute} 分钟后开始` });
    }
    const title = gymActive ? '正在健身' : ongoing ? `正在上 ${shortCourseName(ongoing.name, ongoing.end - ongoing.start + 1)}` : freeNow ? '现在可以去健身' : '当前没有安排';
    return { live, minute, title, subtitle: `${minutesToTime(minute)} · ${notices.length ? '当前与即将发生' : '看看今天的时间图'}`, notices, actions };
  }
  function renderDayView() {
    const date = selectedDate();
    const courses = rawCourses(selectedDay, selectedWeek);
    const skippedCourses = courses.filter(course => isSkipped(course, selectedWeek));
    const state = dayState(date, courses.filter(course => !isSkipped(course, selectedWeek)), skippedCourses);
    const now = nowDate();
    const hourAngle = (now.getHours() % 12 + now.getMinutes() / 60) * 30;
    const minuteAngle = now.getMinutes() * 6;
    const skipCount = rawCourses(selectedDay, selectedWeek).filter(course => skipped.has(skipKey(date, course))).length;
    $('dayDashboard').innerHTML = `
      <div class="dashboard-date"><strong>${weekdayLong[selectedDay]} · ${fmtMD.format(date)}</strong><span>第 ${selectedWeek} 周 · ${courses.length} 段课程${skippedCourses.length ? ` · 已翘 ${skippedCourses.length}` : ''}</span></div>
      <div class="now-row">
        <div class="clock" aria-label="当前时间 ${minutesToTime(now.getHours() * 60 + now.getMinutes())}"><i class="hand hour" style="--rotation:${hourAngle}deg"></i><i class="hand minute" style="--rotation:${minuteAngle}deg"></i><i class="clock-center"></i></div>
        <div class="now-text"><span class="clock-digital">${minutesToTime(now.getHours() * 60 + now.getMinutes())}</span><h2>${escapeHtml(state.title)}</h2><p>${escapeHtml(state.subtitle)}</p></div>
      </div>
      ${state.notices.length ? `<div class="event-notices">${state.notices.map(n => `<div class="event-notice ${n.kind}"><span class="notice-dot"></span><span>${escapeHtml(n.text)}</span>${n.note ? `<small>${escapeHtml(n.note)}</small>` : ''}</div>`).join('')}</div>` : ''}
      ${state.actions ? `<div class="dashboard-actions">${state.actions}</div>` : ''}
      ${skipCount ? `<div class="undo-bar"><button type="button" class="undo-trigger" id="undoTrigger">已跳过 ${skipCount} 节 · 单节撤销</button><button type="button" class="undo-all" data-undo-all>一键撤销全部旷课</button></div>` : ''}`;
    const parts = ['<div class="map-heading"><strong>当日时间图</strong><span>00:00–24:00 · 课程与健身房</span></div><div class="day-map-inner"><div class="map-axis">'];
    parts.push('<div class="day-endpoint first" style="top:0%">00:00</div><div class="day-endpoint last" style="top:100%">24:00</div>');
    for (let n = 1; n <= 12; n++) {
      const [start, end] = D.periods[n];
      parts.push(`<div class="map-period" style="top:${pct(timeToMinutes(start))}%;height:${pct(timeToMinutes(end)) - pct(timeToMinutes(start))}%"><strong>${n}节</strong><span class="period-start">${start}</span><span class="period-end">${end}</span></div>`);
    }
    parts.push('</div>');
    parts.push(`<div class="map-track ${gymVersion(selectedDay, selectedWeek)}">`);
    for (const [start, end] of gymSlots(selectedDay)) {
      parts.push(`<div class="gym-band" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%"></div>`);
      parts.push(`<div class="map-gym-edge" style="top:${pct(start)}%">健身 ${minutesToTime(start)}开始</div><div class="map-gym-edge end" style="top:${pct(end)}%">${minutesToTime(end)}结束</div>`);
    }
    for (const [start, end] of Object.values(D.periods)) {
      parts.push(`<div class="period-guide" style="top:${pct(timeToMinutes(start))}%"></div><div class="period-guide minor" style="top:${pct(timeToMinutes(end))}%"></div>`);
    }
    for (const course of courses) {
      const t = periodTime(course);
      const start = timeToMinutes(t.start), end = timeToMinutes(t.end);
      const skippedToday = isSkipped(course, selectedWeek);
      parts.push(`<button type="button" class="map-course ${skippedToday ? 'skipped' : ''}" data-course="${course._id}" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%;--course-color:${course._color}">
        <strong>${escapeHtml(course.name)}${skippedToday ? ' · 已翘' : ''}</strong><span>第${course.start}–${course.end}节 · ${t.start}–${t.end}</span><span>${escapeHtml(course.location)}${course.className ? ` · ${escapeHtml(course.className)}` : ''}${course.note ? ` · ${escapeHtml(course.note)}` : ''}</span>
      </button>`);
    }
    if (state.live && state.minute >= DAY_START && state.minute <= DAY_END)
      parts.push(`<div class="day-progress" style="height:${pct(state.minute)}%"></div><div class="day-now-line" style="top:${pct(state.minute)}%"><span>${minutesToTime(state.minute)}</span></div>`);
    parts.push('</div></div>');
    $('dayMap').innerHTML = parts.join('');
    if (dayFocus) requestAnimationFrame(() => {
      const panel = $('dayMap');
      const focus = state.live && state.minute >= DAY_START && state.minute <= DAY_END
        ? pct(state.minute) / 100 * panel.querySelector('.day-map-inner').getBoundingClientRect().height : 0;
      panel.scrollTop = Math.max(0, focus - panel.clientHeight * .55);
      dayFocus = false;
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
      ...(course.className ? [detail('班级', course.className, true)] : []),
      ...(course.note ? [detail('备注', course.note, true)] : [])
    ].join('');
    $('skipCourseButton').dataset.course = String(id);
    const canSkip = canSkipCourse(course);
    $('skipCourseButton').disabled = !canSkip;
    $('skipCourseButton').textContent = canSkip ? isSkipped(course, selectedWeek) ? '恢复这节课' : '翘掉这节课' : '只能标记今天的课';
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
        dayFocus = true;
        $('weekDialog').close();
        renderAll();
      });
    });
    $('weekDialog').showModal();
  }

  function changeWeek(delta) {
    selectedWeek = clamp(selectedWeek + delta, 1, D.semester.totalWeeks);
    dayFocus = true;
    renderAll();
  }

  function jumpToday() {
    selectedWeek = currentWeek();
    selectedDay = mondayIndex(nowDate());
    dayFocus = true;
    renderAll();
  }

  function setupInteractions() {
    $('prevWeek').addEventListener('click', () => changeWeek(-1));
    $('nextWeek').addEventListener('click', () => changeWeek(1));
    $('weekPickerButton').addEventListener('click', showWeekPicker);
    $('jumpToday').addEventListener('click', jumpToday);
    $('skipCourseButton').addEventListener('click', () => {
      const course = D.courses[Number($('skipCourseButton').dataset.course)];
      if (!course) return;
      const changed = isSkipped(course, selectedWeek) ? restoreCourse(course) : skipCourse(course);
      if (changed) $('courseDialog').close();
    });
    $('dayMap').addEventListener('click', event => {
      const button = event.target.closest('[data-course]');
      if (button) openCourse(Number(button.dataset.course));
    });
    $('dayDashboard').addEventListener('click', event => {
      const skip = event.target.closest('[data-skip]');
      if (skip) {
        skipCourse(D.courses[Number(skip.dataset.skip)]);
        return;
      }
      const action = event.target.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'start-gym') startGymSession();
        else endGymSession();
        renderAll();
        return;
      }
      const trigger = event.target.closest('#undoTrigger');
      if (trigger) {
        const hidden = rawCourses(selectedDay, selectedWeek).filter(course => skipped.has(skipKey(selectedDate(), course)));
        trigger.outerHTML = `<div class="undo-choices">${hidden.map(course => `<button type="button" data-undo="${course._id}">撤销第${course.start}–${course.end}节跳过</button>`).join('')}</div>`;
        return;
      }
      const undoAll = event.target.closest('[data-undo-all]');
      if (undoAll) {
        refreshDailyState();
        if (dateKey(selectedDate()) !== dateKey(nowDate())) return;
        skipped.clear();
        persistSkipped();
        renderAll();
        return;
      }
      const undo = event.target.closest('[data-undo]');
      if (undo) {
        const course = D.courses[Number(undo.dataset.undo)];
        if (course) restoreCourse(course);
      }
    });

    $('gymPanel').addEventListener('click', event => {
      const period = event.target.closest('[data-gym-period]');
      if (period) { gymPeriod = period.dataset.gymPeriod; renderGymView(); return; }
      const record = event.target.closest('[data-session]');
      if (record) {
        const session = gymStore.list().find(item => item.id === record.dataset.session);
        if (!session || session.endAt === null) return;
        $('sessionDialog').dataset.session = session.id;
        $('sessionStart').value = dateTimeInput(session.startAt);
        $('sessionEnd').value = dateTimeInput(session.endAt);
        $('sessionStatus').textContent = session.endReason === 'closing' ? '此记录在健身房关闭时自动结束，请核对实际结束时间。' : '';
        $('sessionDialog').showModal();
        return;
      }
      const command = event.target.closest('[data-gym-command]');
      if (!command) return;
      if (command.dataset.gymCommand === 'start') startGymSession();
      else if (command.dataset.gymCommand === 'stop') endGymSession();
      else if (command.dataset.gymCommand === 'toggle-all') gymShowAll = !gymShowAll;
      else if (command.dataset.gymCommand === 'import') { $('gymImportFile').click(); return; }
      else if (command.dataset.gymCommand === 'export') {
        const blob = new Blob([JSON.stringify({ version: 1, sessions: gymStore.list() }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `neu-gym-${dateKey(nowDate())}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      renderAll();
    });
    $('gymPanel').addEventListener('change', async event => {
      if (event.target.id === 'gymChartWeeks') gymChartWeeks = Number(event.target.value);
      else if (event.target.id === 'gymChartMetric') gymChartMetric = event.target.value;
      else if (event.target.id === 'gymImportFile') {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          const backup = JSON.parse(await file.text());
          if (backup.version !== 1) throw new Error('备份版本不受支持。');
          const count = gymStore.importSessions(backup.sessions);
          gymMessage = `已导入 ${count} 条记录，等待云端同步。`;
        } catch (error) { gymMessage = `导入失败：${error.message}`; }
      } else return;
      renderGymView();
    });
    $('closeSessionDialog').addEventListener('click', () => $('sessionDialog').close());
    $('sessionForm').addEventListener('submit', event => {
      event.preventDefault();
      try {
        gymStore.revise($('sessionDialog').dataset.session, new Date($('sessionStart').value).getTime(), new Date($('sessionEnd').value).getTime());
        gymMessage = '训练时间已修改。';
        $('sessionDialog').close();
        renderGymView();
      } catch (error) { $('sessionStatus').textContent = error.message; }
    });
    $('deleteSession').addEventListener('click', () => {
      if (!confirm('确定删除这条训练记录吗？')) return;
      try {
        gymStore.remove($('sessionDialog').dataset.session);
        gymMessage = '训练记录已删除。';
        $('sessionDialog').close();
        renderGymView();
      } catch (error) { $('sessionStatus').textContent = error.message; }
    });

    document.querySelectorAll('.segment').forEach(button => {
      button.addEventListener('click', () => {
        viewMode = button.dataset.mode;
        dayFocus = true;
        writeStorage('neu-schedule-view-mode', viewMode);
        cloud?.recordSettings(viewMode);
        renderAll();
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
    refreshDailyState();
    renderHeader();
    renderWeekCard();
    renderPanels();
  }

  const pushBase = () => String(window.PUSH_API_BASE || '').replace(/\/$/, '');
  let pushSyncTimer = null;
  const pushToken = () => readStorage('neu-schedule-push-token-v1');
  function pushStatus(message) { $('pushStatus').textContent = message; }
  async function pushRequest(path, body, token) {
    const response = await fetch(`${pushBase()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
    return result;
  }
  function b64ToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
  }
  function buildPushJobs() {
    const now = Date.now();
    const jobs = [];
    const add = (id, date, minute, before, title, body, ttl = 600) => {
      const dueAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minute - before).getTime();
      if (dueAt > now + 5000) jobs.push({ id, dueAt, title, body, ttl });
    };
    for (let week = 1; week <= D.semester.totalWeeks; week++) {
      for (let day = 1; day <= 7; day++) {
        const date = addDays(weekStart(week), day - 1);
        if (addDays(date, 1).getTime() < now) continue;
        const key = dateKey(date);
        for (const course of rawCourses(day, week)) {
          const time = periodTime(course);
          const start = timeToMinutes(time.start), end = timeToMinutes(time.end);
          const suffix = `${key}-c${course._id}`;
          if (isSkipped(course, week)) {
            add(`${suffix}-p30`, date, start, 30, '已翘课程 · 30 分钟后开始', `${course.name} · ${time.start}–${time.end} · ${course.location}`, 900);
            add(`${suffix}-p5`, date, start, 5, '已翘课程 · 5 分钟后开始', `${course.name} · ${course.location}`, 600);
            add(`${suffix}-e30`, date, end, 30, '已翘课程 · 30 分钟后结束', `${course.name} · ${time.end}结束`, 900);
          } else {
            add(`${suffix}-p30`, date, start, 30, '30 分钟后上课', `${course.name} · ${course.location}${course.note ? ` · ${course.note}` : ''}`, 900);
            add(`${suffix}-p5`, date, start, 5, '5 分钟后上课', `${course.name} · ${course.location}`, 600);
            add(`${suffix}-e30`, date, end, 30, '30 分钟后下课', course.name, 900);
          }
        }
        dayFreeWindows(day, week).forEach(([start, end], index) => {
          const suffix = `${key}-g${index}`;
          add(`${suffix}-open`, date, start, 30, '30 分钟后可以健身', `${minutesToTime(start)}–${minutesToTime(end)} 可去健身`, 900);
          const activeSession = activeGymSession() && dateKey(new Date(activeGymSession().startAt)) === key &&
            end === new Date(activeGymSession().closesAt).getHours() * 60 + new Date(activeGymSession().closesAt).getMinutes();
          add(`${suffix}-close`, date, end, 30, activeSession ? '正在健身 · 30 分钟后时段结束' : '可健身时段还有 30 分钟', `${minutesToTime(end)} 结束`, 900);
        });
      }
    }
    return jobs.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  }
  async function syncPush() {
    const token = pushToken();
    if (!token || !pushBase()) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription || subscription.endpoint !== readStorage('neu-schedule-push-endpoint-v1')) {
      pushStatus('推送订阅已变化，请输入配对码重新开启。');
      return;
    }
    const result = await pushRequest('/sync', { jobs: buildPushJobs() }, token);
    pushStatus(`后台提醒已同步：${result.count} 条未来提醒。`);
  }
  function schedulePushSync() {
    if (!pushToken() || !pushBase()) return;
    clearTimeout(pushSyncTimer);
    pushSyncTimer = setTimeout(() => syncPush().catch(error => pushStatus(`同步失败：${error.message}`)), 400);
  }
  async function enablePush() {
    if (!pushBase()) { pushStatus('后台服务尚未部署。'); return; }
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      pushStatus('当前浏览器不支持 Web Push。'); return;
    }
    const code = $('pairingCode').value.trim();
    if (!code) { pushStatus('请输入配对码。'); return; }
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches) {
      pushStatus('iPhone 请先加入主屏幕，再从主屏幕打开课表。'); return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { pushStatus('通知权限未开启，请在系统设置中允许通知。'); return; }
    pushStatus('正在建立订阅…');
    try {
      const config = await pushRequest('/config');
      const registration = await navigator.serviceWorker.register('./sw.js?v=19', { updateViaCache: 'none' });
      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const oldKey = subscription.options?.applicationServerKey;
        if (oldKey && Array.from(new Uint8Array(oldKey)).join(',') !== Array.from(b64ToBytes(config.publicKey)).join(',')) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.publicKey) });
      const result = await pushRequest('/register', { code, subscription: subscription.toJSON() });
      writeStorage('neu-schedule-push-token-v1', result.token);
      writeStorage('neu-schedule-push-endpoint-v1', subscription.endpoint);
      $('pairingCode').value = '';
      initCloud();
      await syncPush();
    } catch (error) { pushStatus(`开启失败：${error.message}`); }
  }
  async function disablePush() {
    const token = pushToken();
    if (!token) { pushStatus('后台提醒尚未开启。'); return; }
    try {
      await pushRequest('/disable', {}, token);
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      writeStorage('neu-schedule-push-token-v1', '');
      writeStorage('neu-schedule-push-endpoint-v1', '');
      pushStatus('后台提醒已关闭。');
    } catch (error) { pushStatus(`关闭失败：${error.message}`); }
  }
  function setupPush() {
    $('pushSettingsButton').addEventListener('click', () => {
      pushStatus(!pushBase() ? '后台服务尚未部署。' : pushToken() ? '后台提醒已开启。' : '输入配对码后开启后台提醒。');
      $('pushDialog').showModal();
    });
    $('closePushDialog').addEventListener('click', () => $('pushDialog').close());
    $('enablePush').addEventListener('click', enablePush);
    $('disablePush').addEventListener('click', disablePush);
    $('testPush').addEventListener('click', async () => {
      if (!pushToken()) { pushStatus('请先开启后台提醒。'); return; }
      try { await pushRequest('/test', {}, pushToken()); pushStatus('测试通知已发出，请查看系统通知。'); }
      catch (error) { pushStatus(`测试失败：${error.message}`); }
    });
  }

  const startOfWeek = (date) => {
    const start = addDays(date, 1 - mondayIndex(date));
    start.setHours(0, 0, 0, 0);
    return start;
  };
  const sessionDuration = (session, now = Date.now()) => Math.max(0, (session.endAt ?? Math.min(now, session.closesAt)) - session.startAt);
  const sessionInRange = (session, start, end) => session.startAt >= start.getTime() && session.startAt < end.getTime();
  const summary = (sessions, start, end) => {
    const filtered = sessions.filter(session => sessionInRange(session, start, end));
    const duration = filtered.reduce((total, session) => total + sessionDuration(session), 0);
    return { count: filtered.length, duration, average: filtered.length ? duration / filtered.length : 0 };
  };
  const dateTimeInput = (timestamp) => {
    const date = new Date(timestamp);
    return `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  function renderGymView() {
    const panel = $('gymPanel');
    const scrollTop = panel.scrollTop;
    const now = nowDate();
    const sessions = gymStore.list();
    const current = activeGymSession();
    const completed = sessions.filter(session => session.endAt !== null).reverse();
    const minute = now.getHours() * 60 + now.getMinutes();
    const openNow = isInside(gymSlots(mondayIndex(now)), minute);
    const periodStart = gymPeriod === 'month'
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : startOfWeek(now);
    const periodEnd = gymPeriod === 'month'
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : addDays(periodStart, 7);
    const previousStart = gymPeriod === 'month'
      ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
      : addDays(periodStart, -7);
    const currentStats = summary(sessions, periodStart, periodEnd);
    const previousStats = summary(sessions, previousStart, periodStart);
    const chartFirst = sessions.length ? startOfWeek(new Date(sessions[0].startAt)) : startOfWeek(now);
    const weeksAvailable = Math.max(1, Math.round((startOfWeek(now) - chartFirst) / 604800000) + 1);
    const weekCount = gymChartWeeks === 0 ? weeksAvailable : gymChartWeeks;
    const thisMonday = startOfWeek(now);
    const chart = Array.from({ length: weekCount }, (_, index) => {
      const start = addDays(thisMonday, (index - weekCount + 1) * 7);
      const end = addDays(start, 7);
      const stats = summary(sessions, start, end);
      const value = gymChartMetric === 'count' ? stats.count
        : Math.round((gymChartMetric === 'average' ? stats.average : stats.duration) / 60000);
      return { label: `${start.getMonth() + 1}/${start.getDate()}`, value };
    });
    const max = Math.max(1, ...chart.map(item => item.value));
    const metricUnit = gymChartMetric === 'count' ? '次' : '分钟';
    const rows = (gymShowAll ? completed : completed.slice(0, 6)).map(session => {
      const start = new Date(session.startAt);
      const end = new Date(session.endAt);
      return `<button class="gym-history-row" type="button" data-session="${escapeHtml(session.id)}">
        <span>${fmtMD.format(start)}${session.endReason === 'closing' ? '<small>自动结束</small>' : ''}</span><span>${minutesToTime(start.getHours() * 60 + start.getMinutes())}–${minutesToTime(end.getHours() * 60 + end.getMinutes())}</span><strong>${formatDuration(sessionDuration(session))}</strong>
      </button>`;
    }).join('');
    panel.innerHTML = `
      <div class="gym-pane-head"><strong>健身记录</strong><span>独立记录实际训练</span></div>
      <section class="gym-section gym-live">
        <div class="gym-section-head">当前状态</div>
        <div class="gym-live-content">
          ${current ? `<strong class="gym-live-title">正在健身</strong><span class="gym-timer">${formatDuration(now.getTime() - current.startAt, true)}</span><span>${minutesToTime(new Date(current.startAt).getHours() * 60 + new Date(current.startAt).getMinutes())} 开始</span>`
            : `<strong class="gym-live-title">${openNow ? '当前未训练' : '当前不在开放时段'}</strong><span>本${gymPeriod === 'week' ? '周' : '月'}已训练 ${currentStats.count} 次 · ${formatDuration(currentStats.duration)}</span>`}
          <button type="button" class="action-button gym-action" data-gym-command="${current ? 'stop' : 'start'}" ${!current && !openNow ? 'disabled' : ''}>${current ? '结束健身' : '开始健身'}</button>
        </div>
      </section>
      <section class="gym-section">
        <div class="gym-section-head">当前周期 <div class="gym-mini-tabs"><button type="button" data-gym-period="week" class="${gymPeriod === 'week' ? 'selected' : ''}">本周</button><button type="button" data-gym-period="month" class="${gymPeriod === 'month' ? 'selected' : ''}">本月</button></div></div>
        <div class="gym-metrics"><div><span>训练次数</span><strong>${currentStats.count} 次</strong></div><div><span>总训练时长</span><strong>${formatDuration(currentStats.duration)}</strong></div><div><span>平均每次</span><strong>${formatDuration(currentStats.average)}</strong></div></div>
        <div class="gym-comparison">较上${gymPeriod === 'week' ? '周' : '月'}：${currentStats.count - previousStats.count >= 0 ? '+' : ''}${currentStats.count - previousStats.count} 次 · ${currentStats.duration - previousStats.duration >= 0 ? '+' : '−'}${formatDuration(Math.abs(currentStats.duration - previousStats.duration))}</div>
      </section>
      <section class="gym-section">
        <div class="gym-section-head">训练趋势</div>
        <div class="gym-chart-controls"><label>范围 <select id="gymChartWeeks"><option value="4" ${gymChartWeeks === 4 ? 'selected' : ''}>4 周</option><option value="12" ${gymChartWeeks === 12 ? 'selected' : ''}>12 周</option><option value="52" ${gymChartWeeks === 52 ? 'selected' : ''}>1 年</option><option value="0" ${gymChartWeeks === 0 ? 'selected' : ''}>全部</option></select></label><label>指标 <select id="gymChartMetric"><option value="duration" ${gymChartMetric === 'duration' ? 'selected' : ''}>总时长</option><option value="count" ${gymChartMetric === 'count' ? 'selected' : ''}>次数</option><option value="average" ${gymChartMetric === 'average' ? 'selected' : ''}>平均时长</option></select></label></div>
        ${sessions.length ? `<div class="gym-chart-scroll"><div class="gym-chart" style="--chart-count:${weekCount}">${chart.map(item => `<div class="gym-chart-column" title="${item.label} 当周：${item.value} ${metricUnit}"><span class="gym-chart-value">${item.value}</span><div class="gym-chart-bar" style="height:${item.value ? Math.max(3, Math.round(item.value / max * 112)) : 0}px"></div><span class="gym-chart-label">${item.label}</span></div>`).join('')}</div></div>` : '<p class="gym-chart-empty">完成第一段训练后，这里会显示每周趋势。</p>'}
        <div class="gym-chart-unit">每周${gymChartMetric === 'count' ? '训练次数' : gymChartMetric === 'average' ? '平均训练时长' : '训练总时长'} · ${metricUnit}</div>
      </section>
      <section class="gym-section">
        <div class="gym-section-head">${gymShowAll ? '全部训练' : '最近训练'} <span>${completed.length} 条已完成</span></div>
        <div class="gym-history-head"><span>日期</span><span>起止</span><span>时长</span></div>
        ${rows || '<p class="gym-empty">还没有训练记录。</p>'}
        ${completed.length > 6 ? `<button class="gym-more" type="button" data-gym-command="toggle-all">${gymShowAll ? '收起记录' : '查看全部'}</button>` : ''}
      </section>
      <div class="gym-data-actions"><button type="button" data-gym-command="export">导出记录</button><button type="button" data-gym-command="import">导入记录</button><input id="gymImportFile" type="file" accept="application/json,.json" hidden /></div>
      <p class="gym-message" role="status">${escapeHtml(gymMessage || (cloud?.connected() ? '训练记录已接入云端，可导出备份。' : '连接云端后可跨设备保存训练记录；本机仍可导出备份。'))}</p>`;
    panel.scrollTop = scrollTop;
  }

  function clearAttentionBadge() {
    if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  }

  function cloudStatus(message) {
    $('cloudStatus').textContent = message;
    $('cloudButton').title = message;
    $('cloudButton').textContent = message === '云端已同步' ? '云端 ✓' : '云端';
  }
  function initCloud() {
    if (!cloud) return;
    cloud.initialize({
      snapshot: () => ({
        sessions: gymStore.list(),
        skips: [...skipped].map(key => Number(key.split(':').pop())).filter(Number.isInteger),
        viewMode
      }),
      apply: state => {
        gymStore.replace(state.sessions);
        skipped = new Set(state.skipDay === dateKey(nowDate()) ? state.skips.map(id => `${state.skipDay}:${id}`) : []);
        writeStorage('neu-schedule-skipped-v7', JSON.stringify([...skipped]));
        if (!new URLSearchParams(location.search).has('view') && ['week', 'day', 'gym'].includes(state.settings?.viewMode))
          viewMode = state.settings.viewMode;
        renderAll();
        schedulePushSync();
      },
      status: cloudStatus
    }).catch(error => cloudStatus(`云端连接失败：${error.message}`));
  }

  function boot() {
    setupInteractions();
    setupPush();
    $('cloudButton').addEventListener('click', () => {
      cloudStatus(cloud?.connected() ? '云端已连接；可手动刷新数据' : '输入配对码连接云端');
      $('cloudDialog').showModal();
    });
    $('closeCloudDialog').addEventListener('click', () => $('cloudDialog').close());
    $('connectCloud').addEventListener('click', async () => {
      try {
        cloudStatus('正在同步…');
        if ($('cloudCode').value.trim()) await cloud.login($('cloudCode').value.trim());
        else if (cloud.connected()) await cloud.sync();
        else throw new Error('请输入配对码');
        $('cloudCode').value = '';
        $('cloudDialog').close();
      } catch (error) { cloudStatus(`云端连接失败：${error.message}`); }
    });
    $('logoutCloud').addEventListener('click', async () => {
      try { await cloud.logout(); }
      catch (_) {}
      finally { location.reload(); }
    });
    renderAll();
    initCloud();
    clearAttentionBadge();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=19', { updateViaCache: 'none' }).then(schedulePushSync).catch(() => {});
    setInterval(() => {
      if (refreshDailyState()) { renderAll(); return; }
      renderHeader();
      if (viewMode === 'week') renderWeekView();
      else if (viewMode === 'day') renderDayView();
      else renderGymView();
    }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearAttentionBadge(); renderAll(); cloud?.sync().catch(() => {}); schedulePushSync(); } });
    window.addEventListener('focus', () => { clearAttentionBadge(); renderAll(); cloud?.sync().catch(() => {}); schedulePushSync(); });
  }

  boot();
})();
