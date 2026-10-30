import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runOpenAI,responseJSON,configureAPIProxy} from './lib/openai-responses.mjs';
import {createServer} from 'node:http';
const schema={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
async function fixture(fn){const root=await mkdtemp(path.join(process.env.TEMP||os.tmpdir(),'series-api-'));try{const credentialFile=path.join(root,'key.env');await writeFile(credentialFile,'OPENAI_API_KEY=sk-fixture-not-real\n');await fn({directory:path.join(root,'job'),project:'fixture',task:'question',config:{credentialFile,usageDirectory:path.join(root,'usage')},instructions:'Only answer the supplied question',input:'fixture',schema});}finally{await rm(root,{recursive:true,force:true});}}
const completed=()=>({id:'resp_fixture',model:'gpt-6.1-sol',status:'completed',usage:{input_tokens:10,output_tokens:2},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"answer":"原文解释"}'}]}]});
test('structured response, tool isolation, durable reuse, usage and changed-input protection',()=>fixture(async options=>{let calls=0;const fetchImpl=async(url,request)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(request.body);assert.equal(body.store,false);assert.equal(body.tools,undefined);assert.equal(body.text.format.strict,true);assert.equal(request.redirect,'error');return Response.json(completed());};const first=await runOpenAI({...options,fetchImpl});assert.equal(first.value.answer,'原文解释');assert.equal((await runOpenAI({...options,fetchImpl})).reused,true);assert.equal(calls,1);assert.equal((await readdir(options.config.usageDirectory)).length,1);await assert.rejects(runOpenAI({...options,input:'changed',fetchImpl}),/输入发生变化/);assert.equal(calls,1);}));
test('unknown transport result and server error cannot trigger a second paid POST',async()=>{for(const serverError of [false,true])await fixture(async options=>{let calls=0;const fetchImpl=async()=>{calls++;if(serverError)return Response.json({error:{code:'server_error'}},{status:500});throw Error('socket failed');};await assert.rejects(runOpenAI({...options,fetchImpl}));await assert.rejects(runOpenAI({...options,fetchImpl}));assert.equal(calls,1);});});
test('a confirmed 4xx rejection may run on the next explicit invocation',()=>fixture(async options=>{let calls=0;const fetchImpl=async()=>++calls===1?Response.json({error:{code:'rate_limit_exceeded'}},{status:429}):Response.json(completed());await assert.rejects(runOpenAI({...options,fetchImpl}),/429/);assert.equal((await runOpenAI({...options,fetchImpl})).value.answer,'原文解释');assert.equal(calls,2);}));
test('refused and incomplete results never masquerade as a teaching answer',()=>{assert.throws(()=>responseJSON({...completed(),status:'incomplete'}),/未完成/);assert.throws(()=>responseJSON({...completed(),output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'no'}]}]}),/未提供/);});
test('a runner configuring its proxy after Node and fetch startup actually routes requests through it',async()=>{
 const seen=[],server=createServer((request,response)=>{seen.push(request.url);response.setHeader('content-type','application/json');response.end('{"ok":true}');});
 server.on('connect',(request,socket)=>{seen.push('CONNECT '+request.url);socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');server.emit('connection',socket);});
 const names=['HTTPS_PROXY','HTTP_PROXY','NO_PROXY','NODE_USE_ENV_PROXY'],before=Object.fromEntries(names.map(name=>[name,process.env[name]]));let restore;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const proxy='http://127.0.0.1:'+server.address().port;
  await (await fetch(proxy+'/warmup',{signal:AbortSignal.timeout(5000)})).text();
  restore=configureAPIProxy({proxyUrl:proxy});
  const target='http://127.0.0.2:65530/proxy-regression';
  assert.equal((await (await fetch(target,{signal:AbortSignal.timeout(5000)})).json()).ok,true);
  assert(seen.includes(target)||seen.includes('CONNECT 127.0.0.2:65530'),'changing environment variables alone does not reconfigure an initialized fetch dispatcher');
 }finally{restore?.();for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
