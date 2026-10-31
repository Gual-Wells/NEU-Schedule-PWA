import '../../agenda-core.js';
import { sessionFor } from './auth.js';
import { feedback } from './agenda-review.js';
import { viewItem,applicationItems,recognitionContext,validateRelation } from './agenda-context.js';
import { idOK, json, hash, input, enc } from './agenda-wire.js';
import { legacyUpload, imageResponse, importViews, importDetail, createBatch, uploadBatchImage, submitBatch } from './agenda-images.js';

const A = globalThis.ScheduleAgenda;
const item=viewItem;
export async function agendaSnapshot(env) {
  const [rows, imports, digests, meta,sources] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items ORDER BY anchor_at').all(),
    env.DB.prepare('SELECT * FROM agenda_imports ORDER BY created_at DESC LIMIT 30').all(),
    env.DB.prepare('SELECT * FROM agenda_digests ORDER BY slot_at DESC LIMIT 14').all(),
    env.DB.prepare('SELECT revision FROM agenda_meta WHERE id=1').first(),
    env.DB.prepare('SELECT * FROM agenda_item_sources ORDER BY applied_at').all()
  ]);
  return { protocol: 1, items: rows.results.map(row=>({...item(row),sources:sources.results.filter(v=>v.item_id===row.id).map(v=>({importId:v.import_id,sourceImages:JSON.parse(v.source_images)}))})), imports: await importViews(env,imports.results),
    digests: digests.results.map(d => ({ id: d.id, slotAt: d.slot_at, entries: JSON.parse(d.content_json) })), revision: meta.revision };
}

