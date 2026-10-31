import { idOK, json, hash, enc, input } from './agenda-wire.js';
import { applicationItems } from './agenda-context.js';
import { importDetail } from './agenda-images.js';

export async function feedback(request,env,id) {
  const value=await input(request),now=Date.now();
  if(!idOK(value.id)||!Number.isInteger(value.revision)||typeof value.text!=='string'||!value.text.trim()||value.text.length>2000)throw Error('请用文字说明这份申请需要怎样修改（最多 2000 字）');
  const digest=await hash(enc.encode(JSON.stringify({type:'feedback',importId:id,id:value.id,revision:value.revision,text:value.text})));
  const previous=await env.DB.prepare('SELECT request_hash FROM agenda_operations WHERE id=?').bind(value.id).first();
  if(previous)return previous.request_hash===digest?json(await importDetail(env,id)):json({error:'操作编号已被使用'},409);
  const row=await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(id).first();
  if(!row||row.status==='cancelled'||row.upload_state!=='ready'||row.revision!==value.revision)return json({error:'申请已更新，请刷新后提交反馈'},409);
  if(row.outcome_unknown)return json({error:'本次API结果待核对，暂不能通过反馈重复识别'},409);
  if(row.status==='running'&&(row.execution_mode==='cloud-v1'||env.API_CLOUD_ENABLED==='true'))return json({error:'图片正在识别，请待本次结果明确后再反馈'},409);
  if(row.expires_at<=now&&!row.result_json)return json({error:'原图已过期且没有可修订结果，请重新提交图片'},409);
  const [linked,history,queued]=await Promise.all([
    applicationItems(env,id).then(results=>({results})),
    env.DB.prepare('SELECT COUNT(*) n FROM agenda_feedback WHERE import_id=?').bind(id).first(),
    env.DB.prepare("SELECT COUNT(*) n FROM agenda_imports WHERE status IN ('queued','running') AND id<>?").bind(id).first()
  ]);
  if(linked.results.length>1)return json({error:'旧申请已生成多项，暂不能整体修订；原有事项保留'},409);
  const target=linked.results[0];
  if(target&&(target.resolved_at!==null||target.cancelled_at!==null))return json({error:'事项已完成或取消，不能通过反馈重新安排'},409);
  if(history.n>=20||queued.n>=20)return json({error:'修订次数或等待队列已满'},409);
  const commands=[
    env.DB.prepare('INSERT INTO agenda_operations VALUES(?,?,?,?)').bind(value.id,digest,'{}',now),
    env.DB.prepare('INSERT INTO agenda_review_guards VALUES(?,?,?,?,?,?)').bind(value.id,id,row.revision,row.status,target?.id||null,target?.revision||null),
    env.DB.prepare('INSERT INTO agenda_feedback VALUES(?,?,?,?,?)').bind(value.id,id,value.text.trim(),row.result_json,now),
    env.DB.prepare("UPDATE agenda_imports SET status='queued',extraction_protocol=4,processing_deadline=?,execution_mode=?,claim_hash=NULL,lease_until=NULL,error=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND generation=? AND status=? AND outcome_unknown=0")
      .bind(now+3*86400000,env.API_CLOUD_ENABLED==='true'?'cloud-v1':row.execution_mode,now,id,row.revision,row.generation,row.status)
  ];
  try{await env.DB.batch(commands);}catch{
    const replay=await env.DB.prepare('SELECT request_hash FROM agenda_operations WHERE id=?').bind(value.id).first();
    if(!replay||replay.request_hash!==digest)return json({error:'申请或事项已变化，请刷新后反馈'},409);
  }
  return json(await importDetail(env,id));
}
