// Call after handled business work only. No idle timer, model call or cross-project DB access.
const resources={language:['d1-language','d1-language-practice','d1-language-lab'],algorithm:['d1-algorithm'],schedule:['d1-schedule'],ledger:['d1-ledger']};
const integer=value=>Number.isSafeInteger(value)&&value>=0;

export async function reportProjectStorage({db,policyBinding,projectId,resourceId,now=Date.now}={}){
 if(!Object.hasOwn(resources,projectId)||!resources[projectId].includes(resourceId))return{reported:false,reason:'invalid-resource'};
 if(typeof policyBinding?.policy!=='function'||typeof policyBinding?.report!=='function'||typeof db?.prepare!=='function')return{reported:false,reason:'not-configured'};
 let observedAt;try{observedAt=typeof now==='function'?now():now;}catch{return{reported:false,reason:'invalid-clock'};}
 if(!integer(observedAt))return{reported:false,reason:'invalid-clock'};
 let policy;try{policy=await policyBinding.policy();}catch{return{reported:false,reason:'policy-unavailable'};}
 const routes=Array.isArray(policy?.allocations)?policy.allocations.filter(route=>route?.resourceId===resourceId):[];
 const route=routes[0];
 if(policy?.schemaVersion!==1||policy.projectId!==projectId||!Number.isSafeInteger(policy.policyRevision)||policy.policyRevision<1||routes.length!==1||route.mode!=='current'||route.resource?.id!==resourceId||route.resource.scope!=='project'||route.resource.owner!==projectId||route.resource.state!=='active')return{reported:false,reason:'policy-mismatch'};
 let size=null;try{const result=await db.prepare('SELECT 1').all();if(integer(result?.meta?.size_after))size=result.meta.size_after;}catch{}
 const snapshot={resourceId,revision:observedAt,observedAt,verified:size!==null,
  ...(size===null?{}:{measurement:'database-size',complete:true,usedBytes:size,limitBytes:null,remainingBytes:null})};
 try{
  const result=await policyBinding.report({reports:[snapshot]});
  return result?.ok===true?{reported:true,verified:snapshot.verified}:{reported:false,reason:'report-unavailable'};
 }catch{return{reported:false,reason:'report-unavailable'};}
}