function insertion(env, id, value, source, key, now, sourceImages=[]) {
  return env.DB.prepare('INSERT INTO agenda_items(id,kind,title,anchor_at,explicit_end_at,location,evidence,source_import_id,source_item_key,created_at,updated_at,source_images,date_start,date_end,inference) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, value.kind, value.title, value.anchorAt, value.explicitEndAt, value.location, value.evidence, source, key, now, now,JSON.stringify(sourceImages),value.dateStart,value.dateEnd,value.inference);
}

async function commit(env, op) {
  if(op.protocol!==undefined && op.protocol!==1)return json({error:'协议版本不支持，请更新课表'},409);
  if (!idOK(op.id)) return json({ error: '操作编号无效' }, 400);
  const digest = await hash(enc.encode(JSON.stringify(op)));
  const receipt = await env.DB.prepare('SELECT * FROM agenda_operations WHERE id=?').bind(op.id).first();
  if (receipt) return receipt.request_hash === digest ? json({ ok: true, ...await agendaSnapshot(env) }) : json({ error: '操作编号已被使用' }, 409);
  const now = Date.now(), commands = [];
  if (op.type === 'create') {
    if (!Array.isArray(op.items) || op.items.length!==1) throw Error('每次只添加一份事项');
    const candidate=op.items[0];
    if(!idOK(candidate.key))throw Error('事项编号无效');
    commands.push(insertion(env,'a-'+op.id+'-0',A.normalizeItem(candidate,now),null,null,now));
  } else if(op.type==='apply') {
    if('items' in op)throw Error('识别结果只能整体确认；需要修改请提交反馈');
    if(!idOK(op.importId)||!Number.isInteger(op.revision))throw Error('导入版本无效');
    const row=await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(op.importId).first();
    if(!row||row.status!=='review'||row.revision!==op.revision)return json({error:'申请已更新，请刷新后确认'},409);
    const result=validateExtraction(JSON.parse(row.result_json),(await importDetail(env,row.id)).images.length,false,true,row.extraction_protocol>=4);
    if(result.intent==='analysis')return json({error:'图片解读不包含待入表事项'},409);
    const candidate=result.items[0];
    if(!candidate.localTime&&!candidate.dateStart)return json({error:'尚无法确定日期，请用反馈补充线索'},409);
    const value=A.generatedItem(candidate,now),context=JSON.parse(row.recognition_context||'[]');
    let canonical=row.canonical_id||row.id,targetSnapshot=context.find(v=>v.applicationId===(row.canonical_id||row.id))||null;
    if(result.relation?.type==='update'){
      const relation=validateRelation(result.relation,context);canonical=relation.targetImportId;
      targetSnapshot=context.find(v=>v.applicationId===canonical);
      if(row.canonical_id&&row.canonical_id!==canonical)return json({error:'本申请已归属另一事项，请刷新后反馈'},409);
    }
    const original=await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(canonical).first();
    if(!original||original.status==='cancelled')return json({error:'原申请已取消，请重新识别'},409);
    if(canonical!==row.id&&(!targetSnapshot||original.revision!==targetSnapshot.revision))return json({error:'原申请已更新，请反馈后重新生成合并结果'},409);
    const linked=await applicationItems(env,canonical);
    if(linked.length>1)return json({error:'旧申请包含多份事项，暂不能整体改写'},409);
    const target=linked[0];
    if(target&&(target.resolved_at!==null||target.cancelled_at!==null))return json({error:'事项已完成或取消，不能改写安排'},409);
    if(targetSnapshot&&(target?.id||null)!==(targetSnapshot.item?.id||null))return json({error:'原事项已变化，请重新识别'},409);
    if(targetSnapshot?.item&&target.revision!==targetSnapshot.item.revision)return json({error:'原事项已更新，请重新识别'},409);
    commands.push(env.DB.prepare('INSERT INTO agenda_review_guards VALUES(?,?,?,?,?,?)').bind(op.id,row.id,row.revision,'review',target?.id||null,target?.revision||null));
    if(canonical!==row.id)commands.push(env.DB.prepare('INSERT INTO agenda_review_guards VALUES(?,?,?,?,?,?)').bind(op.id+'-target',canonical,original.revision,original.status,target?.id||null,target?.revision||null));
    const itemId=target?.id||'a-'+op.id+'-0';
    if(target)commands.push(env.DB.prepare('UPDATE agenda_items SET kind=?,title=?,anchor_at=?,explicit_end_at=?,location=?,evidence=?,source_import_id=?,source_item_key=?,source_images=?,date_start=?,date_end=?,inference=?,revision=revision+1,updated_at=? WHERE id=?')
      .bind(value.kind,value.title,value.anchorAt,value.explicitEndAt,value.location,value.evidence,row.id,candidate.key,JSON.stringify(candidate.sourceImages),value.dateStart,value.dateEnd,value.inference,now,target.id));
    else commands.push(insertion(env,itemId,value,row.id,candidate.key,now,candidate.sourceImages),env.DB.prepare('INSERT INTO agenda_application_items VALUES(?,?)').bind(canonical,itemId));
    if(canonical!==row.id&&original.result_json){const previous=JSON.parse(original.result_json);if(previous.items?.length===1)commands.push(env.DB.prepare('INSERT OR IGNORE INTO agenda_item_sources VALUES(?,?,?,?)').bind(itemId,canonical,JSON.stringify(previous.items[0].sourceImages||[1]),original.updated_at));}
    commands.push(env.DB.prepare('INSERT INTO agenda_item_sources VALUES(?,?,?,?) ON CONFLICT(item_id,import_id) DO UPDATE SET source_images=excluded.source_images,applied_at=excluded.applied_at').bind(itemId,row.id,JSON.stringify(candidate.sourceImages),now));
    if(canonical!==row.id)commands.push(env.DB.prepare('UPDATE agenda_imports SET canonical_id=? WHERE id=?').bind(canonical,row.id));
    commands.push(env.DB.prepare("UPDATE agenda_imports SET status='applied',claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=? OR id=? OR canonical_id=?").bind(now,row.id,canonical,canonical));
  } else if (op.type === 'resolve' || op.type === 'cancel') {
    if (!idOK(op.itemId) || !Number.isSafeInteger(op.at) || op.at > now + 60000 || op.at < now - 31 * A.DAY) throw Error('完成时间无效');
    const row = await env.DB.prepare('SELECT * FROM agenda_items WHERE id=?').bind(op.itemId).first();
    if (!row) return json({ error: '未找到事项' }, 404);
    if (op.type === 'resolve' && row.kind === 'activity' && op.at < row.anchor_at) throw Error('活动尚未开始');
    if (op.type === 'cancel' && op.at >= A.windows(item(row)).from) throw Error('事项已经开始，请使用完成或结束');
    if(row.resolved_at===null&&row.cancelled_at===null)commands.push(env.DB.prepare('INSERT INTO agenda_item_operation_guards VALUES(?,?,?)').bind(op.id,row.id,row.revision));
    const field = op.type === 'resolve' ? 'resolved_at' : 'cancelled_at';
    commands.push(env.DB.prepare(`UPDATE agenda_items SET ${field}=?,revision=revision+1,updated_at=? WHERE id=? AND resolved_at IS NULL AND cancelled_at IS NULL`).bind(op.at, now, row.id));
  } else throw Error('操作无效');
  // The receipt and all business changes commit in one transaction. Replays never recreate items.
  commands.unshift(env.DB.prepare('INSERT INTO agenda_operations VALUES(?,?,?,?)').bind(op.id, digest, '{}', now));
  commands.push(env.DB.prepare('UPDATE devices SET plan_hash=NULL'));
  try { await env.DB.batch(commands); }
  catch (error) {
    const replay = await env.DB.prepare('SELECT request_hash FROM agenda_operations WHERE id=?').bind(op.id).first();
    if (!replay || replay.request_hash !== digest) return json({ error: '数据已变化，请刷新后重试' }, 409);
  }
  return json({ ok: true, ...await agendaSnapshot(env) });
}

export function validateExtraction(value,imageCount=1,requireSources=false,single=false,flex=false) {
  const analysis=value?.intent==='analysis';
  if (!value || (value.intent!==undefined&&!['agenda','analysis'].includes(value.intent)) || !Array.isArray(value.items) || value.items.length > 20 || (single&&!analysis&&value.items.length!==1) || typeof value.summary !== 'string' || value.summary.length > 2000) throw Error('识别结果格式无效');
  if(analysis&&(!flex||value.items.length!==0||typeof value.analysis!=='string'||!value.analysis.trim()||value.analysis.length>12000||value.relation?.type!=='new'||value.relation.targetImportId!==null||value.relation.targetItemId!==null))throw Error('图片解读格式无效');
  if(!analysis&&value.analysis!==undefined&&value.analysis!=='')throw Error('事项结果不应含独立解读');
  const seen = new Set();
  const items = value.items.map(v => {
    if (!idOK(v.key) || seen.has(v.key) || !['activity','deadline'].includes(v.kind) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 100) throw Error('识别事项无效');
    seen.add(v.key);
    for (const field of ['localTime','localEnd']) if (v[field] !== null) A.localTime(v[field]);
    if (v.kind === 'deadline' && v.localEnd !== null) throw Error('DDL 不应含活动结束时间');
    if (v.localTime && v.localEnd && A.localTime(v.localEnd) <= A.localTime(v.localTime)) throw Error('活动时间顺序无效');
    if (typeof v.location !== 'string' || v.location.length > 200 || typeof v.evidence !== 'string' || v.evidence.length > 1200 || typeof v.question !== 'string' || v.question.length > 800) throw Error('识别说明无效');
    const sourceImages=v.sourceImages??(requireSources?null:[1]);
    if(!Array.isArray(sourceImages)||!sourceImages.length||sourceImages.length>imageCount||new Set(sourceImages).size!==sourceImages.length||sourceImages.some(n=>!Number.isInteger(n)||n<1||n>imageCount))throw Error('识别结果的来源图片编号无效');
    if(v.dateStart){A.generatedItem(v);if(v.localTime!==null||v.localEnd!==null)throw Error('全天事项不能同时指定精确时刻');}
    else if(v.dateEnd)throw Error('全天事项缺少开始日期');
    const extra=flex||v.dateStart?{dateStart:v.dateStart||null,dateEnd:v.dateStart?(v.dateEnd||v.dateStart):null,inference:v.inference||''}:{};
    return { ...extra,key:v.key, kind:v.kind, title:v.title, localTime:v.localTime, localEnd:v.localEnd, location:v.location, evidence:v.evidence, question:v.question,sourceImages };
  });
  return { summary: value.summary, items,...(value.intent?{intent:value.intent,analysis:analysis?value.analysis:''}:{}),...(value.relation?{relation:value.relation}:{}) };
}

// Only a completed immutable cloud run may reach this internal recovery path.
// A lost lease can be recovered without the discarded plaintext claim.
export async function completeCloudAgendaResult(env,{id,generation,value}) {
  const row=await env.DB.prepare('SELECT p.*,(SELECT COUNT(*) FROM agenda_import_images i WHERE i.import_id=p.id) AS cloud_source_count FROM agenda_imports p WHERE p.id=?').bind(id).first();
  if(!row||row.execution_mode!=='cloud-v1'||row.generation!==generation||
    !(row.status==='running'||row.status==='failed'&&row.outcome_unknown===1))return false;
  const imageCount=row.image_protocol===2?row.cloud_source_count:1;let result;
  try {
    result=validateExtraction(value,imageCount,row.image_protocol===2,true,true);
    if(result.relation)result.relation=validateRelation(result.relation,JSON.parse(row.recognition_context||'[]'));
  } catch(error) {error.resultInvalid=true;throw error;}
  const now=Date.now(),text=JSON.stringify(result);
  const [written]=await env.DB.batch([
    env.DB.prepare("UPDATE agenda_imports SET status='review',result_json=?,outcome_unknown=0,error=NULL,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND generation=? AND revision=? AND execution_mode='cloud-v1' AND (status='running' OR (status='failed' AND outcome_unknown=1)) AND EXISTS(SELECT 1 FROM api_cloud_runs r WHERE r.project='second-schedule' AND r.task=agenda_imports.id AND r.attempt=CAST(agenda_imports.generation AS TEXT) AND r.outcome='completed')")
      .bind(text,now,id,generation,row.revision),
    env.DB.prepare("INSERT OR IGNORE INTO agenda_result_versions(import_id,generation,result_json,created_at) SELECT id,generation,result_json,? FROM agenda_imports WHERE id=? AND generation=? AND status='review' AND revision=? AND result_json=?")
      .bind(now,id,generation,row.revision+1,text)
  ]);
  return Boolean(written.meta.changes);
}

// The public runner always uses legacy. Only the scheduled module selects cloud-v1.
export async function claimAgendaJob(env, capabilities = {protocol:4}, executionMode = 'legacy') {
  if(!['legacy','cloud-v1'].includes(executionMode))throw Error('识别运行方式无效');
  if(capabilities.protocol!==undefined&&![1,2,3,4].includes(capabilities.protocol))throw Error('运行器协议版本不支持');
  if(capabilities.importId!==undefined&&!idOK(capabilities.importId))throw Error('申请编号无效');
  const now = Date.now();
    if(executionMode==='legacy')await cleanupAgenda(env, now);
    const row = await env.DB.prepare("SELECT * FROM agenda_imports WHERE status='queued' AND upload_state='ready' AND execution_mode=? AND outcome_unknown=0 AND processing_deadline>? AND (extraction_protocol<=?) AND (image_protocol=1 OR ?>=2) AND (? IS NULL OR id=?) ORDER BY updated_at,id LIMIT 1").bind(executionMode,now,capabilities.protocol||1,capabilities.protocol||1,capabilities.importId||null,capabilities.importId||null).first();
    if (!row) return null;
    const claim = crypto.randomUUID(),context=capabilities.protocol===4?await recognitionContext(env,row):[];
    const written = await env.DB.prepare("UPDATE agenda_imports SET status='running',extraction_protocol=?,recognition_context=?,generation=generation+1,claim_hash=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND status='queued' AND upload_state='ready' AND processing_deadline>? AND revision=?")
      .bind(capabilities.protocol===4?4:row.extraction_protocol,JSON.stringify(context),await hash(enc.encode(claim)), now + 5 * 60000, now, row.id, now,row.revision).run();
    if (!written.meta.changes) return null;
    const detail=(await importViews(env,[row]))[0];
    return { protocol:row.image_protocol,executionMode:row.execution_mode,extractionProtocol:capabilities.protocol===4?4:row.extraction_protocol,knownApplications:context,sourceCount:detail.images.length,sourceExpiresAt:row.expires_at,previousResult:detail.result,feedback:detail.feedback,id:row.id,claim,generation:row.generation+1,mime:row.mime,digest:row.digest,note:row.note,referenceAt:row.reference_at,
      images:(row.expires_at>now?detail.images:[]).map(image=>({...image,path:'/runner/image/'+row.id+'/'+image.id})) };
}

async function runner(request, env, url) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!env.AGENDA_RUNNER_KEY || !token || await hash(enc.encode(token)) !== await hash(enc.encode(env.AGENDA_RUNNER_KEY))) return json({ error: '未授权' }, 401);
  const now = Date.now();
  if (url.pathname === '/runner/claim' && request.method === 'POST') {
    const capabilities=await input(request);
    if(capabilities.protocol!==undefined&&![1,2,3,4].includes(capabilities.protocol))return json({error:'运行器协议版本不支持'},409);
    return json({job:await claimAgendaJob(env,capabilities,'legacy')});
  }
  const match = url.pathname.match(/^\/runner\/(image|heartbeat|result|fail)\/([A-Za-z0-9_-]{1,90})(?:\/([A-Za-z0-9_-]{1,90}))?$/);
  if (!match) return json({ error: '未找到接口' }, 404);
  const [, action, id,imageId] = match, claim = request.headers.get('x-agenda-claim') || '';
  if(imageId&&action!=='image')return json({error:'未找到接口'},404);
  const row = await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND status='running' AND claim_hash=? AND lease_until>? AND processing_deadline>?")
    .bind(id, await hash(enc.encode(claim)), now, now).first();
  if (!row) return json({ error: '任务认领已失效' }, 409);
  if (action === 'image' && request.method === 'GET') {
    return row.expires_at>now?imageResponse(env,row,imageId):json({error:'原图已过期'},410);
  }
  if (request.method !== 'POST') return json({ error: '未找到接口' }, 404);
  let sql, args;
  if (action === 'heartbeat') {
    sql = 'lease_until=?,updated_at=?'; args = [now + 5 * 60000, now];
  } else if (action === 'result') {
    const detail=await importDetail(env,row.id);
    const result = validateExtraction(await input(request),detail.images.length,row.image_protocol===2,row.extraction_protocol>=3,row.extraction_protocol>=4);
    if(result.relation)result.relation=validateRelation(result.relation,JSON.parse(row.recognition_context||'[]'));
    sql = "status='review',result_json=?,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=?"; args = [JSON.stringify(result), now];
  } else if (action === 'fail') {
    const failure=await input(request),unknown=failure.outcomeUnknown===true;
    sql = "status='failed',outcome_unknown=?,error=?,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=?"; args = [unknown?1:0,unknown?'API结果待核对，暂不重复识别。':'识别未完成，可对本申请提交反馈后重试。', now];
  } else return json({ error: '未找到接口' }, 404);
  const update=env.DB.prepare(`UPDATE agenda_imports SET ${sql} WHERE id=? AND status='running' AND revision=? AND claim_hash=? AND lease_until>? AND processing_deadline>?`)
    .bind(...args,id,row.revision,row.claim_hash,now,now);
  const statements=[update];
  if(action==='result')statements.push(env.DB.prepare("INSERT INTO agenda_result_versions(import_id,generation,result_json,created_at) SELECT id,generation,result_json,? FROM agenda_imports WHERE id=? AND status='review' AND revision=? AND result_json=?")
    .bind(now,id,row.revision+1,args[0]));
  const [written]=await env.DB.batch(statements);
  return written.meta.changes ? json({ok:true}) : json({error:'任务已取消或失效'},409);
}

