import test from 'node:test';
import assert from 'node:assert/strict';
import { baseCoursesOn, validateCalendar } from '../src/calendar.js';
import worker from '../src/index.js';

const schedule = {
  semester: { week1Monday: '2026-08-31', totalWeeks: 4 },
  courses: [
    { weekday: 1, weeks: '1-4', name: '周一课程' },
    { weekday: 3, weeks: '2、4', name: '隔周课程' }
  ]
};

test('source lessons move to an originally blank target day across weeks', () => {
  const value = validateCalendar({
    holidays: ['2026-09-07'],
    makeups: [{ target: '2026-09-06', source: '2026-09-07' }]
  }, schedule);
  assert.deepEqual(value, { holidays: ['2026-09-07'], makeups: [{ target: '2026-09-06', source: '2026-09-07' }] });
  assert.equal(baseCoursesOn('2026-09-07', schedule).length, 1);
  assert.equal(baseCoursesOn('2026-09-06', schedule).length, 0);
  assert.equal(baseCoursesOn('2026-09-09', schedule).length, 1);
});

test('calendar rules reject conflicting or imaginary adjustments', () => {
  const makeup = { target: '2026-09-06', source: '2026-09-07' };
  const validate = (holidays, makeups) => validateCalendar({ holidays, makeups }, schedule);
  assert.throws(() => validate(['2026-09-06'], [makeup]), /目标日已放假/);
  assert.throws(() => validate([], [makeup, { target: '2026-09-13', source: '2026-09-07' }]), /日期已被占用/);
  assert.throws(() => validate([], [{ target: '2026-09-07', source: '2026-09-09' }]), /目标日原本有课程/);
  assert.throws(() => validate([], [{ target: '2026-09-06', source: '2026-09-08' }]), /来源日没有/);
  assert.throws(() => validate(['2026-02-30'], []), /放假日期/);
  assert.throws(() => validate(['2026-10-02'], []), /放假日期/);
});

test('calendar API requires login and rejects stale edits', async () => {
  const state = { content: JSON.stringify({ holidays: [], makeups: [] }), revision: 1, updated_at: 0 };
  let clearedDates = [];
  const db = {
    async batch(commands) { for (const command of commands) await command.run(); },
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes('FROM auth_sessions')) return { token_hash: 'valid-session' };
          if (sql.includes('FROM schedule_data')) return { content: JSON.stringify(schedule) };
          if (sql.includes('FROM calendar_overrides')) return state;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          if (sql.includes('DELETE FROM reminders')) { clearedDates = JSON.parse(args[0]); return { meta: { changes: 0 } }; }
          if (sql.includes('UPDATE devices SET plan_hash')) return { meta: { changes: 1 } };
          if (!sql.includes('UPDATE calendar_overrides')) throw new Error(`Unexpected update: ${sql}`);
          if (args[2] !== state.revision) return { meta: { changes: 0 } };
          state.content = args[0]; state.updated_at = args[1]; state.revision++;
          return { meta: { changes: 1 } };
        }
      };
    }
  };
  const env = { APP_ORIGIN: 'https://schedule.example', DB: db };
  const payload = { holidays: ['2026-09-07'], makeups: [{ target: '2026-09-06', source: '2026-09-07' }], revision: 1 };
  const request = (login, body = payload) => new Request('https://schedule.example/calendar', {
    method: 'POST', headers: { origin: env.APP_ORIGIN, 'content-type': 'application/json', ...(login ? { cookie: `__Host-neu_session=${'s'.repeat(43)}` } : {}) },
    body: JSON.stringify(body)
  });
  assert.equal((await worker.fetch(request(false), env)).status, 401);
  const saved = await worker.fetch(request(true), env);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 2);
  assert.deepEqual(new Set(clearedDates), new Set(['2026-09-06', '2026-09-07']));
  assert.equal((await worker.fetch(request(true), env)).status, 409);
  const invalid = await worker.fetch(request(true, { ...payload, revision: 2, makeups: [{ target: '2026-09-07', source: '2026-09-09' }] }), env);
  assert.equal(invalid.status, 400);
  assert.equal(state.revision, 2);
  const restored = await worker.fetch(request(true, { holidays: [], makeups: [], revision: 2 }), env);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).revision, 3);
  assert.deepEqual(new Set(clearedDates), new Set(['2026-09-06', '2026-09-07']), 'undo clears reminders on both affected dates');
});
