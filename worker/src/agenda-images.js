import { MAX_IMAGE, CHUNK, idOK, json, hash, body, input, enc } from './agenda-wire.js';
const DAY=86400000;
export async function importViews(env,rows) {
  if(!rows.length)return [];
  const {results}=await env.DB.prepare('SELECT * FROM agenda_import_images WHERE import_id IN (SELECT value FROM json_each(?)) ORDER BY position').bind(JSON.stringify(rows.map(row=>row.id))).all();
  const [feedback,linked]=await Promise.all([
    env.DB.prepare('SELECT id,import_id,text,created_at FROM agenda_feedback WHERE import_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,rowid').bind(JSON.stringify(rows.map(row=>row.id))).all(),
    env.DB.prepare('SELECT id,source_import_id FROM agenda_items WHERE source_import_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(rows.map(row=>row.id))).all()
  ]);
  return rows.map(row=>({...importView(row,results.filter(image=>image.import_id===row.id)),
    feedback:feedback.results.filter(f=>f.import_id===row.id).map(f=>({id:f.id,text:f.text,createdAt:f.created_at})),
    linkedItemIds:linked.results.filter(v=>v.source_import_id===row.id).map(v=>v.id)}));
}
function importView(row,images=[]) {
  const attached=row.image_protocol===2?images:[{id:'legacy',position:1,mime:row.mime,digest:row.digest,byte_length:row.byte_length,received_at:row.created_at}];
  return {id:row.id,extractionProtocol:row.extraction_protocol,protocol:row.image_protocol||1,status:row.status,uploadState:row.upload_state||'ready',revision:row.revision,note:row.note,referenceAt:row.reference_at,
    createdAt:row.created_at,expiresAt:row.expires_at,error:row.error,result:row.result_json?JSON.parse(row.result_json):null,
    images:attached.map(image=>({id:image.id,position:image.position,digest:image.digest,mime:image.mime,byteLength:image.byte_length,receivedAt:image.received_at,
      url:row.image_protocol===2?'/imports/'+row.id+'/images/'+image.id:'/imports/'+row.id+'/image'}))};
}
export async function importDetail(env,id) {
  const row=await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(id).first();
  return row?(await importViews(env,[row]))[0]:null;
}
export async function createBatch(request,env) {
  const value=await input(request), now=Date.now();
  if(value.protocol!==2||!idOK(value.nonce)||typeof value.note!=='string'||value.note.length>800||!Array.isArray(value.images)||!value.images.length||value.images.length>8)throw Error('每批请选择 1 至 8 张图片');
  const images=value.images.map((image,index)=>{
    if(!idOK(image.id)||image.id==='legacy'||! /^[a-f0-9]{64}$/.test(image.digest)||!['image/jpeg','image/png','image/webp'].includes(image.mime)||!Number.isSafeInteger(image.byteLength)||image.byteLength<1||image.byteLength>MAX_IMAGE)throw Error('图片清单无效');
    return {id:image.id,position:index+1,digest:image.digest,mime:image.mime,byteLength:image.byteLength};
  });
  if(new Set(images.map(image=>image.id)).size!==images.length||new Set(images.map(image=>image.digest)).size!==images.length)throw Error('图片重复，请移除重复图片');
  const total=images.reduce((sum,image)=>sum+image.byteLength,0);
  if(total>20*1024*1024)throw Error('每批图片压缩后合计不能超过 20 MB');
  const digest=await hash(enc.encode(JSON.stringify({images,note:value.note})));
  const previous=await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(value.nonce).first();
  if(previous)return previous.image_protocol===2&&previous.digest===digest?json(await importDetail(env,previous.id)):json({error:'上传编号已被使用'},409);
  const id=crypto.randomUUID(),commands=[env.DB.prepare("INSERT INTO agenda_imports(id,client_nonce,status,digest,mime,byte_length,note,reference_at,expires_at,created_at,updated_at,image_protocol,upload_state) VALUES(?,?,'queued',?,'application/x-agenda-bundle',?,?,?,?,?,?,2,'draft')")
    .bind(id,value.nonce,digest,total,value.note,now,now+3*DAY,now,now)];
  for(const image of images)commands.push(env.DB.prepare('INSERT INTO agenda_import_images(id,import_id,position,digest,mime,byte_length) VALUES(?,?,?,?,?,?)').bind(image.id,id,image.position,image.digest,image.mime,image.byteLength));
  commands.push(env.DB.prepare('UPDATE agenda_imports SET extraction_protocol=3,processing_deadline=expires_at WHERE id=?').bind(id));
  try{await env.DB.batch(commands);}catch{
    const replay=await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(value.nonce).first();
    if(replay?.image_protocol===2&&replay.digest===digest)return json(await importDetail(env,replay.id));
    return json({error:'图片队列或存量已满，请清理待处理图片后重试'},409);
  }
  return json(await importDetail(env,id));
}
export async function uploadBatchImage(request,env,id,imageId) {
  const parent=await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=? AND image_protocol=2').bind(id).first();
  if(!parent||parent.status==='cancelled'||parent.expires_at<=Date.now())return json({error:'上传已取消或过期'},409);
  const image=await env.DB.prepare('SELECT * FROM agenda_import_images WHERE id=? AND import_id=?').bind(imageId,id).first();
  if(!image)return json({error:'图片不在本批次清单中'},404);
  const bytes=await body(request,MAX_IMAGE),mime=imageMime(bytes);
  imageDimensions(bytes,mime);
  if(bytes.length!==image.byte_length||mime!==image.mime||await hash(bytes)!==image.digest)throw Error('图片与提交清单不一致，请重新选择图片');
  if(image.received_at!==null)return json({received:true});
  if(parent.status!=='queued'||parent.upload_state!=='draft')return json({error:'本批次已提交识别'},409);
  const at=Date.now(),guard=crypto.randomUUID(),commands=[env.DB.prepare('INSERT INTO agenda_image_upload_guards VALUES(?,?,?,?)').bind(guard,id,imageId,at)];
  for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++)commands.push(env.DB.prepare('INSERT INTO agenda_image_chunks VALUES(?,?,?)').bind(imageId,index,bytes.slice(offset,offset+CHUNK).buffer));
  commands.push(env.DB.prepare('UPDATE agenda_import_images SET received_at=? WHERE id=?').bind(at,imageId),env.DB.prepare('DELETE FROM agenda_image_upload_guards WHERE id=?').bind(guard));
  try{await env.DB.batch(commands);}catch{
    const replay=await env.DB.prepare("SELECT i.received_at FROM agenda_import_images i JOIN agenda_imports p ON p.id=i.import_id WHERE i.id=? AND p.id=? AND p.status<>'cancelled' AND p.expires_at>?").bind(imageId,id,Date.now()).first();
    if(replay?.received_at)return json({received:true});
    return json({error:'上传已取消、过期或正在其他设备更新'},409);
  }
  return json({received:true});
}
export async function submitBatch(env,id) {
  await env.DB.prepare("UPDATE agenda_imports SET upload_state='ready',revision=revision+1,updated_at=? WHERE id=? AND image_protocol=2 AND status='queued' AND upload_state='draft' AND expires_at>? AND EXISTS(SELECT 1 FROM agenda_import_images WHERE import_id=?) AND NOT EXISTS(SELECT 1 FROM agenda_import_images WHERE import_id=? AND received_at IS NULL)")
    .bind(Date.now(),id,Date.now(),id,id).run();
  const row=await importDetail(env,id);
  if(!row||row.protocol!==2||row.status==='cancelled'||row.expiresAt<=Date.now())return json({error:'本批次已取消或过期'},409);
  if(row.uploadState!=='ready')return json({error:'还有图片未上传完成，请继续补传',images:row.images},409);
  return json(row);
}
function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  throw Error('只支持 PNG、JPEG 或 WebP 图片');
}

