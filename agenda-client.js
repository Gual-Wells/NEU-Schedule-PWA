(() => {
  'use strict';
  const A = window.ScheduleAgenda, $ = id => document.getElementById(id);
  const KEY = 'neu-agenda-v1', QUEUE = 'neu-agenda-queue-v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let state = read(KEY, { items: [], imports: [], digests: [] }), queue = read(QUEUE, []);
  let meetingActions={},popupGroups=new Map();
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
  const sourceLinks=v=>(v.sources?.length?v.sources:[{importId:v.sourceImportId,sourceImages:v.sourceImages?.length?v.sourceImages:[1]}]).filter(s=>s.importId).map((s,i)=>(s.sourceImages?.length?s.sourceImages:[1]).map(n=>'<a target="_blank" rel="noopener" href="/imports/'+encodeURIComponent(s.importId)+'/source/'+n+'">'+(i?'补充':'原')+'图 '+n+'</a>').join(' ')).join(' ');
  function render() {
    if(!$('agendaContent'))return;
    const items=overlay(),pending=items.filter(v=>v.resolvedAt==null&&v.cancelledAt==null),done=items.filter(v=>!pending.includes(v));
    $('agendaStatus').textContent=message||(queue.length?`${queue.length} 项待同步`:'');
    const cards=list=>list.map(v=>{
      const status=A.status(v),w=A.windows(v),ended=v.resolvedAt!=null||v.cancelledAt!=null;
      return `<article class="agenda-card ${esc(status)}" data-agenda-item="${esc(v.id)}"><strong>${v.kind==='deadline'?'DDL':'活动'} · ${esc(v.title)}</strong><p>${esc(A.timeLabel(v))}${v.location?' · '+esc(v.location):''}</p><small>${names[status]}</small>${v.evidence||v.inference||v.sourceImportId?`<details><summary>来源</summary>${v.evidence?`<p>${esc(v.evidence)}</p>`:''}${v.inference?`<p>${esc(v.inference)}</p>`:''}${sourceLinks(v)}</details>`:''}<div class="push-actions">${!ended&&(v.kind==='deadline'||Date.now()>=v.anchorAt)?`<button type="button" data-agenda-resolve="${esc(v.id)}">${v.kind==='deadline'?'DDL 达成':'结束活动'}</button>`:''}${!ended&&Date.now()<w.from?`<button type="button" data-agenda-cancel="${esc(v.id)}">取消安排</button>`:''}</div></article>`;
    }).join('');
    const importNames={queued:'待识别',running:'识别中',review:'待确认',applied:'已入表',failed:'识别失败',cancelled:'已取消'};
    $('agendaContent').innerHTML=`<h3>事项 · ${pending.length}</h3>${cards(pending)||'<p>暂无事项</p>'}<h3>申请</h3>${state.imports.filter(v=>v.status!=='cancelled').map(v=>`<article class="agenda-card"><strong>${v.uploadState==='draft'&&v.status==='queued'?'待上传':importNames[v.status]}</strong><small>${A.format(v.createdAt)}${v.error?' · '+esc(v.error):''}</small><div class="push-actions">${v.uploadState!=='draft'?`<button type="button" data-agenda-review="${esc(v.id)}">${v.status==='review'?'审核':'查看'}</button>`:''}${v.status!=='applied'&&!v.linkedItemIds?.length?`<button type="button" data-import-cancel="${esc(v.id)}">取消</button>`:''}</div></article>`).join('')||'<p>暂无申请</p>'}<details><summary>已完成或取消 · ${done.length}</summary>${cards(done)}</details><h3 id="agendaDigestHeading">汇总</h3>${state.digests.map(v=>`<details class="agenda-card"><summary>${A.format(v.slotAt)} · ${v.entries.length} 项</summary><pre>${esc(A.digestText(v.entries))}</pre></details>`).join('')||'<p>暂无汇总</p>'}`;
  }
  function open(id) {
    editing = null; $('agendaStatus').hidden=false; $('agendaUploadPanel').hidden=false; $('agendaReview').hidden=true; $('agendaEditor').hidden = true; $('agendaContent').hidden = false;
    render(); if (!$('agendaDialog').open) $('agendaDialog').showModal();
    sync().catch(()=>{});
    if(id&&id!=='digest')setTimeout(()=>document.querySelector('[data-agenda-item="'+CSS.escape(id)+'"]')?.scrollIntoView({block:'center'}),100);
    if (id === 'digest') setTimeout(()=>$('agendaDigestHeading')?.scrollIntoView({block:'start'}),100);
  }
  function windowText(value) {
    if(value.dateStart||value.explicitEndAt)return '';
    const w=A.windows(value);return `预留 ${A.format(w.from)}—${A.format(w.to)}`;
  }
  function review(job) {
    const switching=editing?.id!==job.id,wasGenerating=['queued','running'].includes(editing?.status);
    if(!switching&&wasGenerating&&job.status==='review')$('agendaReviewStatus').textContent='已更新';
    editing=job;$('agendaStatus').hidden=true;$('agendaUploadPanel').hidden=true;$('agendaContent').hidden=true;$('agendaEditor').hidden=true;$('agendaReview').hidden=false;
    if(switching){$('agendaFeedback').value=read('neu-agenda-feedback-'+job.id,null)?.text||'';$('agendaReviewStatus').textContent='';}
    const result=job.result,one=result?.items?.length===1?result.items[0]:null,pending=['queued','running'].includes(job.status);
    let schedule='',valid=false;
    if(one&&(one.localTime||one.dateStart))try{schedule=windowText(A.generatedItem(one));valid=true;}catch(error){schedule=error.message;}
    const heading=pending?'识别中':job.status==='failed'?'识别失败':job.status==='applied'?'已入表':'待确认';
    const sourceImages=job.expiresAt>Date.now()?(job.images||[]).map(image=>`<a target="_blank" rel="noopener" href="${esc(image.url)}">图 ${image.position}</a>`).join(' '):'原图已过期';
    $('agendaReviewResult').innerHTML=`<h3>${heading}</h3>${one?`<article class="agenda-card"><strong>${one.kind==='deadline'?'DDL':'活动'} · ${esc(one.title)}</strong><p>${esc(one.dateStart?one.dateStart+(one.dateEnd&&one.dateEnd!==one.dateStart?'—'+one.dateEnd:'')+' 全天':one.localTime?.replace('T',' ')||'日期待定')}${one.localEnd?'—'+esc(one.localEnd.replace('T',' ')):''}${one.location?' · '+esc(one.location):''}</p>${schedule?`<small>${esc(schedule)}</small>`:''}${one.question&&!valid?`<p class="agenda-question">${esc(one.question)}</p>`:''}${result.relation?.type==='update'?'<small class="agenda-linked">更新已有事项</small>':''}<details class="agenda-source-details"><summary>来源</summary>${result.summary?`<p>${esc(result.summary)}</p>`:''}${one.evidence?`<p>${esc(one.evidence)}</p>`:''}${one.inference?`<p>${esc(one.inference)}</p>`:''}${one.question&&valid?`<p>${esc(one.question)}</p>`:''}${result.relation?.type==='update'?`<p>${esc(result.relation.reason)}</p>`:''}<p>${sourceImages}</p></details></article>`:result?'<p>需重新识别</p>':''}${job.error?`<p>${esc(job.error)}</p>`:''}${job.feedback?.length?`<details><summary>反馈 · ${job.feedback.length}</summary>${job.feedback.map(f=>`<p>${esc(f.text)}</p>`).join('')}</details>`:''}`;
    $('agendaConfirm').hidden=job.status!=='review';$('agendaConfirm').disabled=!valid;
    $('agendaConfirm').textContent=job.linkedItemIds?.length||result?.relation?.type==='update'?'确认更新':'确认入表';
    const target=state.items.find(v=>job.linkedItemIds?.includes(v.id)),ended=target&&(target.resolvedAt!=null||target.cancelledAt!=null);
    $('agendaSendFeedback').disabled=job.status==='cancelled'||ended||job.linkedItemIds?.length>1;
    $('agendaFeedback').disabled=Boolean(ended);
    if(ended)$('agendaReviewStatus').textContent=target.cancelledAt!=null?'已取消':'已完成';
  }
  function editor() {
    $('agendaEditorStatus').textContent='';$('agendaStatus').hidden=true;$('agendaUploadPanel').hidden=true;$('agendaReview').hidden=true;
    editing={id:null,items:[{key:'manual',kind:'activity',title:'',localTime:local(Date.now()),localEnd:null,location:'',evidence:''}]};
    $('agendaContent').hidden=true;$('agendaEditor').hidden=false;$('agendaSource').textContent='';
    $('agendaCandidates').innerHTML=`<fieldset class="agenda-candidate" data-index="0"><label>类型<select name="kind"><option value="activity">活动</option><option value="deadline">DDL</option></select></label><label>标题<input name="title" maxlength="100" required /></label><label>开始 / 截止时间<input name="time" type="datetime-local" value="${local(Date.now())}" required /></label><label>结束时间（可选）<input name="end" type="datetime-local" /></label><label>地点<input name="location" maxlength="200" /></label><output class="agenda-window"></output></fieldset>`;
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
      try {if(!fieldset.querySelector('[name="title"]').value.trim()){fieldset.querySelector('output').textContent='';continue;} const v=fields(fieldset),w=A.windows(v); fieldset.querySelector('output').textContent = `预留 ${A.format(w.from)}—${A.format(w.to)}`; }
      catch(error) { fieldset.querySelector('output').textContent=error.message; }
    }
  }
  function init(change,options={}) {
    onChange=change;meetingActions=options; if(initialized) return; initialized=true;
    $('closeNonCourse').addEventListener('click',()=>$('nonCourseDialog').close());
    $('nonCourseContent').addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.popupAgenda){$('nonCourseDialog').close();open(b.dataset.popupAgenda);}if(b.dataset.popupMeeting){$('nonCourseDialog').close();meetingActions.openMeeting?.(b.dataset.popupMeeting);}});
    document.addEventListener('click',event=>{const b=event.target.closest('[data-noncourse-group]');if(b)openGroup(b.dataset.noncourseGroup);});
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
        review(updated);$('agendaReviewStatus').textContent='已提交';await sync();
      }catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaConfirm').addEventListener('click',async()=>{
      const job=editing;if(!job?.id)return;
      const button=$('agendaConfirm');button.disabled=true;
      try{await request('/agenda/commit',{id:uuid(),type:'apply',importId:job.id,revision:job.revision});message=job.linkedItemIds?.length?'已更新':'已入表';open();}
      catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaCandidates').addEventListener('input',preview);
    window.AgendaUpload?.init(text=>{message=text;render();},()=>sync()).catch(error=>{message=error.message;render();});
    $('agendaEditor').addEventListener('submit',async event=>{
      event.preventDefault();
      try {
        const items=[...$('agendaCandidates').querySelectorAll('fieldset')].map(fields);
        enqueue({id:uuid(),type:'create',items});message='已添加';
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
  function intervals(dayKey,meetings=[]) {
    const [start,end]=A.dayRange(dayKey),now=Date.now(),entries=[];
    for(const v of overlay()){
      const busy=A.busyInterval(v,now);if(!busy)continue;
      const from=Math.max(start,busy[0]),to=Math.min(end,busy[1]);if(to<=from)continue;
      const w=A.windows(v);entries.push({key:'agenda-'+v.id,id:v.id,type:'agenda',kind:v.kind,title:(v.kind==='deadline'?'DDL':'活动')+' · '+v.title,from,to,coreFrom:w.coreFrom,coreTo:w.coreTo,ended:v.resolvedAt!=null,time:A.timeLabel(v),value:v});
    }
    for(const v of meetings){const busy=A.meetingInterval(v,now);if(!busy)continue;const from=Math.max(start,busy[0]),to=Math.min(end,busy[1]);if(to<=from)continue;
      entries.push({key:'meeting-'+v.id,id:v.id,type:'meeting',kind:'meeting',title:'组会',from,to,coreFrom:v.startAt,coreTo:v.startAt+3*A.HOUR,ended:v.endAt!=null,time:A.format(v.startAt),value:v});}
    return entries;
  }
  function openGroup(key) {
    const group=popupGroups.get(key);if(!group)return;
    $('nonCourseTitle').textContent=group.dayKey+' · '+group.entries.length+' 项安排';
    $('nonCourseContent').innerHTML=group.entries.map(v=>`<article class="agenda-card"><strong>${esc(v.title)}</strong><p>${esc(v.time)}</p>${v.value.location?`<p>${esc(v.value.location)}</p>`:''}${v.ended?'<small>已结束</small>':''}<button type="button" ${v.type==='meeting'?'data-popup-meeting':'data-popup-agenda'}="${esc(v.id)}">打开</button></article>`).join('');
    if(!$('nonCourseDialog').open)$('nonCourseDialog').showModal();
  }
  function daySummary(dayKey) {
    const entries=intervals(dayKey).filter(v=>v.value.dateStart);
    if(!entries.length)return '';
    return `<div class="day-all-day">${entries.map(v=>`<button type="button" class="all-day-chip" data-agenda-open="${esc(v.id)}"><span>${v.ended?'已完成':v.value.dateEnd<dayKey?'未完成':'全天'}</span><strong>${esc(v.value.title)}</strong></button>`).join('')}</div>`;
  }
  function blocks(dayKey,size,meetings=[]) {
    const [start]=A.dayRange(dayKey),groups=A.layout(intervals(dayKey,meetings));
    for(const key of popupGroups.keys())if(key.startsWith(size+'-'+dayKey+'-'))popupGroups.delete(key);
    return groups.map((g,index)=>{
      const key=size+'-'+dayKey+'-'+index;popupGroups.set(key,{...g,dayKey});
      const labels=new Map();
      if(size==='day')for(const slice of g.slices){if(slice.value.dateStart)continue;const previous=labels.get(slice.key);if(!previous||(slice.to-slice.from)*slice.width>(previous.to-previous.from)*previous.width)labels.set(slice.key,slice);}
      const strips=g.slices.map(v=>{
        const segment=(from,to,cls)=>{const a=Math.max(from,v.from),b=Math.min(to,v.to);return b>a?`<span class="${cls}" style="top:${(a-v.from)/(v.to-v.from)*100}%;height:${(b-a)/(v.to-v.from)*100}%"></span>`:'';};
        const clock=at=>new Date(at+8*A.HOUR).toISOString().slice(11,16),at=v.type==='meeting'?v.value.startAt:v.value.anchorAt;
        const time=A.dayKey(at)===dayKey?clock(at)+(v.value.explicitEndAt?'—'+clock(v.value.explicitEndAt):''):A.format(at);
        const label=labels.get(v.key)===v&&v.to-v.from>=20*60000?`<span class="meeting-copy"><strong>${esc(v.value.title||'组会')}</strong>${v.width>=.5?`<small>${esc(time)}</small>`:''}</span>`:'';
        return `<span aria-hidden="true" class="meeting-block noncourse-strip ${size==='week'?'meeting-week':'meeting-day'} ${v.kind==='meeting'?'':'agenda-block'} ${v.kind} ${v.ended?'completed':''}" style="top:${(v.from-g.from)/(g.to-g.from)*100}%;height:${(v.to-v.from)/(g.to-g.from)*100}%;left:${v.left*100}%;width:${v.width*100}%">${segment(v.from,v.coreFrom,'meeting-extension')}${segment(v.coreFrom,v.coreTo,'meeting-solid')}${segment(v.coreTo,v.to,'meeting-extension')}${label}</span>`;
      }).join('');
      return `<div class="noncourse-region ${size}" style="top:${(g.from-start)/A.DAY*100}%;height:${(g.to-g.from)/A.DAY*100}%">${strips}<button type="button" class="noncourse-hitbox" data-noncourse-group="${esc(key)}" aria-label="展开 ${dayKey} 的 ${g.entries.length} 项安排">${size==='day'&&g.entries.length>1?`<span>${g.entries.length}</span>`:''}</button></div>`;
    }).join('');
  }
  function overlaps(dayKey,from,to,meetings=[]) {return intervals(dayKey,meetings).some(v=>v.from<to&&from<v.to);}

  window.AgendaClient={init,sync,list:overlay,blocks,daySummary,overlaps,open,escape:esc};
})();
