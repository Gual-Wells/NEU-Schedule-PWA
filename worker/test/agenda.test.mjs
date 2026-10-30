import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';
import { dispatchDigests, cleanupAgenda, agendaBlocksGym, digestNotice } from '../src/agenda.js';

const A=globalThis.ScheduleAgenda, now=Date.now(), sha=value=>createHash('sha256').update(value).digest('base64url');
const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const batchManifest=(nonce='batch-1',count=2)=>({protocol:2,nonce,note:'这些图片属于同一事项',images:Array.from({length:count},(_,i)=>{
  const bytes=Buffer.concat([imageBytes,Buffer.from([i])]);
  return {id:nonce+'-image-'+i,mime:'image/png',byteLength:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')};
})});
function setup() {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(v=>v.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(sql){let args=[];return {bind(...v){args=v.map(x=>x instanceof ArrayBuffer?new Uint8Array(x):x);return this;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};},async batch(commands){sqlite.exec('BEGIN');try{const out=[];for(const c of commands)out.push(await c.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const token='a'.repeat(43), env={DB,APP_ORIGIN:'https://app.test',APP_URL:'https://app.test/?view=day',AGENDA_RUNNER_KEY:'r'.repeat(43)};
  sqlite.prepare('INSERT INTO auth_credential VALUES(1,?,?,0,?,?)').run('credential','key','[]',now);
  sqlite.prepare('INSERT INTO auth_sessions VALUES(?,1,?,?)').run(sha(token),now,now+A.DAY);
  const call=async(path,value,runner=false,claim=null)=>{
    const headers=runner?{authorization:'Bearer '+env.AGENDA_RUNNER_KEY}:{origin:env.APP_ORIGIN,cookie:'__Host-neu_session='+token};
    if(claim)headers['x-agenda-claim']=claim;
    let body;if(value!==undefined){body=typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value);headers['content-type']='application/json';}
    return worker.fetch(new Request(env.APP_ORIGIN+path,{method:value===undefined?'GET':'POST',headers,body}),env);
  };
  return {sqlite,env,call};
}
const generated=(title='提交论文',time='2026-11-01T12:00',question='')=>({summary:'按申请上下文选定论文提交，忽略旁边的讲座通知',items:[{key:'task',kind:'deadline',title,localTime:time,localEnd:null,location:'',evidence:'论文于11月1日12点截止',question,dateStart:null,dateEnd:null,inference:'',sourceImages:[1]}]});
async function singleJob(call,nonce='single') {
  const created=await (await call('/imports?nonce='+nonce,imageBytes)).json();
  const job=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal(job.id,created.id);return job;
}
const relation=(applicationId,itemId=null)=>({type:'update',targetImportId:applicationId,targetItemId:itemId,reason:'同一投票事项的补充通知，保留未变更信息'});
const allDay=(kind='deadline',date='2026-10-20')=>({summary:'按通知日期全天预留',items:[{...generated().items[0],kind,title:'医保办理',localTime:null,dateStart:date,dateEnd:date,inference:'原文仅写10.20之前，按10月20日全天预留'}]});

test('calendar estimates remain finite while unresolved gym occupancy stays open',()=>{
  const start=A.localTime('2026-10-23T14:00'),v=A.normalizeItem({kind:'activity',title:'组会',anchorAt:start},start);
  assert.deepEqual(A.displayInterval(v),[start,start+3*A.HOUR]);
  assert.equal(A.busyInterval(v,start+A.HOUR)[1],Infinity);
  assert.deepEqual(A.displayInterval(v),[start,start+3*A.HOUR],'passing time does not rewrite the estimate');
  assert.deepEqual(A.displayInterval({...v,explicitEndAt:start+2*A.HOUR}),[start,start+2*A.HOUR]);
  assert.deepEqual(A.displayInterval({...v,kind:'deadline'}),[start-3*A.HOUR,start]);
  assert.equal(A.displayInterval({...v,cancelledAt:start-1}),null);
  assert.deepEqual(A.displayInterval({...v,resolvedAt:start+26*A.HOUR}),[start,start+26*A.HOUR],'actual cross-day completion remains visible');
  const dateRange=A.generatedItem({...allDay('activity').items[0],dateEnd:'2026-10-22'});
  assert.deepEqual(A.displayInterval(dateRange),[A.dateTime('2026-10-20'),A.dateTime('2026-10-23')]);
  const m={startAt:start,endAt:null,confirmedAt:null};
  assert.deepEqual(A.meetingDisplayInterval(m),[start,start+5*A.HOUR]);
  assert.equal(A.meetingInterval(m,start+6*A.HOUR)[1],Infinity);
  assert.deepEqual(A.meetingDisplayInterval({...m,confirmedAt:start+7*A.HOUR,endAt:start+5*A.HOUR}),[start,start+7*A.HOUR]);
});

test('date-only activities and deadlines cover whole campus days, preserve precision and block gym',async()=>{
  const date='2026-10-20',[start,end]=A.dayRange(date);
  for(const kind of ['activity','deadline']){
    const v=A.generatedItem(allDay(kind).items[0]);
    assert.deepEqual(A.windows(v),{from:start,coreFrom:start,coreTo:end,to:end});
    assert.equal(A.timeLabel(v),'2026-10-20 全天');
    assert.equal(A.busyInterval(v,start+12*A.HOUR)[1],Infinity);
    assert.equal(A.busyInterval({...v,resolvedAt:start+12*A.HOUR},end)[1],start+12*A.HOUR);
    assert.throws(()=>A.generatedItem({...allDay(kind).items[0],dateStart:'2026-02-30'}));
  }
  const {call,env}=setup(),job=await singleJob(call);
  assert.equal((await call('/runner/result/'+job.id,allDay(),true,job.claim)).status,200);
  const review=await (await call('/imports/'+job.id)).json();
  const applied=await (await call('/agenda/commit',{id:'all-day',type:'apply',importId:job.id,revision:review.revision})).json();
  assert.equal(applied.items[0].dateStart,date);assert.equal(applied.items[0].anchorAt,end);
  assert.equal(await agendaBlocksGym(env,start+6*A.HOUR,start+7*A.HOUR,start-1),true);
  assert.match(A.digestText(A.digest(applied.items,[],start-A.HOUR)),/2026-10-20 全天/);
});

test('explicit image analysis is durable, cannot enter the agenda, and can be revised into a real application',async()=>{
 const {call,sqlite}=setup(),job=await singleJob(call,'analysis');
 const report={intent:'analysis',analysis:'图1：10月30日有两项个人活动。\n\n12:30 外出训练；16:30 外出就餐。',summary:'测试图片解读',items:[],relation:{type:'new',targetImportId:null,targetItemId:null,reason:'仅解读'}};
 for(const invalid of [{...report,items:generated().items},{...report,analysis:''},{...generated(),intent:'agenda',analysis:'',items:[]}])assert.equal((await call('/runner/result/'+job.id,invalid,true,job.claim)).status,400);
 assert.equal((await call('/runner/result/'+job.id,report,true,job.claim)).status,200);
 const review=await (await call('/imports/'+job.id)).json();
 assert.equal(review.result.analysis,report.analysis);assert.equal(review.result.intent,'analysis');
 assert.equal((await call('/agenda/commit',{id:'cannot-apply-analysis',type:'apply',importId:job.id,revision:review.revision})).status,409);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_result_versions WHERE import_id=?').get(job.id).n,1);
 const next=await singleJob(call,'after-analysis');
 assert(!next.knownApplications.some(v=>v.applicationId===job.id),'read-only reports are not agenda matching candidates');
 await call('/runner/result/'+next.id,generated(),true,next.claim);
 const feedback=await call('/imports/'+job.id+'/feedback',{id:'analysis-to-agenda',revision:review.revision,text:'现在把16:30外出就餐作为事项安排'});
 assert.equal(feedback.status,200);
 const retry=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
 assert.equal(retry.id,job.id);assert.equal(retry.generation,2);assert.equal(retry.previousResult.intent,'analysis');
 assert.equal((await call('/runner/result/'+retry.id,{...generated(),intent:'agenda',analysis:''},true,retry.claim)).status,200);
 const ready=await (await call('/imports/'+job.id)).json();
 const applied=await (await call('/agenda/commit',{id:'apply-after-feedback',type:'apply',importId:job.id,revision:ready.revision})).json();
 assert.equal(applied.items.length,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_result_versions WHERE import_id=?').get(job.id).n,2);
});

test('new uploads can complete an earlier unconfirmed application, then update the same item',async()=>{
  const {call,sqlite}=setup(),original=await singleJob(call,'original');
  await call('/runner/result/'+original.id,allDay('activity'),true,original.claim);
  const earlier=await (await call('/imports/'+original.id)).json();
  const extra=await singleJob(call,'extra');
  assert(extra.knownApplications.some(v=>v.applicationId===original.id));
  const result={...generated('人大代表投票','2026-10-20T14:50'),relation:relation(original.id)};
  result.items[0].kind='activity';result.items[0].localEnd='2026-10-20T15:40';result.items[0].location='信息B520';
  assert.equal((await call('/runner/result/'+extra.id,result,true,extra.claim)).status,200);
  let review=await (await call('/imports/'+extra.id)).json();
  const applied=await (await call('/agenda/commit',{id:'complete-original',type:'apply',importId:extra.id,revision:review.revision})).json();
  assert.equal(applied.items.length,1);const id=applied.items[0].id;
  assert.equal((await call('/agenda/commit',{id:'stale-original',type:'apply',importId:original.id,revision:earlier.revision})).status,409);
  assert.deepEqual((await (await call('/imports/'+original.id)).json()).linkedItemIds,[id]);
  const followup=await singleJob(call,'followup');
  assert.equal(followup.knownApplications.find(v=>v.applicationId===original.id).item.id,id);
  const changed={...result,relation:relation(original.id,id),items:[{...result.items[0],title:'人大代表投票（携带身份证和黑色笔）'}]};
  await call('/runner/result/'+followup.id,changed,true,followup.claim);
  review=await (await call('/imports/'+followup.id)).json();
  const updated=await (await call('/agenda/commit',{id:'append-requirements',type:'apply',importId:followup.id,revision:review.revision})).json();
  assert.equal(updated.items.length,1);assert.equal(updated.items[0].id,id);
  assert.equal(updated.items[0].dateStart,null);assert.equal(updated.items[0].location,'信息B520');
  assert.equal(updated.items[0].sources.length,3,'original and both follow-up source bundles remain accessible');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_application_items').get().n,1);
});

test('follow-up targets are limited to the recognition snapshot and stale targets cannot be overwritten',async()=>{
  const {call,sqlite}=setup(),original=await singleJob(call,'base');
  await call('/runner/result/'+original.id,allDay(),true,original.claim);
  const next=await singleJob(call,'update');
  const result={...allDay(),relation:relation(original.id)};
  assert.equal((await call('/runner/result/'+next.id,{...result,relation:relation('invented-id')},true,next.claim)).status,400);
  assert.equal((await call('/runner/result/'+next.id,result,true,next.claim)).status,200);
  let originalReview=await (await call('/imports/'+original.id)).json();
  await call('/imports/'+original.id+'/feedback',{id:'change-source',revision:originalReview.revision,text:'已有申请又补充了时间'});
  const reviewed=await (await call('/imports/'+next.id)).json();
  assert.equal((await call('/agenda/commit',{id:'stale-context',type:'apply',importId:next.id,revision:reviewed.revision})).status,409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,0);
  assert.equal((await (await call('/runner/claim',{protocol:3},true)).json()).job,null,'older runner cannot claim flexible-date requests');
});

test('half-column layout redistributes widths at each overlap boundary without hiding any entry',()=>{
  const groups=A.layout([{key:'all-day',from:0,to:24},{key:'one',from:10,to:12},{key:'two',from:11,to:13},{key:'next-day',from:24,to:25}]);
  assert.equal(groups.length,2);
  for(const [from,to,n]of [[0,10,1],[10,11,2],[11,12,3],[12,13,2],[13,24,1]]){
    const active=groups[0].slices.filter(v=>v.from===from&&v.to===to);
    assert.equal(active.length,n);assert.equal(active.reduce((sum,v)=>sum+v.width,0),1);
    active.forEach((v,i)=>{assert.equal(v.left,i/n);assert.equal(v.width,1/n);assert(v.left+v.width<=1);});
  }
});

test('one application enforces one immutable generated item across protocol boundaries',async()=>{
  const {call,sqlite}=setup(),job=await singleJob(call);
  assert.equal(job.extractionProtocol,4);
  const value=generated();
  for(const items of [[],[value.items[0],{...value.items[0],key:'other'}]])assert.equal((await call('/runner/result/'+job.id,{...value,items},true,job.claim)).status,400);
  assert.equal((await call('/runner/result/'+job.id,value,true,job.claim)).status,200);
  const review=await (await call('/imports/'+job.id)).json();
  const op={id:'immutable',type:'apply',importId:job.id,revision:review.revision};
  assert.equal((await call('/agenda/commit',{...op,items:[{key:'task',title:'恶意改写'}]})).status,400);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal(sqlite.prepare('SELECT title FROM agenda_items').get().title,value.items[0].title);
  assert.throws(()=>sqlite.prepare("INSERT INTO agenda_items(id,kind,title,anchor_at,source_import_id,source_item_key,created_at,updated_at) VALUES('duplicate','deadline','duplicate',?,?,?,1,1)").run(now,job.id,'different-key'),/one_item_per_application/);
  const queued=await (await call('/imports?nonce=new-capability',imageBytes)).json();
  assert(queued.id);
  assert.equal((await (await call('/runner/claim',{protocol:2},true)).json()).job,null,'old runners cannot claim new applications');
});

test('feedback versions the same application; retries and stale workers cannot overwrite revisions',async()=>{
  const {call,sqlite}=setup(),job=await singleJob(call),result=generated('待确认论文',null,'哪一天的通知？');
  await call('/runner/result/'+job.id,result,true,job.claim);
  let review=await (await call('/imports/'+job.id)).json();
  assert.equal((await call('/agenda/commit',{id:'incomplete',type:'apply',importId:job.id,revision:review.revision})).status,409);
  const value={id:'feedback-1',revision:review.revision,text:'通知日期为10月18日，论文截止11月1日12点，讲座无关'};
  assert.equal((await call('/imports/'+job.id+'/feedback',value)).status,200);
  assert.equal((await call('/imports/'+job.id+'/feedback',value)).status,200);
  assert.equal((await call('/imports/'+job.id+'/feedback',{...value,text:'different'})).status,409);
  assert.equal((await call('/agenda/commit',{id:'stale',type:'apply',importId:job.id,revision:review.revision})).status,409);
  const next=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal(next.id,job.id);assert.equal(next.generation,job.generation+1);
  assert.deepEqual(next.previousResult,result);assert.equal(next.feedback.length,1);
  assert.equal((await call('/runner/result/'+job.id,generated('旧回传'),true,job.claim)).status,409);
  review=await (await call('/imports/'+job.id)).json();
  await call('/imports/'+job.id+'/feedback',{id:'feedback-2',revision:review.revision,text:'标题使用最终论文提交'});
  assert.equal((await call('/runner/result/'+job.id,generated('已作废修订'),true,next.claim)).status,409);
  const final=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  await call('/runner/result/'+job.id,generated('最终论文提交'),true,final.claim);
  review=await (await call('/imports/'+job.id)).json();
  assert.equal(review.result.items.length,1);assert.equal(review.feedback.length,2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_result_versions').get().n,2);
  assert.equal((await call('/agenda/commit',{id:'final',type:'apply',importId:job.id,revision:review.revision})).status,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,1);
});

test('revision after apply keeps the item and occupancy until confirmed; expired sources stay expired',async()=>{
  const {call,sqlite,env}=setup(),job=await singleJob(call);
  await call('/runner/result/'+job.id,generated('原安排'),true,job.claim);
  let review=await (await call('/imports/'+job.id)).json();
  await call('/agenda/commit',{id:'first',type:'apply',importId:job.id,revision:review.revision});
  const before=sqlite.prepare('SELECT * FROM agenda_items').get();
  sqlite.prepare('UPDATE agenda_imports SET expires_at=? WHERE id=?').run(now-1,job.id);
  await cleanupAgenda(env,now);
  review=await (await call('/imports/'+job.id)).json();
  await call('/imports/'+job.id+'/feedback',{id:'after-apply',revision:review.revision,text:'改为最终论文提交，截止11月2日12点'});
  await cleanupAgenda(env,now);
  assert.equal(sqlite.prepare('SELECT title FROM agenda_items').get().title,'原安排');
  assert.equal((await call('/imports/'+job.id+'/cancel',{})).status,409);
  const next=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal(next.images.length,0);assert.equal(next.sourceCount,1);
  assert.equal((await call('/imports/'+job.id+'/source/1')).status,410);
  await call('/runner/result/'+job.id,generated('最终论文提交','2026-11-02T12:00'),true,next.claim);
  review=await (await call('/imports/'+job.id)).json();
  const apply={id:'replace',type:'apply',importId:job.id,revision:review.revision};
  assert.equal((await call('/agenda/commit',apply)).status,200);
  assert.equal((await call('/agenda/commit',apply)).status,200);
  const after=sqlite.prepare('SELECT * FROM agenda_items').all();
  assert.equal(after.length,1);assert.equal(after[0].id,before.id);assert.equal(after[0].title,'最终论文提交');
  await call('/agenda/commit',{id:'finish',type:'resolve',itemId:before.id,at:now});
  review=await (await call('/imports/'+job.id)).json();
  assert.equal((await call('/imports/'+job.id+'/feedback',{id:'no-reopen',revision:review.revision,text:'再安排一次'})).status,409);
});

test('legacy multi-output reviews require feedback before a single item can be confirmed',async()=>{
  const {call,sqlite}=setup(),job=await singleJob(call),value=generated();
  sqlite.prepare('UPDATE agenda_imports SET extraction_protocol=2 WHERE id=?').run(job.id);
  const old={...value,items:[...value.items,{...value.items[0],key:'lecture',title:'干扰讲座'}]};
  assert.equal((await call('/runner/result/'+job.id,old,true,job.claim)).status,200);
  let review=await (await call('/imports/'+job.id)).json();
  assert.equal((await call('/agenda/commit',{id:'old-multi',type:'apply',importId:job.id,revision:review.revision})).status,400);
  assert.equal((await call('/imports/'+job.id+'/feedback',{id:'select-target',revision:review.revision,text:'只安排论文提交'})).status,200);
  const next=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal(next.extractionProtocol,4);
  await call('/runner/result/'+job.id,value,true,next.claim);
  review=await (await call('/imports/'+job.id)).json();
  assert.equal((await call('/agenda/commit',{id:'single-now',type:'apply',importId:job.id,revision:review.revision})).status,200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,1);
});

test('completion racing with a reviewed rewrite wins without resurrecting or duplicating the item',async()=>{
  const {call,sqlite,env}=setup(),job=await singleJob(call);
  await call('/runner/result/'+job.id,generated('original'),true,job.claim);
  let review=await (await call('/imports/'+job.id)).json();
  await call('/agenda/commit',{id:'race-original',type:'apply',importId:job.id,revision:review.revision});
  review=await (await call('/imports/'+job.id)).json();
  await call('/imports/'+job.id+'/feedback',{id:'race-feedback',revision:review.revision,text:'改标题'});
  const next=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  await call('/runner/result/'+job.id,generated('rewritten'),true,next.claim);
  review=await (await call('/imports/'+job.id)).json();
  const batch=env.DB.batch.bind(env.DB);
  env.DB.batch=async commands=>{sqlite.prepare('UPDATE agenda_items SET resolved_at=?,revision=revision+1').run(now);return batch(commands);};
  assert.equal((await call('/agenda/commit',{id:'race-rewrite',type:'apply',importId:job.id,revision:review.revision})).status,409);
  const rows=sqlite.prepare('SELECT * FROM agenda_items').all();
  assert.equal(rows.length,1);assert.equal(rows[0].title,'original');assert.equal(rows[0].resolved_at,now);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM agenda_operations WHERE id='race-rewrite'").get().n,0);
});

test('an activity moved during completion must be checked again before it can end',async()=>{
  const {call,sqlite,env}=setup();
  await call('/agenda/commit',{id:'past-activity',type:'create',items:[{key:'one',kind:'activity',title:'活动',anchorAt:now-3600000}]});
  const target=sqlite.prepare('SELECT * FROM agenda_items').get(),batch=env.DB.batch.bind(env.DB);
  env.DB.batch=async commands=>{sqlite.prepare('UPDATE agenda_items SET anchor_at=?,revision=revision+1 WHERE id=?').run(now+3600000,target.id);return batch(commands);};
  assert.equal((await call('/agenda/commit',{id:'race-complete',type:'resolve',itemId:target.id,at:now})).status,409);
  assert.equal(sqlite.prepare('SELECT resolved_at FROM agenda_items').get().resolved_at,null);
});
test('default windows, persistent occupancy and early completion use campus time',()=>{
  const anchor=A.localTime('2026-10-18T12:00'), ddl={kind:'deadline',anchorAt:anchor}, activity={kind:'activity',anchorAt:anchor};
  assert.deepEqual(A.windows(ddl),{from:anchor-3*A.HOUR,coreFrom:anchor-A.HOUR,coreTo:anchor,to:anchor});
  assert.equal(A.windows(activity).to,anchor+3*A.HOUR);
  assert.equal(A.busyInterval(ddl,anchor+2*A.DAY)[1],Infinity);
  assert.equal(A.busyInterval(activity,anchor+2*A.DAY)[1],Infinity);
  assert.equal(A.busyInterval({...ddl,resolvedAt:anchor-4*A.HOUR},anchor),null);
  assert.equal(A.meetingInterval({startAt:anchor,endAt:anchor+5*A.HOUR,confirmedAt:anchor+9*A.HOUR})[1],anchor+9*A.HOUR);
  assert.throws(()=>A.localTime('2026-02-30T12:00'));
});
test('authenticated writes are idempotent, one-way and enforce activity start',async()=>{
  const {call,env}=setup();
  assert.equal((await worker.fetch(new Request('https://app.test/agenda'),env)).status,401);
  assert.equal((await call('/runner/claim',{},false)).status,401);
  const op={id:'create-1',type:'create',items:[{key:'one',kind:'deadline',title:'论文',anchorAt:now+A.HOUR}]};
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',{...op,items:[{...op.items[0],title:'其他'}]})).status,409);
  let data=await (await call('/agenda')).json();assert.equal(data.items.length,1);
  assert.equal(await agendaBlocksGym(env,now,now+60000),true);
  const itemId=data.items[0].id;
  assert.equal((await call('/agenda/commit',{id:'resolve-1',type:'resolve',itemId,at:now})).status,200);
  await call('/agenda/commit',op);
  data=await (await call('/agenda')).json();assert.equal(data.items[0].resolvedAt,now);
  assert.equal(await agendaBlocksGym(env,now,now+60000),false);
  const activity={id:'activity-1',type:'create',items:[{key:'one',kind:'activity',title:'活动',anchorAt:now+A.HOUR}]};
  const created=await (await call('/agenda/commit',activity)).json();
  const id=created.items.find(v=>v.kind==='activity').id;
  assert.equal((await call('/agenda/commit',{id:'too-early',type:'resolve',itemId:id,at:now})).status,400);
});
test('image claim, stale leases, atomic apply and cancellation cannot resurrect work',async()=>{
  const {call,sqlite,env}=setup();
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
  const uploaded=await (await call('/imports?nonce=img-1',png)).json();
  assert(uploaded.id);
  assert.equal((await call('/imports/'+uploaded.id+'/image')).status,200);
  assert.equal((await worker.fetch(new Request('https://app.test/imports/'+uploaded.id+'/image'),env)).status,401);
  const job=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal(job.id,uploaded.id);
  const image=await call('/runner/image/'+job.id,undefined,true,job.claim);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()),png);
  const result={summary:'识别成功',items:[{key:'one',kind:'deadline',title:'论文',localTime:'2026-11-01T12:00',localEnd:null,location:'',evidence:'11月1日12点',question:''}]};
  assert.equal((await call('/runner/result/'+job.id,result,true,'wrong')).status,409);
  assert.equal((await call('/runner/result/'+job.id,result,true,job.claim)).status,200);
  const snapshot=await (await call('/agenda')).json(), imported=snapshot.imports[0];
  const op={id:'apply-1',type:'apply',importId:job.id,revision:imported.revision};
  assert.equal((await call('/agenda/commit',{...op,revision:1})).status,409);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',{...op,id:'different'})).status,409);
  assert.equal((await (await call('/agenda')).json()).items.length,1);
  await call('/imports?nonce=img-2',png);
  const job2=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  await call('/imports/'+job2.id+'/cancel',{});
  assert.equal((await call('/imports/'+job2.id+'/image')).status,410);
  assert.equal((await call('/runner/result/'+job2.id,result,true,job2.claim)).status,409);
  await call('/imports?nonce=img-3',png);
  const job3=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  sqlite.prepare('UPDATE agenda_imports SET lease_until=? WHERE id=?').run(now-1,job3.id);
  await cleanupAgenda(env,now);
  assert.equal((await call('/runner/result/'+job3.id,result,true,job3.claim)).status,409);
  assert.equal((await (await call('/runner/claim',{protocol:4},true)).json()).job,null,'expired inference is not automatically retried');
});
test('old device sync cannot restore individual meeting notifications or erase digests',async()=>{
  const {sqlite,env}=setup(),token='b'.repeat(43);
  sqlite.prepare('INSERT INTO devices(id,token_hash,endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('d',sha(token),'https://push.test','key','auth',now,now);
  sqlite.prepare('INSERT INTO agenda_digests VALUES(?,?,?,?)').run('saved',now,'[]',now);
  const jobs=[{id:'meeting-old-p30',dueAt:now+60000,title:'旧组会提醒',body:'旧版本',ttl:900},{id:'2026-10-19-c1-p30',dueAt:now+60000,title:'课程',body:'旧版本',ttl:900}];
  const response=await worker.fetch(new Request('https://app.test/sync',{method:'POST',headers:{origin:env.APP_ORIGIN,cookie:'__Host-neu_session='+'a'.repeat(43),authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jobs})}),env);
  assert.equal(response.status,200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM reminders WHERE reminder_id LIKE 'meeting-%'").get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM reminders').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_digests').get().n,1);
});
test('image dimensions, quota and expiry are checked by the server',async()=>{
  const {call,sqlite,env}=setup();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);huge.writeUInt32BE(100000,20);
  assert.equal((await call('/imports?nonce=too-big',huge)).status,400);
  const row=await (await call('/imports?nonce=expires',png)).json();
  sqlite.prepare('UPDATE agenda_imports SET expires_at=? WHERE id=?').run(now-1,row.id);
  assert.equal((await call('/imports/'+row.id+'/image')).status,410);
  await cleanupAgenda(env,now);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_import_chunks').get().n,0);
  assert.equal((await (await call('/runner/claim',{protocol:4},true)).json()).job,null);
  const full=await (await call('/imports?nonce=full',png)).json();
  sqlite.prepare('UPDATE agenda_imports SET byte_length=? WHERE id=?').run(50*1024*1024,full.id);
  assert.equal((await call('/imports?nonce=over-quota',png)).status,409);
});
test('digests cover rolling 72 hours and unresolved past; each daily slot delivers once',async()=>{
  const {call,sqlite,env}=setup(), slot=A.localTime('2026-10-18T07:00');
  sqlite.prepare('INSERT INTO devices(id,token_hash,endpoint,p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('d','hash','https://push.test','key','auth',slot-1,slot-1);
  for(const [id,at] of [['past',slot-A.DAY],['future',slot+72*A.HOUR-1],['outside',slot+72*A.HOUR]]) sqlite.prepare('INSERT INTO agenda_items(id,kind,title,anchor_at,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'deadline',id,at,slot,slot);
  sqlite.prepare('INSERT INTO group_meetings(id,start_at,created_at,updated_at) VALUES(?,?,?,?)').run('m',slot+A.HOUR,slot,slot);
  const sent=[],send=async(...args)=>{sent.push(args);return true;};
  await dispatchDigests(env,send,slot);await dispatchDigests(env,send,slot+60000);
  assert.equal(sent.length,1);assert.match(sent[0][2],/past/);assert.match(sent[0][2],/future/);assert.match(sent[0][2],/组会/);assert.doesNotMatch(sent[0][2],/outside/);
  assert.equal(new URL(sent[0][5].url).searchParams.get('agenda'),'digest');
  await dispatchDigests(env,send,slot+15*A.HOUR);assert.equal(sent.length,2);
  const snapshot=await (await call('/agenda')).json();assert.equal(snapshot.digests.length,2);
  const large=Array.from({length:100},(_,i)=>({id:String(i),kind:'deadline',at:slot,title:'长标题'.repeat(30),state:'planned'}));
  assert(Buffer.byteLength(digestNotice(large))<3000);assert.match(digestNotice(large),/共 100 项/);
  const escaped=large.map(v=>({...v,title:'"\\'.repeat(50)}));
  assert(Buffer.byteLength(JSON.stringify(digestNotice(escaped)))<3000,'encoded quotes and backslashes fit the push budget');
});

test('a complete multi-image batch is jointly claimed once; sources survive reviewed application',async()=>{
  const {call,sqlite,env}=setup(),manifest=batchManifest();
  const created=await (await call('/imports/batches',manifest)).json();
  assert(created.id,JSON.stringify(created));assert.equal(created.uploadState,'draft');assert.equal(created.images.length,2);
  assert.equal((await (await call('/imports/batches',manifest)).json()).id,created.id);
  assert.equal((await call('/imports/batches',{...manifest,note:'different'})).status,409);
  assert.equal((await call('/imports/'+created.id+'/submit',{})).status,409);
  assert.equal((await (await call('/runner/claim',{protocol:4},true)).json()).job,null);
  for(const [i,image] of manifest.images.entries()) {
    const bytes=Buffer.concat([imageBytes,Buffer.from([i])]);
    assert.equal((await call('/imports/'+created.id+'/images/'+image.id,bytes)).status,200);
    assert.equal((await call('/imports/'+created.id+'/images/'+image.id,bytes)).status,200,'same image upload is idempotent');
    const full=await call('/imports/'+created.id+'/source/'+(i+1));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
    assert.equal(full.headers.get('cache-control'),'no-store');
    assert.equal((await (await call('/runner/claim',{protocol:4},true)).json()).job,null,'complete uploads still wait for explicit submit');
  }
  const submitted=await (await call('/imports/'+created.id+'/submit',{})).json();
  assert.equal(submitted.uploadState,'ready');
  assert.equal((await (await call('/imports/'+created.id+'/submit',{})).json()).revision,submitted.revision);
  assert.equal((await (await call('/runner/claim',{},true)).json()).job,null,'legacy workers cannot claim image bundles');
  const job=(await (await call('/runner/claim',{protocol:4},true)).json()).job;
  assert.equal((await (await call('/runner/claim',{protocol:2},true)).json()).job,null);
  assert.equal(job.protocol,2);assert.deepEqual(job.images.map(v=>v.position),[1,2]);
  const result={summary:'联合识别',items:[{key:'one',kind:'deadline',title:'跨图论文任务',localTime:'2026-11-01T12:00',localEnd:null,location:'A101',evidence:'图1内容，图2时间',question:'',sourceImages:[1,2]}]};
  assert.equal((await call('/runner/result/'+job.id,{...result,items:[{...result.items[0],sourceImages:[3]}]},true,job.claim)).status,400);
  assert.equal((await call('/runner/result/'+job.id,result,true,job.claim)).status,200);
  const reviewed=await (await call('/imports/'+job.id)).json();
  const op={id:'apply-multi',type:'apply',importId:job.id,revision:reviewed.revision};
  const applied=await (await call('/agenda/commit',op)).json();
  assert.deepEqual(applied.items[0].sourceImages,[1,2],'sources come from immutable extraction instead of client edits');
  assert.equal(applied.items[0].sourceImportId,job.id);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,1);
  assert.equal((await worker.fetch(new Request('https://app.test/imports/'+job.id+'/source/2'),env)).status,401);
});

test('multi-image cancellation, missing data, corrupt uploads, limits and expiry remain safe',async()=>{
  const {call,sqlite,env}=setup(),manifest=batchManifest('limits');
  assert.equal((await call('/imports/batches',{...manifest,images:[]})).status,400);
  assert.equal((await call('/imports/batches',batchManifest('many',9))).status,400);
  assert.equal((await call('/imports/batches',{...manifest,images:[manifest.images[0],{...manifest.images[0],id:'other'}]})).status,400);
  assert.equal((await call('/imports/batches',{...manifest,images:batchManifest('total',5).images.map(image=>({...image,byteLength:5*1024*1024}))})).status,400);
  const created=await (await call('/imports/batches',manifest)).json();
  const path='/imports/'+created.id+'/images/'+manifest.images[0].id;
  assert.equal((await call(path,imageBytes)).status,400);
  assert.equal((await call(path,Buffer.concat([imageBytes,Buffer.from([0])]))).status,200);
  assert.equal((await call('/imports/'+created.id+'/submit',{})).status,409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_image_chunks').get().n,1);
  await call('/imports/'+created.id+'/cancel',{});
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_image_chunks').get().n,0);
  assert.equal((await call(path,Buffer.concat([imageBytes,Buffer.from([0])]))).status,409);
  assert.equal((await call('/imports/'+created.id+'/source/1')).status,410);
  const expired=await (await call('/imports/batches',batchManifest('expiry',1))).json();
  await call('/imports/'+expired.id+'/images/expiry-image-0',Buffer.concat([imageBytes,Buffer.from([0])]));
  sqlite.prepare('UPDATE agenda_imports SET expires_at=? WHERE id=?').run(now-1,expired.id);
  await cleanupAgenda(env,now);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_image_chunks').get().n,0);
  assert.equal((await call('/imports/'+expired.id+'/submit',{})).status,409);
});

test('cancellation racing with a final image upload cannot restore its bytes',async()=>{
  const {call,sqlite,env}=setup(),manifest=batchManifest('race',1),created=await (await call('/imports/batches',manifest)).json();
  const batch=env.DB.batch.bind(env.DB);let cancel=false;
  env.DB.batch=async commands=>{
    if(!cancel){cancel=true;sqlite.prepare("UPDATE agenda_imports SET status='cancelled' WHERE id=?").run(created.id);}
    return batch(commands);
  };
  assert.equal((await call('/imports/'+created.id+'/images/race-image-0',Buffer.concat([imageBytes,Buffer.from([0])]))).status,409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_image_chunks').get().n,0);
  assert.equal(sqlite.prepare('SELECT received_at FROM agenda_import_images').get().received_at,null);
});