function imageDimensions(bytes, mime) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let width=0,height=0;
  if(mime==='image/png' && bytes.length>=24) {width=view.getUint32(16);height=view.getUint32(20);}
  if(mime==='image/jpeg') {
    for(let p=2;p+9<bytes.length;) {
      if(bytes[p++]!==255)break;
      let marker=bytes[p++];while(marker===255)marker=bytes[p++];
      if(marker===0xd9||marker===0xda)break;
      const length=view.getUint16(p);if(length<2||p+length>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {height=view.getUint16(p+3);width=view.getUint16(p+5);break;}
      p+=length;
    }
  }
  if(mime==='image/webp'&&bytes.length>=30) {
    const kind=new TextDecoder().decode(bytes.slice(12,16));
    if(kind==='VP8X') {width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);}
    if(kind==='VP8 ') {width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}
    if(kind==='VP8L') {const bits=view.getUint32(21,true);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  }
  if(!width||!height||width*height>16*1024*1024)throw Error('图片无效或超过 1600 万像素');
}

export async function legacyUpload(request, env, url) {
  const nonce = url.searchParams.get('nonce'), note = url.searchParams.get('note') || '';
  if (!idOK(nonce) || note.length > 800) throw Error('上传编号或补充说明无效');
  const bytes = await body(request, MAX_IMAGE), mime = imageMime(bytes), digest = await hash(bytes);
  imageDimensions(bytes,mime);
  const previous = await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(nonce).first();
  if (previous) return previous.digest === digest ? json(importView(previous)) : json({ error: '上传编号已被使用' }, 409);
  const now = Date.now(), id = crypto.randomUUID();
  const commands = [env.DB.prepare("INSERT INTO agenda_imports(id,client_nonce,status,digest,mime,byte_length,note,reference_at,expires_at,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?,?,?,?,?)")
    .bind(id, nonce, digest, mime, bytes.length, note, now, now + 3 * DAY, now, now)];
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index++) commands.push(env.DB.prepare('INSERT INTO agenda_import_chunks VALUES(?,?,?)').bind(id, index, bytes.slice(offset, offset + CHUNK).buffer));
  commands.push(env.DB.prepare('UPDATE agenda_imports SET extraction_protocol=3,processing_deadline=expires_at WHERE id=?').bind(id));
  try { await env.DB.batch(commands); }
  catch (error) {
    const replay = await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(nonce).first();
    if (replay?.digest === digest) return json(importView(replay));
    return json({ error: '图片队列已满，请稍后重试或清理待处理图片' }, 409);
  }
  return json(importView(await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(id).first()));
}

