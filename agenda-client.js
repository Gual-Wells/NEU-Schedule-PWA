(() => {
  'use strict';
  const A = window.ScheduleAgenda, $ = id => document.getElementById(id);
  const KEY = 'neu-agenda-v1', QUEUE = 'neu-agenda-queue-v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
  let state = read(KEY, { items: [], imports: [], digests: [] }), queue = read(QUEUE, []);
  let onChange = () => {}, busy = null, editing = null, message = '', initialized = false;
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
  function changed() { onChange(); if ($('agendaDialog')?.open && !editing) render(); }
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
      state = await request('/agenda'); save(); changed();
    })().catch(error => { message = '等待同步：' + error.message; changed(); throw error; }).finally(() => { busy = null; });
    return busy;
  }
  function enqueue(op) { queue.push(op); save(); changed(); sync().catch(() => {}); }
  const names = {planned:'待开始',warning:'预警中',urgent:'距截止不足一小时',overdue:'已逾期 · 待达成',ongoing:'进行中',extended:'预计时间内',unconfirmed:'超时 · 待结束',resolved:'已完成',cancelled:'已取消'};
  function render() {
    if (!$('agendaContent')) return;
    const items = overlay(), pending = items.filter(v => v.resolvedAt == null && v.cancelledAt == null), done = items.filter(v => !pending.includes(v));
    $('agendaStatus').textContent = message || (queue.length ? `${queue.length} 项操作等待同步` : '每天 07:00 / 22:00 汇总未来 72 小时及逾期未完成事项。');
    const cards = list => list.map(v => {
      const status=A.status(v), w=A.windows(v), ended=v.resolvedAt!=null||v.cancelledAt!=null;
      return `<article class="agenda-card ${esc(status)}"><strong>${v.kind==='deadline'?'DDL':'活动'} · ${esc(v.title)}</strong><p>${A.format(v.anchorAt)}${v.explicitEndAt?'—'+A.format(v.explicitEndAt):''}${v.location?' · '+esc(v.location):''}</p><small>${names[status]} · 占用 ${A.format(w.from)} 起${!ended&&Date.now()>=w.from?'，直至确认结束':''}</small>${v.evidence?`<details><summary>来源说明</summary><p>${esc(v.evidence)}</p></details>`:''}<div class="push-actions">${!ended&&(v.kind==='deadline'||Date.now()>=v.anchorAt)?`<button type="button" data-agenda-resolve="${esc(v.id)}">${v.kind==='deadline'?'DDL 达成':'结束活动'}</button>`:''}${!ended&&Date.now()<w.from?`<button type="button" data-agenda-cancel="${esc(v.id)}">取消安排</button>`:''}</div></article>`;
    }).join('');
    const importNames={queued:'等待本机识别',running:'正在识别',review:'待确认入表',applied:'已入表',failed:'识别未完成',cancelled:'已取消'};
    $('agendaContent').innerHTML = `<h3>待处理事项 · ${pending.length}</h3>${cards(pending)||'<p>暂无待处理事项，可从图片导入或手动添加。</p>'}<h3>图片导入</h3>${state.imports.filter(v=>v.status!=='cancelled').map(v=>`<article class="agenda-card"><strong>${importNames[v.status]}</strong><small>${A.format(v.createdAt)}${v.error?' · '+esc(v.error):''}</small><div class="push-actions">${v.status==='review'?`<button type="button" data-agenda-review="${esc(v.id)}">检查并入表</button>`:''}${v.status!=='applied'?`<button type="button" data-import-cancel="${esc(v.id)}">取消导入</button>`:''}</div></article>`).join('')||'<p>尚无图片导入记录。</p>'}<details><summary>已完成或取消 · ${done.length}</summary>${cards(done)}</details><h3 id="agendaDigestHeading">早晚汇总</h3>${state.digests.map(v=>`<details class="agenda-card"><summary>${A.format(v.slotAt)} · ${v.entries.length} 项</summary><pre>${esc(A.digestText(v.entries))}</pre></details>`).join('')||'<p>第一份汇总将在下一个 07:00 或 22:00 生成。</p>'}`;
  }
  function open(id) {
    editing = null; $('agendaEditor').hidden = true; $('agendaContent').hidden = false;
    render(); if (!$('agendaDialog').open) $('agendaDialog').showModal();
    sync().catch(()=>{});
    if (id === 'digest') setTimeout(()=>$('agendaDigestHeading')?.scrollIntoView({block:'start'}),100);
  }
  function editor(job = null) {
    $('agendaEditorStatus').textContent = '';
    editing = job || { id: null, items: [{key:'manual',kind:'activity',title:'',localTime:local(Date.now()),localEnd:null,location:'',evidence:'',question:''}] };
    const result = job?.result || editing;
    $('agendaContent').hidden=true; $('agendaEditor').hidden=false;
    $('agendaSource').replaceChildren();
    if(job?.id){const link=document.createElement('a');link.href='/imports/'+encodeURIComponent(job.id)+'/image';link.target='_blank';link.rel='noopener';link.textContent='打开原图核对（上传后保留 72 小时）';$('agendaSource').append(link);}
    $('agendaCandidates').innerHTML = `<p>${esc(result.summary || '所有时间均为北京时间。活动默认向后三小时，DDL 默认向前三小时。')}</p>` + result.items.map((v,i)=>`<fieldset class="agenda-candidate" data-index="${i}"><label class="agenda-check"><input type="checkbox" name="selected" checked /> 导入此项</label><label>类型<select name="kind"><option value="activity" ${v.kind==='activity'?'selected':''}>活动</option><option value="deadline" ${v.kind==='deadline'?'selected':''}>DDL</option></select></label><label>标题<input name="title" maxlength="100" value="${esc(v.title)}" /></label><label>开始 / 截止时间<input name="time" type="datetime-local" value="${esc(v.localTime||'')}" /></label><label>明确的活动结束时间（可选）<input name="end" type="datetime-local" value="${esc(v.localEnd||'')}" /></label><label>地点<input name="location" maxlength="200" value="${esc(v.location)}" /></label>${v.question?`<p class="agenda-question">待核实：${esc(v.question)}</p>`:''}${v.evidence?`<p>${esc(v.evidence)}</p>`:''}<output class="agenda-window"></output></fieldset>`).join('') || '<p>未识别到事项。可返回后手动添加。</p>';
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
  async function upload(file) {
    if (!file) throw Error('请选择图片');
    if (file.size>20*1024*1024) throw Error('原图超过 20 MB，请先缩小图片');
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width*bitmap.height>16*1024*1024) throw Error('图片超过 1600 万像素，请先裁剪');
      const scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height)), canvas=document.createElement('canvas');
      canvas.width=Math.round(bitmap.width*scale); canvas.height=Math.round(bitmap.height*scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));
      if (!blob||blob.size>5*1024*1024) throw Error('压缩后图片仍超过 5 MB，请裁剪后重试');
      const nonce=uuid(), note=$('agendaNote').value;
      const response=await fetch(`/imports?nonce=${nonce}&note=${encodeURIComponent(note)}`, {method:'POST',credentials:'same-origin',headers:{'content-type':'image/jpeg'},body:blob});
      const data=await response.json(); if(!response.ok) throw Error(data.error||'上传失败');
      message='图片已上传，等待本机识别。可关闭面板，稍后查看候选事项。';
      await sync();
    } finally { bitmap.close(); }
  }
  function init(change) {
    onChange=change; if(initialized) return; initialized=true;
    $('agendaButton').addEventListener('click',()=>open());
    $('closeAgenda').addEventListener('click',()=>{editing=null;$('agendaDialog').close();});
    $('agendaRefresh').addEventListener('click',()=>sync().catch(()=>{}));
    $('agendaManual').addEventListener('click',()=>editor());
    $('agendaBack').addEventListener('click',()=>open());
    $('agendaCandidates').addEventListener('input',preview);
    $('agendaUpload').addEventListener('click',async()=>{
      $('agendaUpload').disabled=true;message='正在上传…';render();
      try { await upload($('agendaImage').files[0]); } catch(error) { message=error.message;render(); }
      finally { $('agendaUpload').disabled=false; }
    });
    $('agendaEditor').addEventListener('submit',async event=>{
      event.preventDefault();
      try {
        const items=[...$('agendaCandidates').querySelectorAll('fieldset')].filter(f=>f.querySelector('[name="selected"]').checked).map(fields);
        if(!items.length) throw Error('请至少选择一项，或返回取消导入');
        const op={id:uuid(),type:editing.id?'apply':'create',items};
        if(editing.id) {op.importId=editing.id;op.revision=editing.revision;await request('/agenda/commit',op);message='所选事项已入表。';}
        else {enqueue(op);message='事项已添加。';}
        open();
      } catch(error) {$('agendaEditorStatus').textContent=error.message;}
    });
    $('agendaContent').addEventListener('click',async event=>{
      const b=event.target.closest('button');if(!b)return;
      try {
        if(b.dataset.agendaReview) {const job=state.imports.find(v=>v.id===b.dataset.agendaReview);if(job)editor(job);return;}
        if(b.dataset.importCancel) {await request('/imports/'+b.dataset.importCancel+'/cancel',{});await sync();return;}
        const id=b.dataset.agendaResolve||b.dataset.agendaCancel;
        if(id) {enqueue({id:uuid(),type:b.dataset.agendaResolve?'resolve':'cancel',itemId:id,at:Date.now()});message='已记录，正在同步。';render();}
      } catch(error) {message=error.message;render();}
    });
    window.addEventListener('online',()=>sync().catch(()=>{}));
    window.addEventListener('focus',()=>sync().catch(()=>{}));
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync().catch(()=>{});});
    setInterval(()=>{if(!document.hidden){if($('agendaDialog').open&&!editing)render();sync().catch(()=>{});}},60000);
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
