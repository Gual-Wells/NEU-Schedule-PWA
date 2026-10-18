(() => {
  'use strict';
  const $=id=>document.getElementById(id), MAX_IMAGES=8, MAX_TOTAL=20*1024*1024;
  const fresh=()=>({nonce:crypto.randomUUID(),note:'',images:[],serverId:null,createdAt:Date.now()});
  let draft=fresh(), busy=false, report=()=>{}, submitted=()=>{}, urls=[];
  const database=new Promise((resolve,reject)=>{
    const request=indexedDB.open('neu-agenda-image-drafts-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(Error('无法保存图片草稿，请检查浏览器存储空间'));
  });
  database.catch(()=>{});
  async function storage(value,remove=false) {
    const db=await database, writing=value!==undefined||remove;
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('drafts',writing?'readwrite':'readonly'),store=transaction.objectStore('drafts');
      const request=remove?store.delete('active'):writing?store.put(value,'active'):store.get('active');
      transaction.oncomplete=()=>resolve(request.result);
      transaction.onabort=()=>reject(Error('图片草稿未保存，请减少图片数量或释放浏览器空间'));
      transaction.onerror=()=>reject(Error('图片草稿未保存，请减少图片数量或释放浏览器空间'));
    });
  }
  async function persist(next) {await storage(next);draft=next;}
  async function reset() {await storage(undefined,true);draft=fresh();$('agendaNote').value='';}
  function render() {
    urls.forEach(url=>URL.revokeObjectURL(url));urls=[];
    const list=$('agendaImageList');list.replaceChildren();
    $('agendaImage').disabled=busy||Boolean(draft.serverId);
    $('agendaNote').disabled=busy||Boolean(draft.serverId);
    $('agendaUpload').disabled=busy||!draft.images.length;
    $('agendaDiscard').disabled=busy||!draft.images.length;
    $('agendaUpload').textContent=draft.serverId?'继续上传并生成':'生成一份事项';
    $('agendaSelectionStatus').textContent=draft.images.length?`${draft.images.length} / ${MAX_IMAGES} 张 · ${(draft.images.reduce((sum,image)=>sum+image.blob.size,0)/1024/1024).toFixed(1)} MB${draft.serverId?' · 上传未完成，重试只补传缺图':''}`:'一份申请只生成一项，可多次选图补充上下文。最多 8 张，压缩后合计 20 MB。';
    draft.images.forEach((image,index)=>{
      const card=document.createElement('article');card.className='agenda-image-preview';
      const preview=document.createElement('img');preview.src=URL.createObjectURL(image.blob);urls.push(preview.src);preview.alt='图 '+(index+1);preview.loading='lazy';
      const full=document.createElement('a');full.href=preview.src;full.target='_blank';full.rel='noopener';full.setAttribute('aria-label','放大查看图 '+(index+1));full.append(preview);
      const label=document.createElement('strong');label.textContent='图 '+(index+1);
      const actions=document.createElement('div');actions.className='push-actions';
      for(const [action,text,disabled] of [['up','上移',index===0],['down','下移',index===draft.images.length-1],['remove','移除',false]]) {
        const button=document.createElement('button');button.type='button';button.textContent=text;button.dataset.imageAction=action;button.dataset.imageIndex=String(index);button.setAttribute('aria-label','图 '+(index+1)+' '+text);button.disabled=busy||Boolean(draft.serverId)||disabled;actions.append(button);
      }
      card.append(full,label,actions);list.append(card);
    });
  }
  async function run(fn) {
    if(busy)return;busy=true;render();
    try{await fn();}catch(error){report(error.message||'图片处理未完成，请重试');}
    finally{busy=false;render();}
  }
  async function compress(file) {
    if(file.size>20*1024*1024)throw Error('单张原图超过 20 MB，请先缩小');
    const bitmap=await createImageBitmap(file);
    try{
      if(bitmap.width*bitmap.height>16*1024*1024)throw Error('单张图片超过 1600 万像素，请先裁剪');
      const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
      canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));
      if(!blob||blob.size>5*1024*1024)throw Error('单张图片压缩后仍超过 5 MB，请裁剪后重试');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
      return {id:crypto.randomUUID(),blob,digest,mime:'image/jpeg',byteLength:blob.size};
    }finally{bitmap.close();}
  }
  async function add(files) {
    if(draft.serverId)throw Error('已有上传草稿，请继续上传或先取消本批图片');
    if(draft.images.length+files.length>MAX_IMAGES)throw Error('每批最多 8 张图片');
    const next=[...draft.images];let duplicates=0;
    for(const file of files) {
      report('正在准备图片 '+(next.length+1)+'…');
      const image=await compress(file);
      if(next.some(existing=>existing.digest===image.digest)){duplicates++;continue;}
      next.push(image);
      if(next.reduce((sum,v)=>sum+v.byteLength,0)>MAX_TOTAL)throw Error('本批图片压缩后超过 20 MB，请减少图片');
    }
    await persist({...draft,note:$('agendaNote').value,images:next,createdAt:draft.images.length?draft.createdAt:Date.now()});
    report(duplicates?'已忽略重复图片；请核对图片顺序后提交。':'图片草稿已保存，请核对顺序后提交。');
  }
  async function upload() {
    if(!draft.images.length)throw Error('请先选择图片');
    if(Date.now()-draft.createdAt>=72*3600000)throw Error('本地图片草稿已过期，请取消后重新选择');
    await persist({...draft,note:$('agendaNote').value});
    let row;
    if(draft.serverId)row=await window.ScheduleAuth.request('/imports/'+draft.serverId);
    else {
      row=await window.ScheduleAuth.request('/imports/batches',{protocol:2,nonce:draft.nonce,note:draft.note,images:draft.images.map(({id,digest,mime,byteLength})=>({id,digest,mime,byteLength}))});
      await persist({...draft,serverId:row.id});
    }
    if(row.status==='cancelled'||row.expiresAt<=Date.now())throw Error('本批上传已取消或过期，请取消本地草稿后重新选择');
    if(row.uploadState!=='ready') {
      for(const [index,image] of draft.images.entries()) {
        if(row.images.some(v=>v.id===image.id&&v.receivedAt!=null))continue;
        report(`正在上传图 ${index+1} / ${draft.images.length}…`);
        const response=await fetch('/imports/'+row.id+'/images/'+image.id,{method:'POST',credentials:'same-origin',headers:{'content-type':image.mime},body:image.blob});
        const data=await response.json();if(!response.ok)throw Error(data.error||'上传中断，可点击继续上传');
      }
      await window.ScheduleAuth.request('/imports/'+row.id+'/submit',{});
    }
    await reset();report('整批图片已提交，等待本机联合识别。可关闭面板稍后查看。');await submitted();
  }
  async function init(status,onSubmitted) {
    report=status;submitted=onSubmitted;
    $('agendaImage').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';if(files.length)run(()=>add(files));});
    $('agendaUpload').addEventListener('click',()=>run(upload));
    $('agendaDiscard').addEventListener('click',()=>run(async()=>{if(draft.serverId)await window.ScheduleAuth.request('/imports/'+draft.serverId+'/cancel',{});await reset();report('本批图片草稿已取消。');await submitted();}));
    $('agendaNote').addEventListener('change',()=>{if(!draft.serverId&&!busy)persist({...draft,note:$('agendaNote').value}).catch(error=>report(error.message));});
    $('agendaImageList').addEventListener('click',event=>{
      const button=event.target.closest('[data-image-action]');if(!button)return;
      run(async()=>{
        if(draft.serverId)throw Error('上传开始后请先取消本批再调整图片');
        const index=Number(button.dataset.imageIndex),images=[...draft.images];
        if(button.dataset.imageAction==='remove')images.splice(index,1);
        else {const target=index+(button.dataset.imageAction==='up'?-1:1);if(target<0||target>=images.length)return;[images[index],images[target]]=[images[target],images[index]];}
        await persist({...draft,note:$('agendaNote').value,images});
      });
    });
    busy=true;render();
    try{const saved=await storage();if(saved&&Array.isArray(saved.images)){if(saved.createdAt>Date.now()-72*3600000)draft=saved;else await reset();}$('agendaNote').value=draft.note;}
    catch(error){report(error.message);}
    finally{busy=false;render();}
    setInterval(()=>{if(!busy&&draft.images.length&&Date.now()-draft.createdAt>=72*3600000)run(async()=>{await reset();report('过期的本地图片草稿已清理。');});},60000);
  }
  window.AgendaUpload={init};
})();