async function storedImage(env,row) {
  const {results}=await env.DB.prepare('SELECT content FROM agenda_import_chunks WHERE import_id=? ORDER BY chunk_index').bind(row.id).all();
  const bytes=new Uint8Array(row.byte_length);let offset=0;
  for(const part of results){const b=new Uint8Array(part.content);bytes.set(b,offset);offset+=b.length;}
  if(offset!==bytes.length||await hash(bytes)!==row.digest)throw Error('图片完整性检查失败');
  return new Response(bytes,{headers:{'content-type':row.mime,'cache-control':'no-store','x-content-type-options':'nosniff'}});
}

export async function imageResponse(env,parent,imageId) {
  if(parent.image_protocol!==2) {
    if(imageId&&imageId!=='legacy')return json({error:'未找到图片'},404);
    return storedImage(env,parent);
  }
  const image= imageId?await env.DB.prepare('SELECT * FROM agenda_import_images WHERE id=? AND import_id=?').bind(imageId,parent.id).first():
    await env.DB.prepare('SELECT * FROM agenda_import_images WHERE import_id=? ORDER BY position LIMIT 1').bind(parent.id).first();
  if(!image||image.received_at===null)return json({error:'图片尚未上传'},404);
  const {results}=await env.DB.prepare('SELECT content FROM agenda_image_chunks WHERE image_id=? ORDER BY chunk_index').bind(image.id).all();
  const bytes=new Uint8Array(image.byte_length);let offset=0;
  for(const part of results){const b=new Uint8Array(part.content);bytes.set(b,offset);offset+=b.length;}
  if(offset!==bytes.length||await hash(bytes)!==image.digest)throw Error('图片完整性检查失败');
  return new Response(bytes,{headers:{'content-type':image.mime,'cache-control':'no-store','x-content-type-options':'nosniff'}});
}

