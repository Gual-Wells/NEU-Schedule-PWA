export const viewItem=row=>({id:row.id,kind:row.kind,title:row.title,anchorAt:row.anchor_at,explicitEndAt:row.explicit_end_at,
  dateStart:row.date_start,dateEnd:row.date_end,inference:row.inference||'',location:row.location,evidence:row.evidence,
  resolvedAt:row.resolved_at,cancelledAt:row.cancelled_at,revision:row.revision,sourceImportId:row.source_import_id,sourceImages:JSON.parse(row.source_images||'[]')});

export async function applicationItems(env,id) {
  return (await env.DB.prepare('SELECT i.* FROM agenda_items i WHERE i.id IN (SELECT b.item_id FROM agenda_application_items b JOIN agenda_imports p ON b.application_id=COALESCE(p.canonical_id,p.id) WHERE p.id=?) OR i.source_import_id=?').bind(id,id).all()).results;
}

export async function recognitionContext(env,row) {
  const [imports,bindings]=await Promise.all([
    env.DB.prepare("SELECT * FROM agenda_imports WHERE canonical_id IS NULL AND status<>'cancelled' AND (result_json IS NOT NULL OR EXISTS(SELECT 1 FROM agenda_application_items WHERE application_id=agenda_imports.id)) ORDER BY updated_at DESC LIMIT 80").all(),
    env.DB.prepare('SELECT b.application_id,i.* FROM agenda_application_items b JOIN agenda_items i ON i.id=b.item_id').all()
  ]);
  return imports.results.filter(p=>p.id!==row.id||bindings.results.some(b=>b.application_id===p.id)).map(p=>{
    const existing=bindings.results.find(b=>b.application_id===p.id),result=p.result_json?JSON.parse(p.result_json):null;
    const local=at=>new Date(at+8*3600000).toISOString().slice(0,16);
    const current=existing?{...viewItem(existing),localTime:existing.date_start?null:local(existing.anchor_at),localEnd:existing.explicit_end_at===null?null:local(existing.explicit_end_at)}:null;
    return {applicationId:p.id,revision:p.revision,status:p.status,item:current,generated:existing?null:result?.items?.length===1?result.items[0]:null};
  }).filter(p=>p.item||p.generated);
}

export function validateRelation(value,context) {
  if(!value||!['new','update'].includes(value.type)||typeof value.reason!=='string'||value.reason.length>1200)throw Error('申请关联信息无效');
  if(value.type==='new'){if(value.targetImportId!==null||value.targetItemId!==null)throw Error('新事项不能指定旧申请');return {...value};}
  const target=context.find(v=>v.applicationId===value.targetImportId);
  if(!target||value.targetItemId!==(target.item?.id||null)||!value.reason.trim())throw Error('未找到关联申请，请重新识别');
  return {...value};
}
