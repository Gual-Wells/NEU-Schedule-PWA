// Shared wire contract used by the three series runners. No business or publisher authority.
import {readFile,mkdir,writeFile,rename,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setGlobalProxyFromEnv} from 'node:http';
import {readAPIResponse} from './openai-stream.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const unknown=message=>Object.assign(Error(message),{outcomeUnknown:true});
export async function loadOpenAIKey(config={}){
 const value=process.env.OPENAI_API_KEY||await readFile(config.credentialFile,'utf8').then(text=>text.match(/^\s*OPENAI_API_KEY\s*=\s*(sk-[A-Za-z0-9_-]+)\s*$/m)?.[1]).catch(()=>null);
 if(typeof value!=='string'||!/^sk-[A-Za-z0-9_-]+$/.test(value))throw Error('OpenAI服务密钥尚未配置');
 return value;
}
export function configureAPIProxy(config={}){
 if(config.proxyUrl){const url=new URL(config.proxyUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)throw Error('本机API代理配置无效');process.env.HTTPS_PROXY=url.href;process.env.HTTP_PROXY=url.href;process.env.NO_PROXY='localhost,127.0.0.1';process.env.NODE_USE_ENV_PROXY='1';return setGlobalProxyFromEnv({http_proxy:url.href,https_proxy:url.href,no_proxy:'localhost,127.0.0.1'});}
}
export function responseJSON(response){
 if(response?.status!=='completed')throw Error('模型未完成，原始返回已保存，请核对后处理');
 const parts=(response.output||[]).filter(item=>item.type==='message'&&item.role==='assistant').flatMap(item=>item.content||[]);
 if(parts.some(item=>item.type==='refusal'))throw Error('模型未提供本次回答，原始返回已保存');
 const text=parts.filter(item=>item.type==='output_text').map(item=>item.text).join('');
 try{return JSON.parse(text);}catch{throw Error('模型返回格式无效，原始返回已保存');}
}
async function atomic(file,value){const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temporary,file);}
export async function runOpenAI({config,directory,project,task,instructions,input,schema,name='task_result',fetchImpl=fetch}){
 const key=await loadOpenAIKey(config),model=config.model||'gpt-6.1-sol';
 if(!/^gpt-[a-z0-9.-]+$/.test(model)||!['none','low','medium','high','xhigh','max'].includes(config.reasoningEffort||'high'))throw Error('OpenAI模型配置无效');
 const body={model,store:false,reasoning:{effort:config.reasoningEffort||'high'},max_output_tokens:config.maxOutputTokens||16384,instructions,input,text:{format:{type:'json_schema',name,strict:true,schema}},stream:true};
 const bodyText=JSON.stringify(body),digest=sha(bodyText),base=path.join(directory,'openai');await mkdir(base,{recursive:true});
 const attempts=(await readdir(base)).filter(n=>/^\d{4}$/.test(n)).sort();
 for(const attempt of attempts){
  const previous=path.join(base,attempt),sent=JSON.parse(await readFile(path.join(previous,'request.json'),'utf8').catch(()=>'null'));
  if(!sent)throw unknown('上次API调用准备过程被中断，请核对后处理');
  if(sent.digest!==digest&&(!sent.body||sha(JSON.stringify({...sent.body,stream:true}))!==digest))throw Error('已发送任务的输入发生变化，停止重复收费');
  const saved=JSON.parse(await readFile(path.join(previous,'response.json'),'utf8').catch(()=>'null'));
  if(saved){if(saved.httpStatus>=400&&saved.httpStatus<500)continue;return {value:responseJSON(saved.response),response:saved.response,reused:true};}
  throw unknown('上次API调用结果尚未确认，禁止自动重复生成');
 }
 const attempt=String((Number(attempts.at(-1))||0)+1).padStart(4,'0'),target=path.join(base,attempt);await mkdir(target);
 // An exclusive durable marker precedes the only paid POST. A lost result never causes another POST.
 const marker=await open(path.join(target,'request.json'),'wx',0o600);await marker.writeFile(JSON.stringify({digest,project,task,model,startedAt:new Date().toISOString(),body}));await marker.sync();await marker.close();
 let response,savedResponse=false;const started=performance.now();let phase='waiting_for_headers',headersMs=null,firstEventMs=null,eventCount=0;
 try{
  response=await fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:bodyText,signal:AbortSignal.timeout(config.timeoutMs||600000)});
  headersMs=Math.round(performance.now()-started);await atomic(path.join(target,'headers.json'),{httpStatus:response.status,requestId:response.headers.get('x-request-id'),headersMs,receivedAt:new Date().toISOString()});
  phase='reading_response';const {parsed,raw}=await readAPIResponse(response,target,()=>{eventCount++;firstEventMs??=Math.round(performance.now()-started);});
  const saved={httpStatus:response.status,requestId:response.headers.get('x-request-id'),headersMs,firstEventMs,eventCount,elapsedMs:Math.round(performance.now()-started),receivedAt:new Date().toISOString(),response:parsed,raw};await atomic(path.join(target,'response.json'),saved);savedResponse=true;
  if(parsed?.usage&&config.usageDirectory){
   await mkdir(config.usageDirectory,{recursive:true});const record={project,task,model:parsed.model||model,responseId:parsed.id,requestId:saved.requestId,receivedAt:saved.receivedAt,usage:parsed.usage};
   await atomic(path.join(config.usageDirectory,sha(project+':'+(parsed.id||digest))+'.json'),record);
  }
  if(!response.ok)throw Error(`OpenAI请求未完成（HTTP ${response.status}${parsed?.error?.code?', '+String(parsed.error.code).replace(/[^a-z0-9_-]/gi,''):''}），没有自动重试`);
  return {value:responseJSON(parsed),response:parsed,reused:false};
 }catch(error){
  const causeCodes=[error?.code,error?.cause?.code,...(error?.cause?.errors||[]).map(e=>e.code)].filter(code=>typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code));
  const outcomeUnknown=!response||response.status>=500||(response.ok&&!savedResponse);
  await atomic(path.join(target,'failure.json'),{at:new Date().toISOString(),httpStatus:response?.status??null,errorType:error?.name||'Error',causeCodes,phase,headersMs,firstEventMs,eventCount,elapsedMs:Math.round(performance.now()-started),outcomeUnknown});
  // No raw network errors: exception messages can contain headers or request bodies.
  if(outcomeUnknown)throw unknown('OpenAI连接中断或返回不完整，计费结果待核对，未自动重试');
  if(response.status>=500)error.outcomeUnknown=true;
  throw error;
 }
}
