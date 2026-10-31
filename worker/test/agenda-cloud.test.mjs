import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import worker from '../src/index.js';
import {runCloudAgenda} from '../src/agenda-cloud.js';
import {claimAgendaJob,cleanupAgenda} from '../src/agenda.js';
import {archiveCloudEvidenceFile,readCloudEvidenceFile} from '../src/shared/cloud-evidence.mjs';

const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const generated=()=>({intent:'agenda',analysis:'',summary:'保留原图证据',relation:{type:'new',targetImportId:null,targetItemId:null,reason:''},
  items:[{key:'task',kind:'deadline',title:'交材料',localTime:'2026-11-02T15:00:00',localEnd:null,dateStart:null,dateEnd:null,location:'',evidence:'11月2日15点截止',inference:'',question:'',sourceImages:[1]}]});
const completed=(value=generated())=>({id:'resp_fixture',status:'completed',model:'gpt-6.1-terra',usage:{input_tokens:10,output_tokens:20},
  output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const stream=(value=generated())=>new Response('data: '+JSON.stringify({type:'response.completed',response:completed(value)})+'\n\n',{headers:{'content-type':'text/event-stream'}});

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  let queries=0,archivalBatch=false;const noteQuery=()=>{if(!archivalBatch)queries++;};
  const DB={prepare(sql){let args=[];return {text:sql,bind(...values){args=values.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v);return this;},
    async first(){noteQuery();return sqlite.prepare(sql).get(...args)||null;},async all(){noteQuery();return {results:sqlite.prepare(sql).all(...args),...(sql==='SELECT 1'?{meta:{size_after:env.storageSize}}:{})};},
    async run(){noteQuery();return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};},
    async batch(commands){archivalBatch=commands[0]?.text?.startsWith('UPDATE api_cloud_runs SET response_json=?');if(archivalBatch)queries++;sqlite.exec('BEGIN');try{const result=[];for(const command of commands)result.push(await command.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}finally{archivalBatch=false;}}};
  const token='a'.repeat(43),now=Date.now();
  const env={DB,APP_ORIGIN:'https://app.test',APP_URL:'https://app.test',AGENDA_RUNNER_KEY:'runner-fixture',
    API_CLOUD_ENABLED:'true',SECOND_SERIES_OPENAI_KEY:{async get(){return 'sk-fixture';}},storageSize:917504};
  sqlite.prepare('INSERT INTO auth_credential VALUES(1,?,?,0,?,?)').run('credential','key','[]',now);
  sqlite.prepare('INSERT INTO auth_sessions VALUES(?,1,?,?)').run(createHash('sha256').update(token).digest('base64url'),now,now+86400000);
  const call=async(path,value,runner=false)=>{
    const headers=runner?{authorization:'Bearer '+env.AGENDA_RUNNER_KEY}:{origin:env.APP_ORIGIN,cookie:'__Host-neu_session='+token};
    const body=value===undefined?undefined:value instanceof Uint8Array?value:JSON.stringify(value);
    return worker.fetch(new Request(env.APP_ORIGIN+path,{method:value===undefined?'GET':'POST',headers,body}),env);
  };
  const upload=async()=>{const response=await call('/imports?nonce='+randomUUID(),image);assert.equal(response.status,200);return response.json();};
  return {env,sqlite,call,upload,queryCount:()=>queries,resetQueryCount:()=>{queries=0;}};
}
const storageBinding=reports=>({policy(){return{schemaVersion:1,policyRevision:1,projectId:'schedule',allocations:[{resourceId:'d1-schedule',mode:'current',resource:{id:'d1-schedule',scope:'project',owner:'schedule',state:'active'}}]};},report(value){reports.push(value);return{ok:true};}});
function evidenceFiles(){const objects=new Map();const api={unavailable:false,objects,async put(bytes){const digest=createHash('sha256').update(bytes).digest('hex');objects.set(digest,new Uint8Array(bytes));return{digest,bytes:bytes.byteLength};},async get(digest){if(api.unavailable)throw Error('fixture file outage');const bytes=objects.get(digest);return bytes?{digest,bytes:new Uint8Array(bytes)}:null;}};api.archiveEvidence=request=>archiveCloudEvidenceFile({filesBinding:api,request});api.readEvidence=request=>readCloudEvidenceFile({filesBinding:api,request});return api;}

test('archived extraction results wait through file outages and recover the same generation without a second model call',async()=>{
 const {env,sqlite,upload}=fixture();try{
  env.FILES=evidenceFiles();await upload();const batch=env.DB.batch;let interrupt=true;
  let paid=0;const fetchImpl=async()=>{paid++;return stream();};
  // The same transaction interruption used by the existing durable-completion test.
  env.DB.batch=async commands=>{if(interrupt&&sqlite.prepare('SELECT outcome FROM api_cloud_runs').get()?.outcome==='completed'&&!String(commands[0]?.text).startsWith('UPDATE api_cloud_runs SET response_json=?'))throw Error('fixture interrupted business write');return batch(commands);};
  assert.equal((await runCloudAgenda(env,{fetchImpl})).completionPending,true);assert.equal(JSON.parse(sqlite.prepare('SELECT response_json FROM api_cloud_runs').get().response_json).archiveFormat,'second-series-api-evidence-v1');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM api_cloud_streams').get().n,0);
  interrupt=false;env.FILES.unavailable=true;delete env.SECOND_SERIES_OPENAI_KEY;const before=sqlite.prepare('SELECT status,generation,outcome_unknown FROM agenda_imports').get();
  const waiting=await runCloudAgenda(env,{fetchImpl});assert.equal(waiting.protectedUnavailable,true);assert.equal(waiting.completionPending,true);assert.deepEqual(sqlite.prepare('SELECT status,generation,outcome_unknown FROM agenda_imports').get(),before);assert.equal(paid,1);
  env.FILES.unavailable=false;assert.equal((await runCloudAgenda(env,{fetchImpl})).recovered,true);assert.equal(paid,1);assert.equal(sqlite.prepare('SELECT status FROM agenda_imports').get().status,'review');assert.equal(sqlite.prepare('SELECT generation FROM agenda_imports').get().generation,before.generation);
 }finally{sqlite.close();}
});

test('storage policy and file capabilities remain project-scoped and only handled agenda work reports size',async()=>{
 const {env,sqlite,upload}=fixture();const reports=[];env.SERIES_STORAGE=storageBinding(reports);env.FILES=new Proxy({}, {get(){throw Error('temporary agenda images must not enter a file archive');}});
 try{
  assert.equal((await runCloudAgenda(env)).processed,false);assert.equal(reports.length,0);await upload();let paid=0;
  assert.equal((await runCloudAgenda(env,{fetchImpl:async()=>{paid++;return stream();}})).processed,true);assert.equal(paid,1);assert.equal(reports.length,1);
  const row=reports[0].reports[0];assert.equal(row.resourceId,'d1-schedule');assert.equal(row.usedBytes,917504);assert.equal(row.measurement,'database-size');assert.equal(row.limitBytes,null);assert.equal(row.remainingBytes,null);
  assert(!JSON.stringify(reports).includes(image.toString('base64')));assert(!JSON.stringify(reports).includes('交材料'));
  await runCloudAgenda(env);assert.equal(reports.length,1);
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(config.services.find(service=>service.binding==='SERIES_STORAGE'),{binding:'SERIES_STORAGE',service:'the-second-language-api',entrypoint:'ScheduleStorage'});
  assert.deepEqual(config.services.find(service=>service.binding==='FILES'),{binding:'FILES',service:'second-series-files',entrypoint:'ScheduleFiles'});
  assert.equal(config.d1_databases.length,1);assert.equal(config.d1_databases[0].database_id,'8d87acfa-cd34-4995-860a-e2b1e589572d');
 }finally{sqlite.close();}
});

test('storage metadata unknowns and RPC failures preserve the agenda result and do not repeat a paid request',async()=>{
 for(const mode of['missing-size','rpc-failure','wrong-project']){
  const {env,sqlite,upload}=fixture();try{
   const reports=[];env.SERIES_STORAGE=storageBinding(reports);if(mode==='missing-size')env.storageSize=undefined;
   if(mode==='rpc-failure')env.SERIES_STORAGE.report=value=>{reports.push(value);throw Error('private metadata delivery diagnostic');};
   if(mode==='wrong-project')env.SERIES_STORAGE.policy=()=>({schemaVersion:1,policyRevision:1,projectId:'algorithm',allocations:[]});
   await upload();let paid=0;const fetchImpl=async()=>{paid++;return stream();};assert.equal((await runCloudAgenda(env,{fetchImpl})).processed,true);
   assert.equal(sqlite.prepare('SELECT status FROM agenda_imports').get().status,'review');await runCloudAgenda(env,{fetchImpl});assert.equal(paid,1);
   if(mode==='missing-size'){assert.equal(reports.length,1);assert.equal(reports[0].reports[0].verified,false);assert(!Object.hasOwn(reports[0].reports[0],'usedBytes'));}
   if(mode==='wrong-project')assert.equal(reports.length,0);
  }finally{sqlite.close();}
 }
});

test('cloud routing is opt-in per new upload and the external runner cannot take cloud work',async()=>{
  const {env,sqlite,call,upload}=fixture();
  env.API_CLOUD_ENABLED='false';const legacy=await upload();env.API_CLOUD_ENABLED='true';const cloud=await upload();
  assert.equal(legacy.executionMode,'legacy');assert.equal(cloud.executionMode,'cloud-v1');
  const job=(await (await call('/runner/claim',{protocol:4,executionMode:'cloud-v1'},true)).json()).job;
  assert.equal(job.id,legacy.id);
  assert.equal((await (await call('/runner/claim',{protocol:4},true)).json()).job,null);
  let calls=0;const result=await runCloudAgenda(env,{fetchImpl:async()=>{calls++;return stream();}});
  assert.equal(result.processed,true);assert.equal(calls,1);
  assert.equal(sqlite.prepare('SELECT status FROM agenda_imports WHERE id=?').get(cloud.id).status,'review');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,0);
});

test('an explicit legacy feedback request uses cloud after activation without moving history or active calls',async()=>{
  const {env,sqlite,call,upload}=fixture();env.API_CLOUD_ENABLED='false';
  const known=await upload(),active=await upload();
  sqlite.prepare("UPDATE agenda_imports SET status='failed',error='known failure' WHERE id=?").run(known.id);
  const legacyJob=(await (await call('/runner/claim',{protocol:4},true)).json()).job;assert.equal(legacyJob.id,active.id);
  env.API_CLOUD_ENABLED='true';
  assert.equal(sqlite.prepare('SELECT execution_mode FROM agenda_imports WHERE id=?').get(known.id).execution_mode,'legacy');
  assert.equal((await call('/imports/'+active.id+'/feedback',{id:randomUUID(),revision:active.revision+1,text:'改说明'})).status,409);
  assert.equal((await call('/imports/'+known.id+'/feedback',{id:randomUUID(),revision:known.revision,text:'按新说明再识别'})).status,200);
  const updated=sqlite.prepare('SELECT execution_mode,generation FROM agenda_imports WHERE id=?').get(known.id);
  assert.equal(updated.execution_mode,'cloud-v1');assert.equal(updated.generation,0);
  assert.equal((await runCloudAgenda(env,{fetchImpl:async()=>stream()})).processed,true);
  assert.equal(sqlite.prepare('SELECT execution_mode FROM agenda_imports WHERE id=?').get(active.id).execution_mode,'legacy');
});

test('cloud inference saves one terminal response and usage without retaining image request copies',async()=>{
  const {env,sqlite,upload}=fixture();await upload();let calls=0;
  const fetchImpl=async(url,request)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(request.redirect,'manual');
    const body=JSON.parse(request.body);assert.equal(body.model,'gpt-6.1-terra');assert.equal(body.reasoning.effort,'xhigh');
    assert.equal(body.max_output_tokens,8192);assert.equal(body.store,false);assert.equal(body.tools,undefined);
    assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,'+image.toString('base64'));return stream();};
  assert.equal((await runCloudAgenda(env,{fetchImpl})).processed,true);
  await runCloudAgenda(env,{fetchImpl});assert.equal(calls,1);
  const row=sqlite.prepare('SELECT * FROM api_cloud_runs').get();assert.equal(row.outcome,'completed');
  assert.equal(JSON.parse(row.usage_json).input_tokens,10);assert.equal(JSON.stringify(row).includes(image.toString('base64')),false);
  assert.equal(sqlite.prepare('SELECT result_json FROM agenda_imports').get().result_json.includes('2026-11-02T15:00"'),true);
});

test('a provider redirect is rejected without following it or automatically resending',async()=>{
  const {env,sqlite,upload}=fixture();await upload();let calls=0;
  const fetchImpl=async(url,request)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(request.redirect,'manual');
    return new Response('',{status:307,headers:{location:'https://redirect.invalid/response'}});};
  const result=await runCloudAgenda(env,{fetchImpl});assert.equal(result.failed,true);assert.equal(result.outcomeUnknown,false);
  assert.equal(sqlite.prepare('SELECT http_status FROM api_cloud_runs').get().http_status,307);
  await runCloudAgenda(env,{fetchImpl});assert.equal(calls,1);
});

