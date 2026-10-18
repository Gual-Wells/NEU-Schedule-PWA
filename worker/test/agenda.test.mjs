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
  const job=(await (await call('/runner/claim',{},true)).json()).job;
  assert.equal(job.id,uploaded.id);
  const image=await call('/runner/image/'+job.id,undefined,true,job.claim);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()),png);
  const result={summary:'识别成功',items:[{key:'one',kind:'deadline',title:'论文',localTime:'2026-11-01T12:00',localEnd:null,location:'',evidence:'11月1日12点',question:''}]};
  assert.equal((await call('/runner/result/'+job.id,result,true,'wrong')).status,409);
  assert.equal((await call('/runner/result/'+job.id,result,true,job.claim)).status,200);
  const snapshot=await (await call('/agenda')).json(), imported=snapshot.imports[0];
  const op={id:'apply-1',type:'apply',importId:job.id,revision:imported.revision,items:[{key:'one',kind:'deadline',title:'论文',anchorAt:A.localTime('2026-11-01T12:00')}]};
  assert.equal((await call('/agenda/commit',{...op,revision:1})).status,409);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',op)).status,200);
  assert.equal((await call('/agenda/commit',{...op,id:'different'})).status,409);
  assert.equal((await (await call('/agenda')).json()).items.length,1);
  await call('/imports?nonce=img-2',png);
  const job2=(await (await call('/runner/claim',{},true)).json()).job;
  await call('/imports/'+job2.id+'/cancel',{});
  assert.equal((await call('/imports/'+job2.id+'/image')).status,410);
  assert.equal((await call('/runner/result/'+job2.id,result,true,job2.claim)).status,409);
  await call('/imports?nonce=img-3',png);
  const job3=(await (await call('/runner/claim',{},true)).json()).job;
  sqlite.prepare('UPDATE agenda_imports SET lease_until=? WHERE id=?').run(now-1,job3.id);
  await cleanupAgenda(env,now);
  assert.equal((await call('/runner/result/'+job3.id,result,true,job3.claim)).status,409);
  assert.equal((await (await call('/runner/claim',{},true)).json()).job,null,'expired inference is not automatically retried');
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
  assert.equal((await (await call('/runner/claim',{},true)).json()).job,null);
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
  assert.equal((await (await call('/runner/claim',{protocol:2},true)).json()).job,null);
  for(const [i,image] of manifest.images.entries()) {
    const bytes=Buffer.concat([imageBytes,Buffer.from([i])]);
    assert.equal((await call('/imports/'+created.id+'/images/'+image.id,bytes)).status,200);
    assert.equal((await call('/imports/'+created.id+'/images/'+image.id,bytes)).status,200,'same image upload is idempotent');
    const full=await call('/imports/'+created.id+'/source/'+(i+1));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
    assert.equal(full.headers.get('cache-control'),'no-store');
    assert.equal((await (await call('/runner/claim',{protocol:2},true)).json()).job,null,'complete uploads still wait for explicit submit');
  }
  const submitted=await (await call('/imports/'+created.id+'/submit',{})).json();
  assert.equal(submitted.uploadState,'ready');
  assert.equal((await (await call('/imports/'+created.id+'/submit',{})).json()).revision,submitted.revision);
  assert.equal((await (await call('/runner/claim',{},true)).json()).job,null,'legacy workers cannot claim image bundles');
  const job=(await (await call('/runner/claim',{protocol:2},true)).json()).job;
  assert.equal(job.protocol,2);assert.deepEqual(job.images.map(v=>v.position),[1,2]);
  const result={summary:'联合识别',items:[{key:'one',kind:'deadline',title:'跨图论文任务',localTime:'2026-11-01T12:00',localEnd:null,location:'A101',evidence:'图1内容，图2时间',question:'',sourceImages:[1,2]}]};
  assert.equal((await call('/runner/result/'+job.id,{...result,items:[{...result.items[0],sourceImages:[3]}]},true,job.claim)).status,400);
  assert.equal((await call('/runner/result/'+job.id,result,true,job.claim)).status,200);
  const reviewed=await (await call('/imports/'+job.id)).json();
  const op={id:'apply-multi',type:'apply',importId:job.id,revision:reviewed.revision,items:[{key:'one',kind:'deadline',title:'跨图论文任务',anchorAt:A.localTime('2026-11-01T12:00'),sourceImages:[8]}]};
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
