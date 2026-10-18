(() => {
  'use strict';
  const A = window.ScheduleAgenda, $ = id => document.getElementById(id);
  const KEY = 'neu-agenda-v1', QUEUE = 'neu-agenda-queue-v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let state = read(KEY, { items: [], imports: [], digests: [] }), queue = read(QUEUE, []);
  let onChange = () => {}, busy = null, editing = null, message = '', initialized = false, lastSync=0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid = () => crypto.randomUUID();
  const local = at => new Date(at + 8*A.HOUR).toISOString().slice(0,16);
  function save() { localStorage.setItem(KEY, JSON.stringify(state)); localStorage.setItem(QUEUE, JSON.stringify(queue)); }
  function overlay() {
    const items = state.items.map(v => ({...v}));
    for (const op of queue) {
      if (op.type === 'create') for (const [i,v] of op.items.entries()) {
        const id = 'a-' + op.id + '-' + i;
        if (!items.some(item => item.id === id)) items.push({...v,id,resolvedAt:null,cancelledAt:null});
      }
      const target = items.find(v => v.id === op.itemId);
      if (target && target.resolvedAt == null && target.cancelledAt == null) {
        if (op.type === 'resolve') target.resolvedAt = op.at;
        if (op.type === 'cancel') target.cancelledAt = op.at;
      }
    }
    return items.sort((a,b) => a.anchorAt-b.anchorAt);
  }
  async function request(path, value) { return window.ScheduleAuth.request(path, value === undefined ? undefined : {...value, protocol:1}); }
  function changed() {
    onChange();
    if(!$('agendaDialog')?.open)return;
    if(!editing)render();
    else if(editing.id){const job=state.imports.find(v=>v.id===editing.id);if(job&&(job.revision!==editing.revision||job.status!==editing.status))review(job);}
  }
  function sync() {
    if (busy) return busy;
    busy = (async () => {
      while (queue.length) {
        const op = queue[0];
        try { state = await request('/agenda/commit', op); }
        catch (error) {
          if ([400,404,409].includes(error.status)) {
            // Keep a recoverable record; a rejected operation must not block all later operations.
            const rejected = read('neu-agenda-rejected-v1', []);
            rejected.push({op,error:error.message,at:Date.now()});
            localStorage.setItem('neu-agenda-rejected-v1',JSON.stringify(rejected.slice(-20)));
            queue.shift(); save(); message = '一项操作未被云端接受：' + error.message; changed(); continue;
          }
          throw error;
        }
        queue.shift(); save(); changed();
      }
      state = await request('/agenda'); lastSync=Date.now(); save(); changed();
    })().catch(error => { message = '等待同步：' + error.message; changed(); throw error; }).finally(() => { busy = null; });
    return busy;
  }
  function enqueue(op) { queue.push(op); save(); changed(); sync().catch(() => {}); }
  const names = {planned:'待开始',warning:'预警中',urgent:'距截止不足一小时',overdue:'已逾期 · 待达成',ongoing:'进行中',extended:'预计时间内',unconfirmed:'超时 · 待结束',resolved:'已完成',cancelled:'已取消'};
  const sourceLabel=v=>v.sourceImages?.length?'<small>来源：'+v.sourceImages.map(n=>'图 '+n).join('、')+'</small>':'';
  const sourceLinks=v=>v.sourceImportId?(v.sourceImages?.length?v.sourceImages:[1]).map(n=>'<a target="_blank" rel="noopener" href="/imports/'+encodeURIComponent(v.sourceImportId)+'/source/'+n+'">查看图 '+n+'</a>').join(' '):'';
  function render() {
    if (!$('agendaContent')) return;
    const items = overlay(), pending = items.filter(v => v.resolvedAt == null && v.cancelledAt == null), done = items.filter(v => !pending.includes(v));
    $('agendaStatus').textContent = message || (queue.length ? `${queue.length} 项操作等待同步` : '每天 07:00 / 22:00 汇总未来 72 小时及逾期未完成事项。');
    const cards = list => list.map(v => {
      const status=A.status(v), w=A.windows(v), ended=v.resolvedAt!=null||v.cancelledAt!=null;
      return `<article class="agenda-card ${esc(status)}"><strong>${v.kind==='deadline'?'DDL':'活动'} · ${esc(v.title)}</strong><p>${A.format(v.anchorAt)}${v.explicitEndAt?'—'+A.format(v.explicitEndAt):''}${v.location?' · '+esc(v.location):''}</p><small>${names[status]} · 占用 ${A.format(w.from)} 起${!ended&&Date.now()>=w.from?'，直至确认结束':''}</small>${(v.evidence||v.sourceImportId)?`<details><summary>来源说明</summary><p>${esc(v.evidence)}</p>${sourceLinks(v)}</details>`:''}<div class="push-actions">${!ended&&(v.kind==='deadline'||Date.now()>=v.anchorAt)?`<button type="button" data-agenda-resolve="${esc(v.id)}">${v.kind==='deadline'?'DDL 达成':'结束活动'}</button>`:''}${!ended&&Date.now()<w.from?`<button type="button" data-agenda-cancel="${esc(v.id)}">取消安排</button>`:''}</div></article>`;
    }).join('');
    const importNames={queued:'等待本机识别',running:'正在识别',review:'待确认入表',applied:'已入表',failed:'识别未完成',cancelled:'已取消'};
    $('agendaContent').innerHTML = `<h3>待处理事项 · ${pending.length}</h3>${cards(pending)||'<p>暂无待处理事项，可从图片导入或手动添加。</p>'}<h3>图片导入</h3>${state.imports.filter(v=>v.status!=='cancelled').map(v=>`<article class="agenda-card"><strong>${(v.uploadState==='draft'&&v.status==='queued'?'等待补传图片':importNames[v.status])}</strong><small>${A.format(v.createdAt)}${v.error?' · '+esc(v.error):''}</small><div class="push-actions">${v.uploadState!=='draft'?`<button type="button" data-agenda-review="${esc(v.id)}">查看申请${v.status==='review'?'并确认':''}</button>`:''}${v.status!=='applied'&&!v.linkedItemIds?.length?`<button type="button" data-import-cancel="${esc(v.id)}">取消导入</button>`:''}</div></article>`).join('')||'<p>尚无图片导入记录。</p>'}<details><summary>已完成或取消 · ${done.length}</summary>${cards(done)}</details><h3 id="agendaDigestHeading">早晚汇总</h3>${state.digests.map(v=>`<details class="agenda-card"><summary>${A.format(v.slotAt)} · ${v.entries.length} 项</summary><pre>${esc(A.digestText(v.entries))}</pre></details>`).join('')||'<p>第一份汇总将在下一个 07:00 或 22:00 生成。</p>'}`;
  }
  function open(id) {
    editing = null; $('agendaStatus').hidden=false; $('agendaUploadPanel').hidden=false; $('agendaReview').hidden=true; $('agendaEditor').hidden = true; $('agendaContent').hidden = false;
    render(); if (!$('agendaDialog').open) $('agendaDialog').showModal();
    sync().catch(()=>{});
    if (id === 'digest') setTimeout(()=>$('agendaDigestHeading')?.scrollIntoView({block:'start'}),100);
  }
  function windowText(value) {
    const w=A.windows(value);
    return `占用 ${A.format(w.from)}—${A.format(w.to)}；实线 ${A.format(w.coreFrom)}—${A.format(w.coreTo)}。完成或结束前持续占用健身时间。`;
  }
  function review(job) {
    const switching=editing?.id!==job.id,wasGenerating=['queued','running'].includes(editing?.status);
    if(!switching&&wasGenerating&&job.status==='review')$('agendaReviewStatus').textContent='已重新生成，请审核此事项。';
    editing=job;$('agendaStatus').hidden=true;$('agendaUploadPanel').hidden=true;$('agendaContent').hidden=true;$('agendaEditor').hidden=true;$('agendaReview').hidden=false;
    if(switching){const draft=read('neu-agenda-feedback-'+job.id,null);$('agendaFeedback').value=draft?.text||'';$('agendaReviewStatus').textContent='';}
    const result=job.result,one=result?.items?.length===1?result.items[0]:null;
    let schedule='',valid=false;
    if(one?.localTime&&!one.question?.trim())try{const v=A.normalizeItem({...one,anchorAt:A.localTime(one.localTime),explicitEndAt:one.localEnd?A.localTime(one.localEnd):null});schedule=windowText(v);valid=true;}catch(error){schedule=error.message;}
    const pending=['queued','running'].includes(job.status);
    const heading=pending?'正在生成此申请的新版本':job.status==='failed'?'生成未完成':job.status==='applied'?'此申请已入表':'生成事项 · 请审核';
    $('agendaReviewResult').innerHTML=`<h3>${heading}</h3>${pending?'<p>正在根据申请和反馈重新生成，请稍候。</p>':''}${one?`${pending?'<p>上一版结果（正在改写）</p>':''}<article class="agenda-card"><strong>${one.kind==='deadline'?'DDL':'活动'} · ${esc(one.title)}</strong><p>${esc(one.localTime?.replace('T',' ')||'时间待确认')}（北京时间）${one.localEnd?'—'+esc(one.localEnd.replace('T',' ')):''}${one.location?' · '+esc(one.location):''}</p><p>${esc(schedule)}</p>${one.question?`<p class="agenda-question">需要反馈：${esc(one.question)}</p>`:''}<p>${esc(result.summary)}</p><p>${esc(one.evidence)}</p>${sourceLabel(one)}</article>`:result?'<p>这份旧申请包含多个候选，请针对本申请反馈目标事项，重新生成一份结果。</p>':'<p>本申请只生成一份事项，无需逐字段填写。</p>'}${job.error?`<p>${esc(job.error)}</p>`:''}<p>${(job.images||[]).map(image=>`<a target="_blank" rel="noopener" href="${esc(image.url)}">查看图 ${image.position}</a>`).join(' ')}${job.expiresAt<=Date.now()?'（原图已过期，保留的文字证据仍可用于反馈）':'（原图保留 72 小时）'}</p>${job.feedback?.length?`<details><summary>本申请的反馈记录 · ${job.feedback.length}</summary>${job.feedback.map(f=>`<p>${esc(f.text)}</p>`).join('')}</details>`:''}`;
    $('agendaConfirm').hidden=job.status!=='review';$('agendaConfirm').disabled=!valid;
    $('agendaConfirm').textContent=job.linkedItemIds?.length?'确认更新此事项':'确认此事项入表';
    const target=state.items.find(v=>job.linkedItemIds?.includes(v.id)),ended=target&&(target.resolvedAt!=null||target.cancelledAt!=null);
    $('agendaSendFeedback').disabled=job.status==='cancelled'||ended||job.linkedItemIds?.length>1;
    if(ended)$('agendaReviewStatus').textContent='此事项已完成或取消，不能通过反馈重新安排。';
  }
  function editor() {
    $('agendaEditorStatus').textContent='';$('agendaStatus').hidden=true;$('agendaUploadPanel').hidden=true;$('agendaReview').hidden=true;
    editing={id:null,items:[{key:'manual',kind:'activity',title:'',localTime:local(Date.now()),localEnd:null,location:'',evidence:''}]};
    $('agendaContent').hidden=true;$('agendaEditor').hidden=false;$('agendaSource').textContent='手动添加一份事项。所有时间均为北京时间。';
    $('agendaCandidates').innerHTML=`<fieldset class="agenda-candidate" data-index="0"><label>类型<select name="kind"><option value="activity">活动</option><option value="deadline">DDL</option></select></label><label>标题<input name="title" maxlength="100" required /></label><label>开始 / 截止时间<input name="time" type="datetime-local" value="${local(Date.now())}" required /></label><label>明确的活动结束时间（可选）<input name="end" type="datetime-local" /></label><label>地点<input name="location" maxlength="200" /></label><output class="agenda-window"></output></fieldset>`;
    preview();
  }
  function fields(fieldset) {
    const f = name => fieldset.querySelector(`[name="${name}"]`).value;
    const v = (editing.result||editing).items[Number(fieldset.dataset.index)];
    if (f('kind')==='deadline' && f('end')) throw Error('DDL 请清空活动结束时间');
    return { key:v.key, ...A.normalizeItem({kind:f('kind'),title:f('title'),anchorAt:A.localTime(f('time')),explicitEndAt:f('end')?A.localTime(f('end')):null,location:f('location'),evidence:v.evidence}) };
  }
  function preview() {
    for (const fieldset of $('agendaCandidates').querySelectorAll('fieldset')) {
      try { const v=fields(fieldset),w=A.windows(v); fieldset.querySelector('output').textContent = `时间窗 ${A.format(w.from)}—${A.format(w.to)}；实线 ${A.format(w.coreFrom)}—${A.format(w.coreTo)}。完成或结束前持续占用健身时间。`; }
      catch(error) { fieldset.querySelector('output').textContent=error.message; }
    }
  }
  function init(change) {
    onChange=change; if(initialized) return; initialized=true;
    $('agendaButton').addEventListener('click',()=>open());
    $('closeAgenda').addEventListener('click',()=>{editing=null;$('agendaDialog').close();});
    $('agendaRefresh').addEventListener('click',()=>sync().catch(()=>{}));
    $('agendaManual').addEventListener('click',()=>editor());
    $('agendaBack').addEventListener('click',()=>open());
    $('agendaReviewBack').addEventListener('click',()=>open());
    $('agendaFeedback').addEventListener('input',()=>{
      if(!editing?.id)return;
      const key='neu-agenda-feedback-'+editing.id,old=read(key,null),text=$('agendaFeedback').value;
      localStorage.setItem(key,JSON.stringify(old?.text===text?old:{text}));
    });
    $('agendaSendFeedback').addEventListener('click',async()=>{
      const job=editing;if(!job?.id)return;
      const button=$('agendaSendFeedback');button.disabled=true;
      try{
        const text=$('agendaFeedback').value.trim();if(!text)throw Error('请说明这份事项需要怎样修改');
        const key='neu-agenda-feedback-'+job.id,old=read(key,null);
        const value=old?.id&&old.text===text&&old.revision===job.revision?old:{id:uuid(),revision:job.revision,text};
        localStorage.setItem(key,JSON.stringify(value));
        const updated=await request('/imports/'+job.id+'/feedback',value);
        localStorage.removeItem(key);$('agendaFeedback').value='';
        state.imports=state.imports.map(v=>v.id===job.id?updated:v);save();
        review(updated);$('agendaReviewStatus').textContent='反馈已提交，正在重新生成这一份事项。';await sync();
      }catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaConfirm').addEventListener('click',async()=>{
      const job=editing;if(!job?.id)return;
      const button=$('agendaConfirm');button.disabled=true;
      try{await request('/agenda/commit',{id:uuid(),type:'apply',importId:job.id,revision:job.revision});message=job.linkedItemIds?.length?'原事项已更新。':'此事项已入表。';open();}
      catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaCandidates').addEventListener('input',preview);
    window.AgendaUpload?.init(text=>{message=text;render();},()=>sync()).catch(error=>{message=error.message;render();});
    $('agendaEditor').addEventListener('submit',async event=>{
      event.preventDefault();
      try {
        const items=[...$('agendaCandidates').querySelectorAll('fieldset')].map(fields);
        enqueue({id:uuid(),type:'create',items});message='事项已添加。';
        open();
      } catch(error) {$('agendaEditorStatus').textContent=error.message;}
    });
    $('agendaContent').addEventListener('click',async event=>{
      const b=event.target.closest('button');if(!b)return;
      try {
        if(b.dataset.agendaReview) {const job=state.imports.find(v=>v.id===b.dataset.agendaReview);if(job)review(job);return;}
        if(b.dataset.importCancel) {await request('/imports/'+b.dataset.importCancel+'/cancel',{});await sync();return;}
        const id=b.dataset.agendaResolve||b.dataset.agendaCancel;
        if(id) {enqueue({id:uuid(),type:b.dataset.agendaResolve?'resolve':'cancel',itemId:id,at:Date.now()});message='已记录，正在同步。';render();}
      } catch(error) {message=error.message;render();}
    });
    window.addEventListener('online',()=>sync().catch(()=>{}));
    window.addEventListener('focus',()=>sync().catch(()=>{}));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync().catch(()=>{});});
    setInterval(()=>{if(!document.hidden){if($('agendaDialog').open&&!editing)render();const delay=$('agendaDialog').open&&state.imports.some(v=>['queued','running'].includes(v.status))?15000:60000;if(Date.now()-lastSync>=delay)sync().catch(()=>{});}},15000);
    sync().catch(()=>{});
    if(new URLSearchParams(location.search).has('agenda'))open('digest');
  }
  function blocks(dayKey,size) {
    const [start,end]=A.dayRange(dayKey), now=Date.now();
    return overlay().filter(v=>v.cancelledAt==null).map(v=>{
      const w=A.windows(v), b=A.busyInterval(v,now);if(!b)return '';
      const from=Math.max(start,b[0]), to=Math.min(end,b[1]);if(to<=from)return '';
      const segment=(a,z,cls)=>{a=Math.max(from,a);z=Math.min(to,z);return z>a?`<span class="${cls}" style="top:${(a-from)/(to-from)*100}%;height:${(z-a)/(to-from)*100}%"></span>`:'';};
      return `<button type="button" class="meeting-block ${size==='week'?'meeting-week':'meeting-day'} agenda-block ${v.kind} ${v.resolvedAt!=null?'completed':''}" data-agenda-open="${esc(v.id)}" style="top:${(from-start)/A.DAY*100}%;height:${(to-from)/A.DAY*100}%">${segment(w.from,w.coreFrom,'meeting-extension')}${segment(w.coreFrom,w.coreTo,'meeting-solid')}${segment(w.coreTo,to,'meeting-extension')}<span class="meeting-copy"><strong>${v.kind==='deadline'?'DDL':'活动'} · ${esc(v.title)}</strong><small>${A.format(v.anchorAt)}</small></span></button>`;
    }).join('');
  }
  window.AgendaClient={init,sync,list:overlay,blocks,open,escape:esc};
})();
