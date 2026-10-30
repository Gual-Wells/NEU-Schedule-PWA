// OpenAI Responses SSE transport. Framing is delegated to the pinned MIT parser.
import {open} from 'node:fs/promises';
import path from 'node:path';
import {createParser} from './vendor/eventsource-parser/parse.js';
const incomplete=()=>Object.assign(Error('API流式结果不完整，已保留原件，未自动重试'),{outcomeUnknown:true});
export async function readAPIResponse(response,directory,onEvent=()=>{}){
 if(!response.ok||!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')){
  const raw=await response.text();let parsed;try{parsed=JSON.parse(raw);}catch{parsed=null;}return {parsed,raw:parsed?undefined:raw};
 }
 const file=await open(path.join(directory,'stream.sse'),'wx',0o600),decoder=new TextDecoder();let terminal=null,total=0;
 const parser=createParser({maxBufferSize:8*1024*1024,onError(){throw incomplete();},onEvent({data}){
  if(data==='[DONE]')return;
  let event;try{event=JSON.parse(data);}catch{throw incomplete();}
  onEvent(event);
  if(['response.completed','response.failed','response.incomplete'].includes(event.type)&&event.response&&typeof event.response==='object')terminal=event.response;
  if(event.type==='error')throw incomplete();
 }});
 try{
  for await(const chunk of response.body){
   total+=chunk.byteLength;if(total>32*1024*1024)throw incomplete();
   await file.write(chunk);parser.feed(decoder.decode(chunk,{stream:true}));
   if(terminal){await file.sync();return {parsed:terminal};}
  }
  parser.feed(decoder.decode());
  if(terminal){await file.sync();return {parsed:terminal};}
  throw incomplete();
 }finally{await file.close();}
}
