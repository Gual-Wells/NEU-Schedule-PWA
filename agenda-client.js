(() => {
  'use strict';
  const A = window.ScheduleAgenda, $ = id => document.getElementById(id);
  const KEY = 'neu-agenda-v1', QUEUE = 'neu-agenda-queue-v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let state = read(KEY, { items: [], imports: [], digests: [] }), queue = read(QUEUE, []);
  let meetingActions={},popupGroups=new Map(),detailId=null,detailError='';
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
    if ($('agendaDetailDialog')?.open) renderDetail();
    if(!$('agendaDialog')?.open)return;
    if(!editing)render();
    else if(editing.id){const job=state.imports.find(v=>v.id===editing.id);if(job&&(job.revision!==editing.revision||job.status!==editing.status))review(job);}
  }
  function sync() {
    if (busy) return busy;
    let completed = false;
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
            if (op.itemId === detailId) detailError = error.message;
            queue.shift(); save(); message = '一项操作未被云端接受：' + error.message; changed(); continue;
          }
          throw error;
        }
        queue.shift(); save(); changed();
      }
      state = await request('/agenda'); lastSync=Date.now(); save(); changed(); completed=true;
    })().catch(error => { message = '等待同步：' + error.message; changed(); throw error; }).finally(() => { busy = null; if(completed && queue.length) sync().catch(()=>{}); });
    return busy;
  }
  function enqueue(op) { queue.push(op); save(); changed(); sync().catch(() => {}); }
  const names = {planned:'待开始',warning:'预警中',urgent:'距截止不足一小时',overdue:'已逾期 · 待达成',ongoing:'进行中',extended:'预计时间内',unconfirmed:'超时 · 待结束',resolved:'已完成',cancelled:'已取消'};
  const sourceLinks=v=>(v.sources?.length?v.sources:[{importId:v.sourceImportId,sourceImages:v.sourceImages?.length?v.sourceImages:[1]}]).filter(s=>s.importId).map((s,i)=>(s.sourceImages?.length?s.sourceImages:[1]).map(n=>'<a target="_blank" rel="noopener" href="/imports/'+encodeURIComponent(s.importId)+'/source/'+n+'">'+(i?'补充':'原')+'图 '+n+'</a>').join(' ')).join(' ');
  function render() {
    if (!$('agendaContent')) return;
    const items = overlay(), pending = items.filter(v => v.resolvedAt == null && v.cancelledAt == null), done = items.filter(v => !pending.includes(v));
    $('agendaStatus').textContent = message || (queue.length ? `${queue.length} 项操作待同步` : '');
    const cards = list => list.map(v => {
      const status = A.status(v), w = A.windows(v), ended = v.resolvedAt != null || v.cancelledAt != null;
      const record = v.resolvedAt != null ? ` · 完成于 ${A.format(v.resolvedAt)}` : v.cancelledAt != null ? ` · 取消于 ${A.format(v.cancelledAt)}` : Date.now() >= w.from ? ' · 占用中' : '';
      return `<article class="agenda-card ${esc(status)}" data-agenda-item="${esc(v.id)}">
        <strong>${v.kind === 'deadline' ? 'DDL' : '活动'} · ${esc(v.title)}</strong>
        <p>${esc(A.timeLabel(v))}${v.location ? ' · ' + esc(v.location) : ''}</p>
        <small>${names[status]}${esc(record)}</small><small>${esc(windowText(v))}</small>
        ${v.inference ? `<p class="agenda-inference">推断依据：${esc(v.inference)}</p>` : ''}
        ${v.evidence || v.sourceImportId || v.sources?.length ? `<details class="agenda-source-details"><summary>原文与来源</summary>${v.evidence ? `<p>${esc(v.evidence)}</p>` : ''}${sourceLinks(v)}</details>` : ''}
        <div class="push-actions"><button type="button" data-agenda-detail="${esc(v.id)}">查看详情</button>${!ended && (v.kind === 'deadline' || Date.now() >= v.anchorAt) ? `<button type="button" data-agenda-resolve="${esc(v.id)}">${v.kind === 'deadline' ? 'DDL 达成' : '结束活动'}</button>` : ''}${!ended && Date.now() < w.from ? `<button type="button" data-agenda-cancel="${esc(v.id)}">取消安排</button>` : ''}</div></article>`;
    }).join('');
    const importNames = {queued:'等待识别',running:'正在识别',review:'待确认入表',applied:'已入表',failed:'识别失败',cancelled:'已取消'};
    $('agendaContent').innerHTML = `<h3>待处理事项 · ${pending.length}</h3>${cards(pending) || '<p>暂无待处理事项</p>'}
      <h3>图片申请</h3>${state.imports.filter(v => v.status !== 'cancelled').map(v => `<article class="agenda-card"><strong>${v.uploadState === 'draft' && v.status === 'queued' ? '等待补传图片' : v.status==='review'&&v.result?.intent==='analysis' ? '图片解读已完成' : v.outcomeUnknown ? '结果待核对' : v.status==='queued' ? v.executionMode==='cloud-v1' ? '等待云端识别' : '等待本机识别' : importNames[v.status]}</strong><small>${A.format(v.createdAt)}${v.error ? ' · ' + esc(v.error) : ''}</small><div class="push-actions">${v.uploadState !== 'draft' ? `<button type="button" data-agenda-review="${esc(v.id)}">${v.status === 'review' ? v.result?.intent==='analysis' ? '查看解读' : '审核并确认' : '查看申请'}</button>` : ''}${v.status !== 'applied' && !v.linkedItemIds?.length ? `<button type="button" data-import-cancel="${esc(v.id)}">取消申请</button>` : ''}</div></article>`).join('') || '<p>暂无图片申请</p>'}
      <details><summary>已完成或取消 · ${done.length}</summary>${cards(done)}</details>
      <h3 id="agendaDigestHeading">早晚汇总 <small>07:00 / 22:00</small></h3>${state.digests.map(v => `<details class="agenda-card"><summary>${A.format(v.slotAt)} · ${v.entries.length} 项</summary><pre>${esc(A.digestText(v.entries))}</pre></details>`).join('') || '<p>暂无汇总记录</p>'}`;
  }
  function open(id) {
    if (id && id !== 'digest') return openDetail(id);
    editing = null; $('agendaStatus').hidden=false; $('agendaUploadPanel').hidden=false; $('agendaReview').hidden=true; $('agendaEditor').hidden = true; $('agendaContent').hidden = false;
    render(); if (!$('agendaDialog').open) $('agendaDialog').showModal();
    sync().catch(()=>{});
    if (id === 'digest') setTimeout(()=>$('agendaDigestHeading')?.scrollIntoView({block:'start'}),100);
  }
  function renderDetail() {
    const item = overlay().find(v => v.id === detailId), button = $('agendaDetailEnd');
    if (!item) {
      $('agendaDetailTitle').textContent = '事项已移除';
      $('agendaDetailBody').innerHTML = ''; $('agendaDetailSources').innerHTML = '';
      button.hidden = true; $('agendaDetailCancel').hidden = true;
      $('agendaDetailStatus').textContent = '此事项已不在当前安排中';
      return;
    }
    const w = A.windows(item), now = Date.now(), ended = item.resolvedAt != null || item.cancelledAt != null;
    const cell = (label, value, full = false) => `<div class="detail-item ${full ? 'full' : ''}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
    const status = item.resolvedAt != null && item.kind === 'activity' ? '已结束' : names[A.status(item)];
    $('agendaDetailKind').textContent = item.kind === 'deadline' ? 'DDL 详情' : '活动详情';
    $('agendaDetailTitle').textContent = item.title;
    $('agendaDetailBody').innerHTML = [
      cell(item.kind === 'deadline' ? '截止时间' : '活动时间', A.timeLabel(item), true),
      cell('地点', item.location || '未填写'), cell('状态', status),
      cell('预留时间', item.dateStart ? A.timeLabel(item) : A.format(w.from) + '—' + A.format(w.to), true),
      ...(!item.dateStart && !item.explicitEndAt ? [cell('核心时段', A.format(w.coreFrom) + '—' + A.format(w.coreTo), true)] : []),
      cell('健身时间占用', ended ? '已释放' : now >= w.from ? '占用中' : '已预留'),
      ...(item.resolvedAt != null ? [cell(item.kind === 'deadline' ? '达成时间' : '实际结束', A.format(item.resolvedAt), true)] : []),
      ...(item.cancelledAt != null ? [cell('取消时间', A.format(item.cancelledAt), true)] : []),
      ...(item.inference ? [cell('推断依据', item.inference, true)] : [])
    ].join('');
    $('agendaDetailSources').innerHTML = item.evidence || item.sourceImportId || item.sources?.length ? `<details class="agenda-source-details"><summary>原文与来源</summary>${item.evidence ? `<p>${esc(item.evidence)}</p>` : ''}${sourceLinks(item)}</details>` : '';
    button.hidden = ended; button.disabled = item.kind === 'activity' && now < item.anchorAt;
    button.textContent = item.kind === 'deadline' ? 'DDL 达成' : button.disabled ? '开始后可结束' : '结束活动';
    $('agendaDetailCancel').hidden = ended || now >= w.from;
    const pending = queue.find(op => op.itemId === item.id);
    $('agendaDetailStatus').textContent = detailError ? '操作未生效：' + detailError : pending ? '已在本机记录 · ' + (message.startsWith('等待同步：') ? message : '等待同步') : '';
  }
  function openDetail(id) {
    detailId = id; detailError = ''; editing = null;
    if ($('nonCourseDialog').open) $('nonCourseDialog').close();
    if ($('agendaDialog').open) $('agendaDialog').close();
    renderDetail();
    if (!$('agendaDetailDialog').open) $('agendaDetailDialog').showModal();
    sync().catch(() => {});
  }
  function finishDetail(type) {
    const item = overlay().find(v => v.id === detailId), now = Date.now();
    if (!item || item.resolvedAt != null || item.cancelledAt != null) return;
    if (type === 'resolve' && item.kind === 'activity' && now < item.anchorAt) return;
    if (type === 'cancel' && now >= A.windows(item).from) return;
    detailError = ''; message = '';
    enqueue({id:uuid(),type,itemId:item.id,at:now});
  }
  function windowText(value) {
    const w = A.windows(value);
    if (value.dateStart) return `全天预留 ${value.dateStart}${value.dateEnd !== value.dateStart ? '—' + value.dateEnd : ''}`;
    const span = `预留 ${A.format(w.from)}—${A.format(w.to)}`;
    return value.explicitEndAt ? span : `${span} · 核心 ${A.format(w.coreFrom)}—${A.format(w.coreTo)}`;
  }
  function review(job) {
    const switching = editing?.id !== job.id, wasGenerating = ['queued','running'].includes(editing?.status);
    if (!switching && wasGenerating && job.status === 'review') $('agendaReviewStatus').textContent = job.result?.intent==='analysis' ? '图片解读已完成' : '新结果已生成，待确认';
    editing = job; $('agendaStatus').hidden = true; $('agendaUploadPanel').hidden = true; $('agendaContent').hidden = true; $('agendaEditor').hidden = true; $('agendaReview').hidden = false;
    if (switching) { $('agendaFeedback').value = read('neu-agenda-feedback-' + job.id, null)?.text || ''; $('agendaReviewStatus').textContent = ''; }
    const result = job.result, analysis = result?.intent==='analysis', one = result?.items?.length === 1 ? result.items[0] : null, pending = ['queued','running'].includes(job.status);
    let schedule = '', valid = false;
    if (one && (one.localTime || one.dateStart)) try { schedule = windowText(A.generatedItem(one)); valid = true; } catch (error) { schedule = error.message; }
    const heading = pending ? one||analysis ? '正在生成新版本' : job.status === 'queued' ? job.executionMode==='cloud-v1' ? '等待云端识别' : '等待本机识别' : '正在识别' : job.outcomeUnknown ? '结果待核对' : job.status === 'failed' ? '识别失败' : job.status === 'applied' ? '此申请已入表' : job.status === 'cancelled' ? '此申请已取消' : analysis ? '图片解读 · 已完成' : '生成事项 · 待确认';
    const sourceImages = job.expiresAt <= Date.now() ? '原图已过期' : (job.images || []).map(image => `<a target="_blank" rel="noopener" href="${esc(image.url)}">查看图 ${image.position}</a>`).join(' ');
    const sourceExpiry = job.expiresAt > Date.now() ? `<small>原图保留至 ${A.format(job.expiresAt)}</small>` : '';
    $('agendaReviewResult').innerHTML = `<h3>${heading}</h3>${one ? `
      ${pending ? '<p class="agenda-pending">上一版结果 · 正在改写</p>' : ''}
      <article class="agenda-card"><strong>${one.kind === 'deadline' ? 'DDL' : '活动'} · ${esc(one.title)}</strong>
        <p>${esc(one.dateStart ? one.dateStart + (one.dateEnd && one.dateEnd !== one.dateStart ? '—' + one.dateEnd : '') + ' 全天' : one.localTime?.replace('T',' ') || '日期待确认')}${one.localEnd ? '—' + esc(one.localEnd.replace('T',' ')) : ''}${one.location ? ' · ' + esc(one.location) : ''}（北京时间）</p>
        ${schedule ? `<small>${esc(schedule)}</small>` : ''}
        ${result.relation?.type === 'update' ? `<p class="agenda-linked">${job.status === 'applied' ? '已更新原事项' : '确认后更新原事项'}${result.relation.reason ? '：' + esc(result.relation.reason) : ''}</p>` : ''}
        ${result.summary ? `<p>${esc(result.summary)}</p>` : ''}
        ${one.inference ? `<p class="agenda-inference">推断依据：${esc(one.inference)}</p>` : ''}
        ${one.question ? `<p class="agenda-question">${valid ? '待核对' : '需要反馈'}：${esc(one.question)}</p>` : ''}
        ${one.evidence ? `<p>原文证据：${esc(one.evidence)}</p>` : ''}
        ${one.sourceImages?.length ? `<small>依据图 ${one.sourceImages.map(n => esc(n)).join('、')}</small>` : ''}
      </article>` : analysis ? `${pending ? '<p class="agenda-pending">上一版解读 · 正在改写</p>' : ''}<article class="agenda-card">${esc(result.analysis).split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('')}</article>` : result ? '<p>结果不完整，请反馈目标事项后重新生成。</p>' : ''}
      ${job.error ? `<p>${esc(job.error)}</p>` : ''}<div class="agenda-source-links">${sourceImages}${sourceExpiry}</div>
      ${job.feedback?.length ? `<details><summary>反馈记录 · ${job.feedback.length}</summary>${job.feedback.map(f => `<p>${esc(f.text)}</p>`).join('')}</details>` : ''}`;
    $('agendaConfirm').hidden = job.status !== 'review'||analysis; $('agendaConfirm').disabled = !valid||analysis;
    $('agendaConfirm').textContent = job.linkedItemIds?.length || result?.relation?.type === 'update' ? '确认更新原事项' : '确认此事项入表';
    const target = state.items.find(v => job.linkedItemIds?.includes(v.id)), ended = target && (target.resolvedAt != null || target.cancelledAt != null);
    $('agendaSendFeedback').disabled = job.status === 'cancelled' || ended || job.outcomeUnknown || job.executionMode==='cloud-v1'&&job.status==='running' || job.linkedItemIds?.length > 1;
    $('agendaFeedback').disabled = Boolean(ended||job.outcomeUnknown||job.executionMode==='cloud-v1'&&job.status==='running');
    if (ended) $('agendaReviewStatus').textContent = (target.cancelledAt != null ? '事项已取消' : '事项已完成') + ' · 反馈已关闭';
  }
  function editor() {
    $('agendaEditorStatus').textContent='';$('agendaStatus').hidden=true;$('agendaUploadPanel').hidden=true;$('agendaReview').hidden=true;
    editing={id:null,items:[{key:'manual',kind:'activity',title:'',localTime:local(Date.now()),localEnd:null,location:'',evidence:''}]};
    $('agendaContent').hidden=true;$('agendaEditor').hidden=false;$('agendaSource').textContent='手动添加 · 北京时间';
    $('agendaCandidates').innerHTML=`<fieldset class="agenda-candidate" data-index="0"><label>类型<select name="kind"><option value="activity">活动</option><option value="deadline">DDL</option></select></label><label>标题<input name="title" maxlength="100" required /></label><label>开始 / 截止时间<input name="time" type="datetime-local" value="${local(Date.now())}" required /></label><label>活动结束时间（可选）<input name="end" type="datetime-local" /></label><label>地点<input name="location" maxlength="200" /></label><output class="agenda-window"></output></fieldset>`;
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
      try {if(!fieldset.querySelector('[name="title"]').value.trim()){fieldset.querySelector('output').textContent='';continue;} const v=fields(fieldset); fieldset.querySelector('output').textContent = windowText(v); }
      catch(error) { fieldset.querySelector('output').textContent=error.message; }
    }
  }
  function init(change,options={}) {
    onChange=change;meetingActions=options; if(initialized) return; initialized=true;
    $('closeAgendaDetail').addEventListener('click',()=>{detailId=null;$('agendaDetailDialog').close();});
    $('agendaDetailDialog').addEventListener('close',()=>{detailId=null;});
    $('agendaDetailEnd').addEventListener('click',()=>finishDetail('resolve'));
    $('agendaDetailCancel').addEventListener('click',()=>finishDetail('cancel'));
    $('closeNonCourse').addEventListener('click',()=>$('nonCourseDialog').close());
    $('nonCourseContent').addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.popupAgenda){$('nonCourseDialog').close();openDetail(b.dataset.popupAgenda);}if(b.dataset.popupMeeting){$('nonCourseDialog').close();meetingActions.openMeeting?.(b.dataset.popupMeeting);}});
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
        review(updated);$('agendaReviewStatus').textContent='反馈已提交，等待新结果';await sync();
      }catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaConfirm').addEventListener('click',async()=>{
      const job=editing;if(!job?.id||job.result?.intent==='analysis')return;
      const button=$('agendaConfirm');button.disabled=true;
      try{await request('/agenda/commit',{id:uuid(),type:'apply',importId:job.id,revision:job.revision});message=job.linkedItemIds?.length||job.result?.relation?.type==='update'?'原事项已更新':'事项已入表';open();}
      catch(error){$('agendaReviewStatus').textContent=error.message;if(error.status===409)await sync().catch(()=>{});}
      finally{button.disabled=false;}
    });
    $('agendaCandidates').addEventListener('input',preview);
    window.AgendaUpload?.init(text=>{message=text;render();},()=>sync()).catch(error=>{message=error.message;render();});
    $('agendaEditor').addEventListener('submit',async event=>{
      event.preventDefault();
      try {
        const items=[...$('agendaCandidates').querySelectorAll('fieldset')].map(fields);
        enqueue({id:uuid(),type:'create',items});message='事项已添加';
        open();
      } catch(error) {$('agendaEditorStatus').textContent=error.message;}
    });
    $('agendaContent').addEventListener('click',async event=>{
      const b=event.target.closest('button');if(!b)return;
      try {
        if(b.dataset.agendaDetail) {openDetail(b.dataset.agendaDetail);return;}
        if(b.dataset.agendaReview) {const job=state.imports.find(v=>v.id===b.dataset.agendaReview);if(job)review(job);return;}
        if(b.dataset.importCancel) {await request('/imports/'+b.dataset.importCancel+'/cancel',{});await sync();return;}
        const id=b.dataset.agendaResolve||b.dataset.agendaCancel;
        if(id) {enqueue({id:uuid(),type:b.dataset.agendaResolve?'resolve':'cancel',itemId:id,at:Date.now()});message='已记录，正在同步。';render();}
      } catch(error) {message=error.message;render();}
    });
    window.addEventListener('online',()=>sync().catch(()=>{}));
    window.addEventListener('focus',()=>sync().catch(()=>{}));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync().catch(()=>{});});
    setInterval(()=>{if(!document.hidden){if($('agendaDialog').open&&!editing)render();if($('agendaDetailDialog').open)renderDetail();const delay=$('agendaDialog').open&&state.imports.some(v=>['queued','running'].includes(v.status))?15000:60000;if(Date.now()-lastSync>=delay)sync().catch(()=>{});}},15000);
    sync().catch(()=>{});
    if(new URLSearchParams(location.search).has('agenda'))open('digest');
  }
  function intervals(dayKey,meetings=[]) {
    const [start,end]=A.dayRange(dayKey),entries=[];
    for(const v of overlay()){
      const busy=A.displayInterval(v);if(!busy)continue;
      const from=Math.max(start,busy[0]),to=Math.min(end,busy[1]);if(to<=from)continue;
      const w=A.windows(v);entries.push({key:'agenda-'+v.id,id:v.id,type:'agenda',kind:v.kind,title:(v.kind==='deadline'?'DDL':'活动')+' · '+v.title,from,to,coreFrom:w.coreFrom,coreTo:w.coreTo,ended:v.resolvedAt!=null,time:A.timeLabel(v),value:v});
    }
    for(const v of meetings){const busy=A.meetingDisplayInterval(v);if(!busy)continue;const from=Math.max(start,busy[0]),to=Math.min(end,busy[1]);if(to<=from)continue;
      entries.push({key:'meeting-'+v.id,id:v.id,type:'meeting',kind:'meeting',title:'组会',from,to,coreFrom:v.startAt,coreTo:v.startAt+3*A.HOUR,ended:v.endAt!=null,time:A.format(v.startAt),value:v});}
    return entries;
  }
  function openGroup(key) {
    const group=popupGroups.get(key);if(!group)return;
    if(group.entries.length===1){const entry=group.entries[0];if(entry.type==='agenda')openDetail(entry.id);else meetingActions.openMeeting?.(entry.id);return;}
    $('nonCourseTitle').textContent=group.dayKey+' · '+group.entries.length+' 项安排';
    $('nonCourseContent').innerHTML=group.entries.map(v=>`<article class="agenda-card ${v.ended?'resolved':''}"><strong>${esc(v.title)}</strong><p>${esc(v.time)}</p>${v.value.location?`<p>${esc(v.value.location)}</p>`:''}<small>${v.type==='agenda'?names[A.status(v.value)]:v.ended?'已结束':Date.now()<v.value.startAt?'待开始':'进行中'}</small><button type="button" ${v.type==='meeting'?'data-popup-meeting':'data-popup-agenda'}="${esc(v.id)}">查看详情</button></article>`).join('');
    if(!$('nonCourseDialog').open)$('nonCourseDialog').showModal();
  }
  function daySummary(dayKey) {
    const entries=intervals(dayKey).filter(v=>v.value.dateStart);
    if(!entries.length)return '';
    return `<div class="day-all-day">${entries.map(v=>`<button type="button" class="all-day-chip ${v.ended?'completed':''}" data-agenda-open="${esc(v.id)}"><span>${v.ended?'已完成':v.value.dateEnd<dayKey?'未完成':'全天'}</span><strong>${esc(v.value.title)}</strong></button>`).join('')}</div>`;
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
        const label=labels.get(v.key)===v&&v.to-v.from>=20*60000?`<span class="meeting-copy"><strong>${esc(v.value.title||'组会')}${v.ended?' · '+(v.kind==='deadline'?'已达成':'已结束'):''}</strong>${v.width>=.5?`<small>${esc(time)}</small>`:''}</span>`:'';
        return `<span aria-hidden="true" class="meeting-block noncourse-strip ${size==='week'?'meeting-week':'meeting-day'} ${v.kind==='meeting'?'':'agenda-block'} ${v.kind} ${v.ended?'completed':''}" style="top:${(v.from-g.from)/(g.to-g.from)*100}%;height:${(v.to-v.from)/(g.to-g.from)*100}%;left:${v.left*100}%;width:${v.width*100}%">${segment(v.from,v.coreFrom,'meeting-extension')}${segment(v.coreFrom,v.coreTo,'meeting-solid')}${segment(v.coreTo,v.to,'meeting-extension')}${label}</span>`;
      }).join('');
      return `<div class="noncourse-region ${size}" style="top:${(g.from-start)/A.DAY*100}%;height:${(g.to-g.from)/A.DAY*100}%">${strips}<button type="button" class="noncourse-hitbox" data-noncourse-group="${esc(key)}" aria-label="展开 ${dayKey} 的 ${g.entries.length} 项安排">${size==='day'&&g.entries.length>1?`<span>${g.entries.length}</span>`:''}</button></div>`;
    }).join('');
  }
  function overlaps(dayKey,from,to,meetings=[]) {return intervals(dayKey,meetings).some(v=>v.from<to&&from<v.to);}

  window.AgendaClient={init,sync,list:overlay,blocks,daySummary,overlaps,open,openDetail,escape:esc};
})();