export async function agendaRoute(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  try {
    if (url.pathname.startsWith('/runner/')) return await runner(request, env, url);
    if (!await sessionFor(request, env) || (request.method !== 'GET' && request.headers.get('origin') !== env.APP_ORIGIN)) return json({ error: '请先登录' }, 401);
    if (url.pathname === '/agenda' && request.method === 'GET') return json(await agendaSnapshot(env));
    if (url.pathname === '/agenda/commit' && request.method === 'POST') return await commit(env, await input(request));
    if (url.pathname === '/imports' && request.method === 'POST') return await legacyUpload(request, env, url);
    if(url.pathname==='/imports/batches'&&request.method==='POST')return await createBatch(request,env);
    const detail=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})$/);
    if(detail&&request.method==='GET'){const row=await importDetail(env,detail[1]);return row?json(row):json({error:'未找到导入'},404);}
    const attached=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/images\/([A-Za-z0-9_-]{1,90})$/);
    const source=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/source\/([1-8])$/);
    if(source&&request.method==='GET') {
      const row=await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND expires_at>? AND status<>'cancelled'").bind(source[1],Date.now()).first();
      if(!row)return json({error:'图片已过期或不存在'},410);
      const detail=await importDetail(env,row.id),image=detail.images.find(image=>image.position===Number(source[2]));
      return image?await imageResponse(env,row,image.id):json({error:'未找到图片'},404);
    }
    if(attached&&request.method==='POST')return await uploadBatchImage(request,env,attached[1],attached[2]);
    if(attached&&request.method==='GET'){
      const row=await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND expires_at>? AND status<>'cancelled'").bind(attached[1],Date.now()).first();
      return row?await imageResponse(env,row,attached[2]):json({error:'图片已过期或不存在，原文证据仍保留'},410);
    }
    const submit=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/submit$/);
    if(submit&&request.method==='POST')return await submitBatch(env,submit[1]);
    const image=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/image$/);
    if(image&&request.method==='GET') {
      const row=await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND expires_at>? AND status<>'cancelled'").bind(image[1],Date.now()).first();
      return row?imageResponse(env,row):json({error:'图片已过期或不存在，原文证据仍保留'},410);
    }
    const revision=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/feedback$/);
    if(revision&&request.method==='POST')return await feedback(request,env,revision[1]);
    const cancel = url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/cancel$/);
    if (cancel && request.method === 'POST') {
      if((await applicationItems(env,cancel[1])).length)return json({error:'此申请已关联事项，请从事项操作完成或取消'},409);
      const current=await env.DB.prepare('SELECT revision,status FROM agenda_imports WHERE id=?').bind(cancel[1]).first();
      if(!current)return json({error:'未找到申请'},404);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO agenda_review_guards VALUES(?,?,?,?,NULL,NULL)').bind(crypto.randomUUID(),cancel[1],current.revision,current.status),
        env.DB.prepare("UPDATE agenda_imports SET status='cancelled',claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('applied','cancelled')").bind(Date.now(), cancel[1]),
        env.DB.prepare('DELETE FROM agenda_import_chunks WHERE import_id=?').bind(cancel[1]),
        env.DB.prepare('DELETE FROM agenda_image_chunks WHERE image_id IN (SELECT id FROM agenda_import_images WHERE import_id=?)').bind(cancel[1])
      ]);
      return json({ ok: true });
    }
    return json({ error: '未找到接口' }, 404);
  } catch (error) { return json({ error: error.message || '请求无效' }, 400); }
}

