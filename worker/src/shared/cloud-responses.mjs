// Shared second-series wire runtime. Call only inside a project-scoped Cloudflare Worker.
// No publisher authority, cross-project database binding, local credentials or automatic paid retries.
import {createParser} from './vendor/eventsource-parser/parse.js';
export const CLOUD_API_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_cloud_runs (
 project TEXT NOT NULL, task TEXT NOT NULL, attempt TEXT NOT NULL,
 request_digest TEXT NOT NULL, model TEXT NOT NULL, outcome TEXT NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER, http_status INTEGER,
 response_id TEXT, request_id TEXT, response_json TEXT, usage_json TEXT,
 failure_code TEXT, stream_digest TEXT,
 PRIMARY KEY(project,task,attempt)
);
CREATE TABLE IF NOT EXISTS api_cloud_streams (
 run_key TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(run_key,seq)
);
CREATE TABLE IF NOT EXISTS api_cloud_locks (
 project TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_cloud_usage (
 project TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
 responses INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS api_cloud_runs_outcome ON api_cloud_runs(project,outcome);
CREATE TRIGGER IF NOT EXISTS api_cloud_usage_count_once
AFTER UPDATE OF usage_json ON api_cloud_runs
WHEN OLD.usage_json IS NULL AND NEW.usage_json IS NOT NULL AND json_valid(NEW.usage_json)
BEGIN
 INSERT INTO api_cloud_usage(project,input_tokens,output_tokens,cached_input_tokens,responses,revision)
 VALUES(NEW.project,
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.input_tokens') AS INTEGER),0)),
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.output_tokens') AS INTEGER),0)),
  MAX(0,COALESCE(CAST(json_extract(NEW.usage_json,'$.input_tokens_details.cached_tokens') AS INTEGER),0)),1,1)
 ON CONFLICT(project) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
 output_tokens=output_tokens+excluded.output_tokens,cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,
 responses=responses+1,revision=revision+1;
END;`;

const encoder=new TextEncoder();
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const problem=(message,flags={})=>Object.assign(Error(message),flags);
const changes=result=>Number(result?.meta?.changes||result?.changes||0);
const identity=(project,task,attempt)=>[project,task,String(attempt)];
export async function withCloudLock({db,project,run,now=()=>Date.now()}){
 const owner=crypto.randomUUID(),at=now();
 const result=await db.prepare(`INSERT INTO api_cloud_locks(project,owner,expires_at) VALUES(?,?,?)
 ON CONFLICT(project) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
 WHERE api_cloud_locks.expires_at<?`).bind(project,owner,at+840000,at).run();
 if(changes(result)!==1)return {busy:true};
 try{return await run();}finally{await db.prepare('DELETE FROM api_cloud_locks WHERE project=? AND owner=?').bind(project,owner).run();}
}
export function cloudResponseJSON(response){
 if(response?.status!=='completed')throw problem('模型未完成，原始结果已保存');
 const content=(response.output||[]).filter(item=>item.type==='message'&&item.role==='assistant').flatMap(item=>item.content||[]);
 if(content.some(item=>item.type==='refusal'))throw problem('模型未提供本次结果，原始结果已保存');
 try{return JSON.parse(content.filter(item=>item.type==='output_text').map(item=>item.text).join(''));}
 catch{throw problem('模型结果格式未通过，原始结果已保存');}
}
export async function readCloudResult({db,project,task,attempt}){
 const row=await db.prepare('SELECT * FROM api_cloud_runs WHERE project=? AND task=? AND attempt=?').bind(...identity(project,task,attempt)).first();
 if(!row||row.outcome!=='completed')return null;
 const response=JSON.parse(row.response_json);return {value:cloudResponseJSON(response),response,reused:true};
}
export async function readCloudUsage({db,project,now=()=>Date.now()}){
 const rows=await db.prepare(`SELECT u.input_tokens,u.output_tokens,u.cached_input_tokens,u.responses,u.revision,
 (SELECT COUNT(*) FROM api_cloud_runs WHERE project=? AND (outcome='unknown' OR (outcome='sending' AND started_at<=?))) AS unknown_calls,
 (SELECT COUNT(*) FROM api_cloud_runs WHERE project=? AND outcome='sending' AND started_at>?) AS in_progress_calls
 FROM (SELECT ? AS name) p LEFT JOIN api_cloud_usage u ON u.project=p.name`).bind(project,now()-840000,project,now()-840000,project).first();
 return {inputTokens:rows?.input_tokens||0,outputTokens:rows?.output_tokens||0,cachedInputTokens:rows?.cached_input_tokens||0,responses:rows?.responses||0,unknownCalls:rows?.unknown_calls||0,inProgressCalls:rows?.in_progress_calls||0,revision:rows?.revision||0,checkedAt:new Date(now()).toISOString()};
}
async function resolveKey(binding){
 if(!binding)throw problem('云端API凭据尚未配置',{configurationMissing:true});
 // A Secrets Store binding resolves only in the deployed application, never in provisioning tools.
 let key;try{key=typeof binding==='string'?binding:typeof binding.get==='function'?await binding.get():null;}
 catch{throw problem('云端API凭据暂不可用',{configurationMissing:true});}
 if(typeof key!=='string'||!/^sk-[A-Za-z0-9_-]+$/.test(key))throw problem('云端API凭据不可用',{configurationMissing:true});
 return key;
}
export async function runCloudResponses({db,keyBinding,project,task,attempt,instructions,input,schema,name='task_result',config={},heartbeat,fetchImpl=fetch,now=()=>Date.now()}){
 if(!/^[a-z0-9-]{1,64}$/.test(project)||typeof task!=='string'||!task||task.length>200||String(attempt).length>100)throw problem('云端任务身份无效');
 const model=config.model||'gpt-6.1-sol',effort=config.reasoningEffort||'xhigh';
 if(!/^gpt-[a-z0-9.-]+$/.test(model)||!['none','low','medium','high','xhigh','max'].includes(effort))throw problem('云端模型配置无效');
 const timeoutMs=config.timeoutMs||600000;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>780000)throw problem('云端任务时限无效');
 const maxOutputTokens=config.maxOutputTokens||16384;
 if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>32768)throw problem('云端结果上限无效');
 const body={model,store:false,reasoning:{effort},max_output_tokens:maxOutputTokens,instructions,input,text:{format:{type:'json_schema',name,strict:true,schema}},stream:true};
 const bodyText=JSON.stringify(body),requestDigest=await digest(bodyText),ids=identity(project,task,attempt);
 let row=await db.prepare('SELECT * FROM api_cloud_runs WHERE project=? AND task=? AND attempt=?').bind(...ids).first();
 if(row){
  if(row.request_digest!==requestDigest)throw problem('已发送任务的输入发生变化，未再次调用');
  if(row.outcome==='completed'){const response=JSON.parse(row.response_json);return {value:cloudResponseJSON(response),response,reused:true};}
  if(row.outcome==='sending'&&now()-row.started_at<timeoutMs+60000)throw problem('本次API任务仍在处理中',{inProgress:true});
  throw problem('上次API结果待核对，未再次调用',{outcomeUnknown:row.outcome!=='rejected'});
 }
 const key=await resolveKey(keyBinding);
 if(heartbeat&&await heartbeat()===false)throw problem('任务领取已失效，未调用API',{claimLost:true});
 const inserted=await db.prepare(`INSERT OR IGNORE INTO api_cloud_runs(project,task,attempt,request_digest,model,outcome,started_at) VALUES(?,?,?,?,?,'sending',?)`).bind(...ids,requestDigest,model,now()).run();
 if(changes(inserted)!==1)throw problem('任务已由另一执行器接管',{inProgress:true});
 const controller=new AbortController();let claimLost=false,headerStatus=null,saved=false,timerBusy=false;
 const timeout=setTimeout(()=>controller.abort(),timeoutMs);
 const beat=heartbeat?setInterval(async()=>{if(timerBusy)return;timerBusy=true;try{if(await heartbeat()===false){claimLost=true;controller.abort();}}catch{claimLost=true;controller.abort();}finally{timerBusy=false;}},60000):null;
 const runKey=await digest(JSON.stringify(ids));let seq=0,pending='',rawTotal=0,allRaw='',terminal=null,requestId=null;
 async function flush(force=true){while(pending&&(force||pending.length>=262144)){
  let end=Math.min(pending.length,262144);
  if(end<pending.length&&pending.charCodeAt(end-1)>=0xD800&&pending.charCodeAt(end-1)<=0xDBFF&&pending.charCodeAt(end)>=0xDC00&&pending.charCodeAt(end)<=0xDFFF)end--;
  const data=pending.slice(0,end);await db.prepare('INSERT OR IGNORE INTO api_cloud_streams(run_key,seq,data) VALUES(?,?,?)').bind(runKey,seq,data).run();pending=pending.slice(data.length);seq++;
 }}
 try{
  // workerd rejects redirect:"error" before sending. Manual also prevents a
  // redirect from forwarding the bearer credential; every non-2xx stops below.
  const response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'manual',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:bodyText,signal:controller.signal});
  headerStatus=response.status;requestId=response.headers.get('x-request-id');
  await db.prepare('UPDATE api_cloud_runs SET http_status=?,request_id=? WHERE project=? AND task=? AND attempt=?').bind(headerStatus,requestId,...ids).run();
  if(!response.ok){
   const raw=(await response.text()).slice(0,65536);pending+=raw;allRaw+=raw;await flush();
   const unknown=response.status>=500;
   await db.prepare('UPDATE api_cloud_runs SET outcome=?,finished_at=?,failure_code=?,stream_digest=? WHERE project=? AND task=? AND attempt=?').bind(unknown?'unknown':'rejected',now(),'http_'+response.status,await digest(allRaw),...ids).run();saved=true;
   throw problem(unknown?'API结果待核对，未自动重试':'API请求未完成，未自动重试',{outcomeUnknown:unknown});
  }
  const reader=response.body?.getReader();if(!reader)throw problem('模型响应为空');
  const decoder=new TextDecoder();
  const parser=createParser({maxBufferSize:2*1024*1024,onError(){if(!terminal)throw problem('模型响应事件不完整');},onEvent({data}){
   if(terminal||data==='[DONE]')return;
   let event;try{event=JSON.parse(data);}catch{throw problem('模型响应事件不完整');}
   if(['response.completed','response.failed','response.incomplete'].includes(event.type)&&event.response&&typeof event.response==='object')terminal=event.response;
   if(event.type==='error')throw problem('模型响应未完成');
  }});
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   const part=decoder.decode(value,{stream:true});rawTotal+=value.byteLength;
   if(rawTotal>2*1024*1024){await reader.cancel();throw problem('模型响应超过保存上限');}
   pending+=part;allRaw+=part;if(pending.length>=262144)await flush(false);parser.feed(part);
   if(terminal)break;
  }
  if(!terminal){const tail=decoder.decode();pending+=tail;allRaw+=tail;parser.feed(tail);}await flush();
  if(!terminal||!['completed','failed','incomplete'].includes(terminal.status))throw problem('模型响应缺少完整终态');
  const responseJSON=JSON.stringify(terminal);if(encoder.encode(responseJSON).length>1500000)throw problem('模型结果超过单份保存上限');
  await db.prepare('UPDATE api_cloud_runs SET outcome=?,finished_at=?,response_id=?,response_json=?,usage_json=?,stream_digest=? WHERE project=? AND task=? AND attempt=?').bind(terminal.status==='completed'?'completed':'rejected',now(),terminal.id||null,responseJSON,terminal.usage?JSON.stringify(terminal.usage):null,await digest(allRaw),...ids).run();saved=true;
  await reader.cancel().catch(()=>{});
  return {value:cloudResponseJSON(terminal),response:terminal,reused:false};
 }catch(error){
  if(saved)throw error;
  await flush().catch(()=>{});
  await db.prepare("UPDATE api_cloud_runs SET outcome='unknown',finished_at=?,failure_code=? WHERE project=? AND task=? AND attempt=?").bind(now(),claimLost?'claim_lost':'incomplete_or_interrupted',...ids).run().catch(()=>{});
  throw problem('API连接中断或结果未保存完整，计费待核对，未自动重试',{outcomeUnknown:true});
 }finally{clearTimeout(timeout);if(beat)clearInterval(beat);}
}
