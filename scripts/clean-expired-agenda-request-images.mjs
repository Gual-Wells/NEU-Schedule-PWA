import {readFile,readdir,lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const AGENDA_JOB_ROOT='D:\\CodexStorage\\services\\neu-schedule-agenda\\jobs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const samePath=(left,right)=>path.win32.resolve(left).toLowerCase()===path.win32.resolve(right).toLowerCase();
export function assertAgendaRoot(root) {
  if(typeof root!=='string'||!samePath(root,AGENDA_JOB_ROOT))throw Error('Only the fixed agenda jobs root is allowed');
}

// No inference or credential access. The original digest and all charge-state fields survive.
export function redactExpiredImages(record,{sourceExpiresAt,now=Date.now()}={}) {
  if(!Number.isSafeInteger(sourceExpiresAt)||sourceExpiresAt>now)return {record,images:0};
  const copy=structuredClone(record);let images=0;
  const visit=value=>{
    if(!value||typeof value!=='object')return;
    for(const key of Object.keys(value)) {
      if(typeof value[key]==='string'&&/^data:image\/(png|jpeg|webp);base64,/i.test(value[key])){value[key]=null;images++;}
      else visit(value[key]);
    }
  };
  visit(copy.body);
  if(images) {
    // Preserve the transport-equivalent hash before removing any image value.
    copy.streamDigest=record.streamDigest||sha(JSON.stringify({...record.body,stream:true}));
    copy.imageInputsRedactedAt=now;
  }
  return {record:images?copy:record,images};
}

async function checked(root,file,directory=false) {
  const info=await lstat(file);
  if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))throw Error('Unsafe path');
  const resolved=await realpath(file),relative=path.relative(root,resolved);
  if(relative.startsWith('..')||path.isAbsolute(relative)||!samePath(resolved,file))throw Error('Unsafe path');
  return info;
}
const exists=file=>lstat(file).then(()=>true).catch(()=>false);

export async function cleanExpiredAgendaRequestImages({root,apply=false,now=Date.now()}={}) {
  assertAgendaRoot(root);
  if(process.platform!=='win32')throw Error('This fixed-root maintenance tool runs on Windows only');
  const rootInfo=await lstat(root),resolvedRoot=await realpath(root);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||!samePath(root,resolvedRoot))throw Error('Agenda root must be a physical directory at the fixed path');
  if(apply) {
    const state=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-ScheduledTask -TaskName 'NEU-Schedule-Agenda-Runner' -ErrorAction Stop).State.ToString()"],{encoding:'utf8',windowsHide:true}).trim();
    if(state!=='Disabled')throw Error('Disable and verify the legacy agenda task before applying cleanup');
  }
  const stats={apply,jobs:0,requests:0,expiredRequests:0,plannedChanges:0,changed:0,images:0,bytesBefore:0,bytesAfter:0,skipped:{unknownExpiry:0,notExpired:0,active:0,unsafeOrInvalid:0,changedDuringRead:0}};
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:-g[0-9]+)?$/i.test(entry.name))continue;
    const jobDirectory=path.join(root,entry.name);
    try {
      await checked(root,jobDirectory,true);stats.jobs++;
      const manifestFile=path.join(jobDirectory,'job.json');await checked(root,manifestFile);
      const job=JSON.parse(await readFile(manifestFile,'utf8'));
      if(!Number.isSafeInteger(job.sourceExpiresAt)){stats.skipped.unknownExpiry++;continue;}
      if(job.sourceExpiresAt>now){stats.skipped.notExpired++;continue;}
      const attemptsDirectory=path.join(jobDirectory,'openai');await checked(root,attemptsDirectory,true);
      for(const attempt of await readdir(attemptsDirectory,{withFileTypes:true})) {
        if(!/^\d{4}$/.test(attempt.name))continue;
        const directory=path.join(attemptsDirectory,attempt.name),file=path.join(directory,'request.json');
        try {
          await checked(root,directory,true);const before=await checked(root,file);stats.requests++;stats.expiredRequests++;
          const text=await readFile(file,'utf8'),request=JSON.parse(text);
          const ended=await exists(path.join(directory,'response.json'))||await exists(path.join(directory,'failure.json'));
          const started=Date.parse(request.startedAt||'');
          if(!ended&&Number.isFinite(started)&&now-started<15*60000){stats.skipped.active++;continue;}
          const redacted=redactExpiredImages(request,{sourceExpiresAt:job.sourceExpiresAt,now});
          if(!redacted.images)continue;
          const next=JSON.stringify(redacted.record)+'\n';stats.plannedChanges++;stats.images+=redacted.images;
          stats.bytesBefore+=Buffer.byteLength(text);stats.bytesAfter+=Buffer.byteLength(next);
          if(!apply)continue;
          const latest=await checked(root,file);
          if(latest.dev!==before.dev||latest.ino!==before.ino||await readFile(file,'utf8')!==text){stats.skipped.changedDuringRead++;continue;}
          const temporary=path.join(directory,'request.redaction-'+randomUUID()+'.tmp');
          try {
            const handle=await open(temporary,'wx',0o600);
            try{await handle.writeFile(next);await handle.sync();}finally{await handle.close();}
            await checked(root,directory,true);await checked(root,file);
            await rename(temporary,file);stats.changed++;
          } finally {await unlink(temporary).catch(()=>{});}
        } catch {stats.skipped.unsafeOrInvalid++;}
      }
    } catch {stats.skipped.unsafeOrInvalid++;}
  }
  return stats;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),position=args.indexOf('--root');
  if(position<0||!args[position+1]||args.some((value,index)=>!['--root','--apply'].includes(value)&&index!==position+1))throw Error('Use --root <fixed agenda jobs root> [--apply]');
  try {console.log(JSON.stringify(await cleanExpiredAgendaRequestImages({root:args[position+1],apply:args.includes('--apply')}),null,2));}
  catch {console.error('Agenda request-image maintenance stopped; no credential values or image content were printed.');process.exitCode=1;}
}
