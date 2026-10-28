import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { dispatchDue } from '../src/index.js';
import { ensureDailyReminders, dailyReminders as R } from '../src/daily-reminders.js';

const at = text => Date.parse(text+'+08:00');
const day = '2026-10-28', morning = at(day+'T10:30:00'), meal = at(day+'T14:30:00');
const sha = text => createHash('sha256').update(text).digest('base64url');
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const DB = {prepare(sql) { let args=[]; return {
    bind(...values) {args=values;return this;},
    async first() {return sqlite.prepare(sql).get(...args)||null;},
    async all() {return {results:sqlite.prepare(sql).all(...args)};},
    async run() {return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}
  };}, async batch(commands) {sqlite.exec('BEGIN');try {const out=[];for(const command of commands)out.push(await command.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env = {DB,APP_ORIGIN:'https://app.test',APP_URL:'https://app.test/?view=day'};
  const addDevice = id => sqlite.prepare('INSERT INTO devices(id,token_hash,endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id,sha(id),'https://web.push.apple.com/'+id,'key','auth',Date.now(),Date.now());
  return {sqlite,env,addDevice};
}

test('daily outings use exact Shanghai times with no advance reminder or term boundary', () => {
  const jobs = R.jobs(day);
  assert.deepEqual(jobs.map(v=>v.dueAt),[morning,meal]);
  assert.deepEqual(jobs.map(v=>v.title),['外出训练提醒','外出就餐提醒']);
  assert.equal(jobs.length,2);
  assert.equal(R.dayKey(at('2026-10-29T00:00:00')),'2026-10-29');
  assert.equal(R.jobs('2027-03-21').length,2,'weekends and dates after the semester retain the same reminders');
});

test('Cron seeds all subscribed devices idempotently and preserves sent state', async () => {
  const {sqlite,env,addDevice} = setup();
  await ensureDailyReminders(env,morning);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM reminders').get().n,0);
  addDevice('first');addDevice('second');
  await ensureDailyReminders(env,morning);await ensureDailyReminders(env,morning+60000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM reminders').get().n,4);
  sqlite.prepare('UPDATE reminders SET sent_at=? WHERE device_id=? AND reminder_id=?').run(morning,'first',R.jobs(day)[0].id);
  await ensureDailyReminders(env,morning+120000);
  assert.equal(sqlite.prepare('SELECT sent_at FROM reminders WHERE device_id=? AND reminder_id=?').get('first',R.jobs(day)[0].id).sent_at,morning);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,0,'ticks do not create agenda items');
  sqlite.close();
});

test('old client plan sync cannot delete or replace server-owned outing reminders', async () => {
  const {sqlite,env,addDevice} = setup(), now=Date.now(), session='s'.repeat(43), device='d'.repeat(43);
  addDevice(device);await ensureDailyReminders(env,now);
  sqlite.prepare('INSERT INTO auth_credential VALUES(1,?,?,0,?,?)').run('credential','key','[]',now);
  sqlite.prepare('INSERT INTO auth_sessions VALUES(?,1,?,?)').run(sha(session),now,now+86400000);
  const real = R.jobs(R.dayKey(now))[0];
  const response = await worker.fetch(new Request(env.APP_ORIGIN+'/sync',{method:'POST',headers:{origin:env.APP_ORIGIN,cookie:'__Host-neu_session='+session,authorization:'Bearer '+device,'content-type':'application/json'},
    body:JSON.stringify({jobs:[{id:'client-job',dueAt:now+60000,title:'课程',body:'地点',ttl:600},{...real,dueAt:now+120000,title:'覆盖尝试'}]})}),env);
  assert.equal(response.status,200);assert.equal((await response.json()).count,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM reminders').get().n,3);
  const preserved = sqlite.prepare('SELECT title,due_at FROM reminders WHERE reminder_id=?').get(real.id);
  assert.equal(preserved.title,real.title);assert.equal(preserved.due_at,real.dueAt);
  sqlite.close();
});

test('outings send only at their own times, once per day, despite agenda occupancy', async () => {
  const {sqlite,env,addDevice} = setup();addDevice('device');await ensureDailyReminders(env,morning);
  const deliveries=[],send=async(row,title,body,ttl)=>{deliveries.push({id:row.reminder_id,title,body,ttl});return true;};
  sqlite.prepare('INSERT INTO agenda_items(id,kind,title,anchor_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('busy','activity','全天占用',morning-3600000,morning,morning);
  await dispatchDue(env,morning-1,send);assert.equal(deliveries.length,0);
  await dispatchDue(env,morning,send);await dispatchDue(env,morning+60000,send);assert.equal(deliveries.length,1);
  assert.equal(deliveries[0].title,'外出训练提醒');
  await dispatchDue(env,meal-1,send);assert.equal(deliveries.length,1);
  await dispatchDue(env,meal,send);await dispatchDue(env,meal+60000,send);assert.equal(deliveries.length,2);
  assert.equal(deliveries[1].title,'外出就餐提醒');
  const tomorrow=morning+86400000;await ensureDailyReminders(env,tomorrow);await dispatchDue(env,tomorrow,send);
  assert.equal(deliveries.length,3);assert.notEqual(deliveries[0].id,deliveries[2].id);
  sqlite.close();
});

test('late or missed outing notices expire rather than backfilling stale reminders', async () => {
  const {sqlite,env,addDevice} = setup();addDevice('device');await ensureDailyReminders(env,morning);
  const calls=[],send=async(_row,_title,_body,ttl)=>{calls.push(ttl);return true;};
  await dispatchDue(env,morning+60000,send);assert.deepEqual(calls,[60],'provider TTL ends two minutes after the scheduled time');
  await dispatchDue(env,meal+R.MAX_LATENESS,send);assert.equal(calls.length,1);
  sqlite.close();
});