export async function cleanupAgenda(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("UPDATE agenda_imports SET status='failed',outcome_unknown=CASE WHEN status='running' AND execution_mode='cloud-v1' THEN 1 ELSE outcome_unknown END,error=CASE WHEN status='running' AND execution_mode='cloud-v1' THEN 'API结果待核对，暂不重复识别。' ELSE '识别服务中断或图片已过期，请重新上传。' END,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE (status='running' AND lease_until<=?) OR (status='queued' AND (processing_deadline<=? OR ((upload_state='draft' OR result_json IS NULL) AND expires_at<=?)))").bind(now, now, now,now),
    env.DB.prepare('DELETE FROM agenda_import_chunks WHERE import_id IN (SELECT id FROM agenda_imports WHERE expires_at<=?)').bind(now),
    env.DB.prepare('DELETE FROM agenda_image_chunks WHERE image_id IN (SELECT i.id FROM agenda_import_images i JOIN agenda_imports p ON p.id=i.import_id WHERE p.expires_at<=?)').bind(now)
  ]);
}

export function digestNotice(entries) {
  const lines = A.digestText(entries).split('\n'); let text = '';
  for (const line of lines) {
    // Web Push encrypts the JSON payload; quotes and backslashes also consume the byte budget.
    if (enc.encode(JSON.stringify(text + (text ? '\n' : '') + line)).length > 2700) break;
    text += (text ? '\n' : '') + line;
  }
  if (text.split('\n').length < lines.length) text += `\n共 ${entries.length} 项，打开课表查看完整清单。`;
  return text;
}

