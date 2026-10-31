// Completed API evidence remains immutable. Failed archival never changes the durable D1 original.
export const CLOUD_EVIDENCE_FORMAT='second-series-api-evidence-v1';
const MAX_BYTES=24*1024*1024,MAX_STREAM_BYTES=2*1024*1024,MAX_RESPONSE_BYTES=1500000;
// JSON can expand one control byte to six ASCII bytes; this contains every valid wire receipt.
const MAX_EXPANDED_BYTES=MAX_STREAM_BYTES*6+MAX_RESPONSE_BYTES+1024;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const digestOf=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const unavailable=()=>Object.assign(Error('已保存的API原件暂不可用，未重复调用'),{protectedUnavailable:true,archiveUnavailable:true,outcomeUnknown:true});
const bytesOf=value=>value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):null;
const sameBytes=(left,right)=>left.byteLength===right.byteLength&&left.every((value,index)=>value===right[index]);
const changes=value=>Number(value?.meta?.changes??value?.changes??0);

async function transformed(bytes,decompress=false){
 const stream=new Blob([bytes]).stream().pipeThrough(decompress?new DecompressionStream('gzip'):new CompressionStream('gzip'));
 const reader=stream.getReader(),parts=[];let length=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>(decompress?MAX_EXPANDED_BYTES:MAX_BYTES))throw unavailable();parts.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const result=new Uint8Array(length);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.byteLength;}return result;
}
function boundedEvidence(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='format,rawStream,response'||value.format!==CLOUD_EVIDENCE_FORMAT||value.response?.status!=='completed'||typeof value.rawStream!=='string'||encoder.encode(value.rawStream).byteLength>MAX_STREAM_BYTES||encoder.encode(JSON.stringify(value.response)).byteLength>MAX_RESPONSE_BYTES)throw unavailable();
 return value;
}
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
const validResponseId=value=>value===null||typeof value==='string'&&value.length>0&&value.length<=256;
const archiveKeys='rawStream,responseId,responseJSON,streamDigest',readKeys='digest,responseId,streamDigest';
function archiveRequest(request){
 if(!exact(request,archiveKeys)||typeof request.responseJSON!=='string'||typeof request.rawStream!=='string'||!validDigest(request.streamDigest)||!validResponseId(request.responseId)||encoder.encode(request.responseJSON).byteLength>MAX_RESPONSE_BYTES||encoder.encode(request.rawStream).byteLength>MAX_STREAM_BYTES)throw unavailable();
 const response=JSON.parse(request.responseJSON);if(response?.status!=='completed'||(response.id||null)!==request.responseId)throw unavailable();return response;
}
function readRequest(request){if(!exact(request,readKeys)||!validDigest(request.digest)||!validDigest(request.streamDigest)||!validResponseId(request.responseId))throw unavailable();}

// Heavy codec and verified object I/O. The file gateway calls these only inside
// its project-scoped SQLite Durable Object, whose CPU allowance fits compression.
export async function archiveCloudEvidenceFile({filesBinding,request}){
 try{
  const response=archiveRequest(request);
  if(await digestOf(encoder.encode(request.rawStream))!==request.streamDigest)throw unavailable();
  const evidence=boundedEvidence({format:CLOUD_EVIDENCE_FORMAT,response,rawStream:request.rawStream});
  const source=encoder.encode(JSON.stringify(evidence));if(source.byteLength>MAX_EXPANDED_BYTES||source.byteLength>MAX_BYTES)throw unavailable();
  const bytes=await transformed(source),digest=await digestOf(bytes),receipt=await filesBinding.put(bytes,'application/gzip');
  if(receipt?.digest!==digest||receipt.bytes!==bytes.byteLength)throw unavailable();
  const found=await filesBinding.get(digest),readback=bytesOf(found?.bytes);
  if(found?.digest!==digest||!readback||readback.byteLength>MAX_BYTES||!sameBytes(bytes,readback)||await digestOf(readback)!==digest)throw unavailable();
  return{archiveFormat:CLOUD_EVIDENCE_FORMAT,verified:true,digest,streamDigest:request.streamDigest,responseId:request.responseId,responseDigest:await digestOf(encoder.encode(request.responseJSON)),bytes:bytes.byteLength};
 }catch{throw unavailable();}
}
export async function readCloudEvidenceFile({filesBinding,request}){
 try{
  readRequest(request);const found=await filesBinding.get(request.digest),bytes=bytesOf(found?.bytes);
  if(found?.digest!==request.digest||!bytes||bytes.byteLength>MAX_BYTES||await digestOf(bytes)!==request.digest)throw unavailable();
  const evidence=boundedEvidence(JSON.parse(decoder.decode(await transformed(bytes,true))));
  if(await digestOf(encoder.encode(evidence.rawStream))!==request.streamDigest||(evidence.response.id||null)!==request.responseId)throw unavailable();
  return{archiveFormat:CLOUD_EVIDENCE_FORMAT,verified:true,digest:request.digest,streamDigest:request.streamDigest,responseId:request.responseId,responseDigest:await digestOf(encoder.encode(JSON.stringify(evidence.response))),response:evidence.response};
 }catch{throw unavailable();}
}