test('an interrupted cloud call is visible as unknown and feedback cannot trigger another generation',async()=>{
  const {env,sqlite,call,upload}=fixture();const item=await upload();let calls=0;
  const fetchImpl=async()=>{calls++;throw Error('fixture interruption');};
  assert.equal((await runCloudAgenda(env,{fetchImpl})).outcomeUnknown,true);
  const row=sqlite.prepare('SELECT * FROM agenda_imports WHERE id=?').get(item.id);
  assert.equal(row.status,'failed');assert.equal(row.outcome_unknown,1);
  assert.equal((await call('/imports/'+item.id+'/feedback',{id:randomUUID(),revision:row.revision,text:'重试'})).status,409);
  await runCloudAgenda(env,{fetchImpl});assert.equal(calls,1);
  assert.equal(sqlite.prepare('SELECT generation FROM agenda_imports WHERE id=?').get(item.id).generation,1);
});

test('a completed response recovers after a lost business acknowledgement without a key or another POST',async()=>{
  const {env,sqlite,upload}=fixture();await upload();
  const job=await claimAgendaJob(env,{protocol:4},'cloud-v1');
  sqlite.prepare("INSERT INTO api_cloud_runs(project,task,attempt,request_digest,model,outcome,started_at,response_json) VALUES('second-schedule',?,?,?,'gpt-6.1-terra','completed',?,?)")
    .run(job.id,String(job.generation),'a'.repeat(64),Date.now(),JSON.stringify(completed()));
  sqlite.prepare('UPDATE agenda_imports SET lease_until=0 WHERE id=?').run(job.id);
  await cleanupAgenda(env);env.SECOND_SERIES_OPENAI_KEY=undefined;
  const result=await runCloudAgenda(env,{fetchImpl:async()=>{throw Error('must not call');}});
  assert.equal(result.recovered,true);
  const row=sqlite.prepare('SELECT status,outcome_unknown FROM agenda_imports WHERE id=?').get(job.id);
  assert.equal(row.status,'review');assert.equal(row.outcome_unknown,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_result_versions').get().n,1);
  await runCloudAgenda(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_result_versions').get().n,1);
});

test('a temporary business write error keeps the saved successful inference recoverable',async()=>{
  const {env,sqlite,upload}=fixture();await upload();let failBatch=false,calls=0;
  const originalBatch=env.DB.batch.bind(env.DB);
  env.DB.batch=async commands=>{if(failBatch){failBatch=false;throw Error('fixture database interruption');}return originalBatch(commands);};
  const result=await runCloudAgenda(env,{fetchImpl:async()=>{calls++;failBatch=true;return stream();}});
  assert.equal(result.completionPending,true);assert.equal(sqlite.prepare('SELECT status FROM agenda_imports').get().status,'running');
  assert.equal((await runCloudAgenda(env,{fetchImpl:async()=>{throw Error('must reuse');}})).recovered,true);
  assert.equal(calls,1);assert.equal(sqlite.prepare('SELECT status FROM agenda_imports').get().status,'review');
});

test('overlapping Cron invocations cannot start concurrent cloud inferences',async()=>{
  const {env,upload}=fixture();await upload();await upload();let release,arrived;
  const started=new Promise(resolve=>{arrived=resolve;});const held=new Promise(resolve=>{release=resolve;});let calls=0;
  const first=runCloudAgenda(env,{fetchImpl:async()=>{calls++;arrived();await held;return stream();}});
  await started;assert.deepEqual(await runCloudAgenda(env),{busy:true});assert.equal(calls,1);
  release();await first;
});

test('cloud feedback waits for a known result and cancellation wins a late model completion',async()=>{
  const {env,sqlite,call,upload}=fixture();const item=await upload();let release,arrived;
  const started=new Promise(resolve=>{arrived=resolve;});const held=new Promise(resolve=>{release=resolve;});
  const pending=runCloudAgenda(env,{fetchImpl:async()=>{arrived();await held;return stream();}});await started;
  const row=sqlite.prepare('SELECT revision FROM agenda_imports WHERE id=?').get(item.id);
  assert.equal((await call('/imports/'+item.id+'/feedback',{id:randomUUID(),revision:row.revision,text:'改日期'})).status,409);
  assert.equal((await call('/imports/'+item.id+'/cancel',{})).status,200);
  release();assert.equal((await pending).processed,false);
  assert.equal(sqlite.prepare('SELECT status FROM agenda_imports WHERE id=?').get(item.id).status,'cancelled');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_items').get().n,0);
});

test('a cloud lease expiry is never recycled as an ordinary retry and original image expiry still clears bytes',async()=>{
  const {env,sqlite,call,upload}=fixture();const item=await upload();await claimAgendaJob(env,{protocol:4},'cloud-v1');
  sqlite.prepare('UPDATE agenda_imports SET lease_until=0,expires_at=0 WHERE id=?').run(item.id);
  await cleanupAgenda(env);const row=sqlite.prepare('SELECT * FROM agenda_imports WHERE id=?').get(item.id);
  assert.equal(row.outcome_unknown,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM agenda_import_chunks').get().n,0);
  assert.equal((await call('/imports/'+item.id+'/feedback',{id:randomUUID(),revision:row.revision,text:'再试'})).status,409);
  assert.equal((await runCloudAgenda(env,{fetchImpl:async()=>{throw Error('must not call');}})).processed,false);
});

test('missing cloud configuration and the disabled switch do not consume pending work',async()=>{
  const {env,sqlite,upload}=fixture();await upload();env.SECOND_SERIES_OPENAI_KEY=undefined;
  assert.equal((await runCloudAgenda(env)).configurationMissing,true);
  assert.equal(sqlite.prepare('SELECT generation FROM agenda_imports').get().generation,0);
  env.API_CLOUD_ENABLED='false';assert.deepEqual(await runCloudAgenda(env),{enabled:false});
  assert.equal(sqlite.prepare('SELECT status FROM agenda_imports').get().status,'queued');
});

test('usage RPC contains only cumulative counters after handled work and never re-runs a model on report failure',async()=>{
  const {env,upload}=fixture();const reports=[];env.SERIES_USAGE={async report(value){reports.push(value);throw Error('fixture delivery failure');}};
  await runCloudAgenda(env);assert.equal(reports.length,0);await upload();let calls=0;
  await runCloudAgenda(env,{fetchImpl:async()=>{calls++;return stream();}});
  assert.equal(reports.length,1);assert.equal(reports[0].responses,1);assert.equal(reports[0].inputTokens,10);
  assert.deepEqual(Object.keys(reports[0]).sort(),['cachedInputTokens','checkedAt','inProgressCalls','inputTokens','outputTokens','responses','revision','unknownCalls'].sort());
  await runCloudAgenda(env,{fetchImpl:async()=>{calls++;return stream();}});
  assert.equal(calls,1);assert.equal(reports.length,1);
});

test('eight-image RPC plus a near-limit wire receipt and storage metadata reserve seven timed heartbeats within 50 D1 queries',async()=>{
  const {env,call,queryCount,resetQueryCount,sqlite}=fixture();env.SERIES_USAGE={async report(){}};const storageReports=[];env.SERIES_STORAGE=storageBinding(storageReports);env.FILES=evidenceFiles();
  const images=Array.from({length:8},(_,index)=>{const bytes=Buffer.concat([image,Buffer.from([index])]);return {id:'image-'+index,mime:'image/png',byteLength:bytes.length,digest:createHash('sha256').update(bytes).digest('hex'),bytes};});
  const created=await (await call('/imports/batches',{protocol:2,nonce:randomUUID(),note:'同一申请的八张图',images:images.map(({bytes,...entry})=>entry)})).json();
  for(const source of images)assert.equal((await call('/imports/'+created.id+'/images/'+source.id,source.bytes)).status,200);
  assert.equal((await call('/imports/'+created.id+'/submit',{})).status,200);resetQueryCount();
  const terminal='data: '+JSON.stringify({type:'response.completed',response:completed()})+'\n\n';
  const raw=(': '+'x'.repeat(65500)+'\n\n').repeat(31)+terminal;
  const result=await runCloudAgenda(env,{fetchImpl:async()=>new Response(raw,{headers:{'content-type':'text/event-stream'}})});
  assert.equal(result.processed,true);
  assert.equal(storageReports.length,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM api_cloud_streams').get().n,0);assert.equal(JSON.parse(sqlite.prepare('SELECT response_json FROM api_cloud_runs').get().response_json).archiveFormat,'second-series-api-evidence-v1');
  // The pre-send heartbeat is already counted. A 480s timeout permits at most seven later 60s renewals.
  assert(queryCount()+7<=50,'maximum receipt path plus timed heartbeats must fit the independent RPC budget: '+queryCount());
  console.log('Schedule Free D1 query check:',queryCount(),'+ 7 timed renewals <= 50');
});