export async function dispatchDigests(env, send, now = Date.now()) {
  // Catch up only the current slot's first 15 minutes. A stopped scheduler does not send yesterday's digest.
  const [start] = A.dayRange(A.dayKey(now));
  const slot = [start + 7*A.HOUR, start + 22*A.HOUR].find(at => at <= now && now < at + 15*60000);
  if (slot === undefined) return;
  const id = 'agenda-' + slot;
  const [rows, meetings] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items WHERE resolved_at IS NULL AND cancelled_at IS NULL').all(),
    env.DB.prepare('SELECT id,start_at,end_at,confirmed_at FROM group_meetings WHERE end_at IS NULL').all()
  ]);
  const entries = A.digest(rows.results.map(item), meetings.results.map(m => ({ id:m.id, startAt:m.start_at, endAt:m.end_at, confirmedAt:m.confirmed_at })), slot);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO agenda_digests VALUES(?,?,?,?)').bind(id, slot, JSON.stringify(entries), now),
    env.DB.prepare('INSERT OR IGNORE INTO agenda_digest_deliveries(digest_id,device_id) SELECT ?,id FROM devices WHERE created_at<=?').bind(id, slot)
  ]);
  const snapshot = await env.DB.prepare('SELECT content_json FROM agenda_digests WHERE id=?').bind(id).first();
  const bodyText = digestNotice(JSON.parse(snapshot.content_json));
  const { results } = await env.DB.prepare('SELECT x.*,d.endpoint,d.p256dh,d.auth FROM agenda_digest_deliveries x JOIN devices d ON d.id=x.device_id WHERE x.digest_id=? AND x.sent_at IS NULL AND x.attempts<4 AND (x.claim_at IS NULL OR x.claim_at<?) LIMIT 40').bind(id, now-120000).all();
  for (const row of results) {
    const claim = await env.DB.prepare('UPDATE agenda_digest_deliveries SET claim_at=?,attempts=attempts+1 WHERE digest_id=? AND device_id=? AND sent_at IS NULL AND (claim_at IS NULL OR claim_at<?)').bind(now, id, row.device_id, now-120000).run();
    if (!claim.meta.changes) continue;
    try {
      const delivered = await send(row, '未来三日 · DDL 与活动', bodyText, 3600, env, { url: (() => { const u=new URL(env.APP_URL);u.searchParams.set('agenda','digest');return u.href; })(), tag: id });
      if (delivered) await env.DB.prepare('UPDATE agenda_digest_deliveries SET sent_at=?,claim_at=NULL WHERE digest_id=? AND device_id=?').bind(now,id,row.device_id).run();
      else await env.DB.prepare('DELETE FROM devices WHERE id=?').bind(row.device_id).run();
    } catch { await env.DB.prepare('UPDATE agenda_digest_deliveries SET claim_at=NULL WHERE digest_id=? AND device_id=?').bind(id,row.device_id).run(); }
  }
}

export async function agendaBlocksGym(env, from, to, now = Date.now()) {
  const [items, meetings] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items WHERE cancelled_at IS NULL').all(),
    env.DB.prepare('SELECT id,start_at,end_at,confirmed_at FROM group_meetings').all()
  ]);
  return items.results.some(row => { const b=A.busyInterval(item(row), now); return b && b[0]<to && from<b[1]; }) ||
    meetings.results.some(m => { const b=A.meetingInterval({startAt:m.start_at,endAt:m.end_at,confirmedAt:m.confirmed_at},now); return b && b[0]<to && from<b[1]; });
}
