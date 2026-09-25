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
  const gymVersion = day => day % 2 ? 'gym-odd' : 'gym-even';
  const skipKey = (date, course) => `${dateKey(date)}:${course._id}`;
  let skipped;
  try { skipped = new Set(JSON.parse(localStorage.getItem('neu-schedule-skipped-v7') || '[]')); }
  catch (_) { skipped = new Set(); }
  let gymSessionDate = '';
  try { gymSessionDate = localStorage.getItem('neu-schedule-gym-session-v7') || ''; } catch (_) {}

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
  function activeCourses(day, week) {
    const date = addDays(weekStart(week), day - 1);
    return rawCourses(day, week).filter(course => !skipped.has(skipKey(date, course)));
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
  let viewMode = readStorage('neu-schedule-view-mode') === 'day' ? 'day' : 'week';
  let timelineScrollTop = null;
  let firstTimelineRender = true;
  let dayFocus = true;

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
        dayFocus = true;
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
    const pieces = ['<div class="corner-head"><span>节次·时间</span></div>'];

    for (let day = 1; day <= 7; day++) {
      const date = addDays(weekMonday, day - 1);
      pieces.push(`<button class="day-head ${day === selectedDay ? 'selected' : ''} ${dateKey(date) === todayKey ? 'today' : ''}" style="grid-column:${day + 1};grid-row:1" data-day="${day}" type="button">
        <strong>周${weekdayNames[day]}</strong><span>${date.getMonth() + 1}/${date.getDate()}</span>
      </button>`);
    }

    pieces.push('<div class="time-axis" style="grid-column:1;grid-row:2">');
    for (let period = 1; period <= 12; period++) {
      const start = timeToMinutes(D.periods[period][0]);
      const end = timeToMinutes(D.periods[period][1]);
      pieces.push(`<div class="period-slot" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%"><strong>${period}节</strong><span>${D.periods[period][0]}</span><span>${D.periods[period][1]}</span></div>`);
    }
    for (const boundary of gymBoundaries) {
      if (boundary <= DAY_START || boundary >= DAY_END || academicBoundaries.has(boundary)) continue;
      pieces.push(`<div class="gym-time-tag aux" style="top:${pct(boundary)}%">${minutesToTime(boundary)}</div>`);
    }
    pieces.push('</div>');

    for (let day = 1; day <= 7; day++) {
      pieces.push(`<div class="day-lane ${gymVersion(day)} ${day === selectedDay ? 'selected-col' : ''}" style="grid-column:${day + 1};grid-row:2" data-day="${day}">`);

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
          <span class="course-period">第${course.start}–${course.end}节</span>
          <span class="course-time">${time.start}–${time.end}</span>
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
        const contentHeight = $('timelineGrid').getBoundingClientRect().height - 52;
        const target = (pct(focusMinutes) / 100) * contentHeight - scroll.clientHeight * 0.32;
        scroll.scrollTop = Math.max(0, target);
        firstTimelineRender = false;
      } else if (timelineScrollTop != null) {
        scroll.scrollTop = timelineScrollTop;
      }
    });
  }

  function persistSkipped() { writeStorage('neu-schedule-skipped-v7', JSON.stringify([...skipped])); }
  function startGymSession() {
    const minute = nowDate().getHours() * 60 + nowDate().getMinutes();
    const slot = gymSlots(selectedDay).find(([start, end]) => start <= minute && minute < end);
    gymSessionDate = slot ? `${dateKey(selectedDate())}|${slot[1]}` : '';
    writeStorage('neu-schedule-gym-session-v7', gymSessionDate);
  }
  function skipCourse(course, gym = false) {
    skipped.add(skipKey(selectedDate(), course));
    persistSkipped();
    if (gym) startGymSession();
    renderAll();
  }
  function dayState(date, courses) {
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
    const gymActive = gymSessionDate.startsWith(`${dateKey(date)}|`) && minute < Number(gymSessionDate.split('|')[1]) && openNow;
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
    if (gymActive) notices.push({ kind: 'gym', text: '正在健身' });
    else if (freeNow) notices.push({ kind: 'gym', text: '健身房开放，现在可以去' });
    const nextFree = free.find(([start]) => start > minute && start - minute <= 30);
    if (nextFree) {
      const physicalOpening = open.some(([start]) => start === nextFree[0]);
      notices.push({ kind: 'soon', text: `${nextFree[0] - minute} 分钟后${physicalOpening ? '健身房开放' : '可以去健身'}` });
    }
    const closing = open.find(([start, end]) => start <= minute && minute < end && end - minute <= 30);
    if (closing) notices.push({ kind: 'soon', text: `健身房 ${closing[1] - minute} 分钟后关闭` });
    let actions = '';
    if (freeNow) actions += `<button type="button" class="action-button gym-action" data-action="${gymActive ? 'end-gym' : 'start-gym'}">${gymActive ? '结束健身' : '开始健身'}</button>`;
    for (const course of [ongoing, ...soon].filter(Boolean)) {
      const t = periodTime(course);
      const start = timeToMinutes(t.start), end = timeToMinutes(t.end);
      const overlap = open.some(([a, b]) => start < b && end > a);
      actions += `<button type="button" class="action-button skip-action" data-skip="${course._id}" data-gym="${overlap && openNow ? 'yes' : 'no'}">${overlap && openNow ? '翘课去健身' : `翘掉${shortCourseName(course.name, course.end - course.start + 1)}`}</button>`;
    }
    const title = ongoing ? `正在上 ${shortCourseName(ongoing.name, ongoing.end - ongoing.start + 1)}` : gymActive ? '正在健身' : freeNow ? '现在可以去健身' : '当前没有安排';
    return { live, minute, title, subtitle: `${minutesToTime(minute)} · ${notices.length ? '当前与即将发生' : '看看今天的时间图'}`, notices, actions };
  }
  function renderDayView() {
    const date = selectedDate();
    const courses = activeCourses(selectedDay, selectedWeek);
    const state = dayState(date, courses);
    const now = nowDate();
    const hourAngle = (now.getHours() % 12 + now.getMinutes() / 60) * 30;
    const minuteAngle = now.getMinutes() * 6;
    const skipCount = rawCourses(selectedDay, selectedWeek).filter(course => skipped.has(skipKey(date, course))).length;
    $('dayDashboard').innerHTML = `
      <div class="dashboard-date"><strong>${weekdayLong[selectedDay]} · ${fmtMD.format(date)}</strong><span>第 ${selectedWeek} 周 · ${courses.length} 段课程</span></div>
      <div class="now-row">
        <div class="clock" aria-label="当前时间 ${minutesToTime(now.getHours() * 60 + now.getMinutes())}"><i class="hand hour" style="--rotation:${hourAngle}deg"></i><i class="hand minute" style="--rotation:${minuteAngle}deg"></i><i class="clock-center"></i></div>
        <div class="now-text"><span class="clock-digital">${minutesToTime(now.getHours() * 60 + now.getMinutes())}</span><h2>${escapeHtml(state.title)}</h2><p>${escapeHtml(state.subtitle)}</p></div>
      </div>
      ${state.notices.length ? `<div class="event-notices">${state.notices.map(n => `<div class="event-notice ${n.kind}"><span class="notice-dot"></span><span>${escapeHtml(n.text)}</span>${n.note ? `<small>${escapeHtml(n.note)}</small>` : ''}</div>`).join('')}</div>` : ''}
      ${state.actions ? `<div class="dashboard-actions">${state.actions}</div>` : ''}
      ${skipCount ? `<button type="button" class="undo-trigger" id="undoTrigger">已跳过 ${skipCount} 节 · 撤销</button>` : ''}`;
    const parts = ['<div class="map-heading"><strong>当日时间图</strong><span>07:00–22:00 · 课程与健身房</span></div><div class="day-map-inner"><div class="map-axis">'];
    for (let n = 1; n <= 12; n++) {
      const [start, end] = D.periods[n];
      parts.push(`<div class="map-period" style="top:${pct(timeToMinutes(start))}%"><strong>${n}节</strong><span>${start}–${end}</span></div>`);
    }
    parts.push('</div>');
    parts.push(`<div class="map-track ${gymVersion(selectedDay)}">`);
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
      parts.push(`<button type="button" class="map-course" data-course="${course._id}" style="top:${pct(start)}%;height:${pct(end) - pct(start)}%;--course-color:${course._color}">
        <strong>${escapeHtml(course.name)}</strong><span>第${course.start}–${course.end}节 · ${t.start}–${t.end}</span><span>${escapeHtml(course.location)}${course.note ? ` · ${escapeHtml(course.note)}` : ''}</span>
      </button>`);
    }
    if (state.live && state.minute >= DAY_START && state.minute <= DAY_END)
      parts.push(`<div class="day-progress" style="height:${pct(state.minute)}%"></div><div class="day-now-line" style="top:${pct(state.minute)}%"><span>${minutesToTime(state.minute)}</span></div>`);
    parts.push('</div></div>');
    $('dayMap').innerHTML = parts.join('');
    if (dayFocus) requestAnimationFrame(() => {
      const panel = $('dayMap');
      const focus = state.live && state.minute >= DAY_START && state.minute <= DAY_END ? pct(state.minute) / 100 * 900 : 0;
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
      $('courseDialog').close();
      skipCourse(course);
    });
    $('dayMap').addEventListener('click', event => {
      const button = event.target.closest('[data-course]');
      if (button) openCourse(Number(button.dataset.course));
    });
    $('dayDashboard').addEventListener('click', event => {
      const skip = event.target.closest('[data-skip]');
      if (skip) {
        skipCourse(D.courses[Number(skip.dataset.skip)], skip.dataset.gym === 'yes');
        return;
      }
      const action = event.target.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'start-gym') startGymSession();
        else {
          gymSessionDate = '';
          writeStorage('neu-schedule-gym-session-v7', gymSessionDate);
        }
        renderAll();
        return;
      }
      const trigger = event.target.closest('#undoTrigger');
      if (trigger) {
        const hidden = rawCourses(selectedDay, selectedWeek).filter(course => skipped.has(skipKey(selectedDate(), course)));
        trigger.outerHTML = `<div class="undo-choices">${hidden.map(course => `<button type="button" data-undo="${course._id}">撤销第${course.start}–${course.end}节跳过</button>`).join('')}</div>`;
        return;
      }
      const undo = event.target.closest('[data-undo]');
      if (undo) {
        const course = D.courses[Number(undo.dataset.undo)];
        if (course) {
          skipped.delete(skipKey(selectedDate(), course));
          persistSkipped();
          renderAll();
        }
      }
    });

    document.querySelectorAll('.segment').forEach(button => {
      button.addEventListener('click', () => {
        viewMode = button.dataset.mode;
        dayFocus = true;
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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js?v=7', { updateViaCache: 'none' }).catch(() => {});
    setInterval(() => {
      renderHeader();
      if (viewMode === 'week') renderWeekView();
      else renderDayView();
    }, 60000);
  }

  boot();
})();