export async function readCloudEvidenceResponse({storedJSON,filesBinding,streamDigest=null,responseId=null}){
 try{
  const value=JSON.parse(storedJSON);
  if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
  if(!Object.hasOwn(value,'archiveFormat'))return value;
  if(Object.keys(value).sort().join(',')!=='archiveFormat,digest'||value.archiveFormat!==CLOUD_EVIDENCE_FORMAT||!validDigest(value.digest)||!validDigest(streamDigest)||!validResponseId(responseId)||typeof filesBinding?.readEvidence!=='function')throw unavailable();
  const receipt=await filesBinding.readEvidence({digest:value.digest,streamDigest,responseId});
  if(!exact(receipt,'archiveFormat,digest,response,responseDigest,responseId,streamDigest,verified')||receipt.archiveFormat!==CLOUD_EVIDENCE_FORMAT||receipt.verified!==true||receipt.digest!==value.digest||receipt.streamDigest!==streamDigest||receipt.responseId!==responseId||!validDigest(receipt.responseDigest)||receipt.response?.status!=='completed'||(receipt.response.id||null)!==responseId)throw unavailable();
  const responseJSON=encoder.encode(JSON.stringify(receipt.response));if(responseJSON.byteLength>MAX_RESPONSE_BYTES||await digestOf(responseJSON)!==receipt.responseDigest)throw unavailable();
  return receipt.response;
 }catch{throw unavailable();}
}

export async function archiveCloudEvidence({db,filesBinding,project,task,attempt,response,responseJSON,rawStream,runKey,streamDigest,responseId=response?.id||null}){
 try{
  if(typeof filesBinding?.archiveEvidence!=='function'||typeof db?.batch!=='function')return{archived:false,reason:'not-configured'};
  if(typeof responseJSON!=='string'||responseJSON.length>MAX_RESPONSE_BYTES||typeof rawStream!=='string'||rawStream.length>MAX_STREAM_BYTES||!validDigest(runKey)||!validDigest(streamDigest)||!validResponseId(responseId))throw unavailable();
  const expectedResponseDigest=await digestOf(encoder.encode(responseJSON));
  const receipt=await filesBinding.archiveEvidence({responseJSON,rawStream,streamDigest,responseId});
  if(!exact(receipt,'archiveFormat,bytes,digest,responseDigest,responseId,streamDigest,verified')||receipt.archiveFormat!==CLOUD_EVIDENCE_FORMAT||receipt.verified!==true||!validDigest(receipt.digest)||receipt.streamDigest!==streamDigest||receipt.responseId!==responseId||receipt.responseDigest!==expectedResponseDigest||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<1||receipt.bytes>MAX_BYTES)throw unavailable();
  const digest=receipt.digest;
  const pointer=JSON.stringify({archiveFormat:CLOUD_EVIDENCE_FORMAT,digest}),ids=[project,task,String(attempt)];
  // The batch is one transaction. changes() is the immediately preceding guarded UPDATE,
  // so a concurrent pointer replacement cannot authorize deletion of unowned stream rows.
  const result=await db.batch([
   db.prepare("UPDATE api_cloud_runs SET response_json=? WHERE project=? AND task=? AND attempt=? AND outcome='completed' AND response_json=?").bind(pointer,...ids,responseJSON),
   db.prepare("DELETE FROM api_cloud_streams WHERE run_key=? AND changes()=1 AND EXISTS(SELECT 1 FROM api_cloud_runs WHERE project=? AND task=? AND attempt=? AND outcome='completed' AND response_json=?)").bind(runKey,...ids,pointer)
  ]);
  return changes(result?.[0])===1?{archived:true,digest}:{archived:false,reason:'changed'};
 }catch{return{archived:false,reason:'unavailable'};}
}
