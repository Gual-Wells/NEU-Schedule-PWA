import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const now = Date.parse('2026-10-19T15:10:00+08:00'), hour = 3600000;
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const clone = value => JSON.parse(JSON.stringify(value));
const activity = id => ({id,kind:'activity',title:'活动 '+id,anchorAt:now-hour,explicitEndAt:null,location:'信息B520',resolvedAt:null,cancelledAt:null});
let remote = {items:[activity('ongoing'),activity('rejected'),activity('racing'),{...activity('future'),anchorAt:now+hour},{...activity('deadline'),kind:'deadline',anchorAt:now+hour}],imports:[],digests:[]};
const nodes = new Map(), store = new Map(), requests = [];
let offline = false, rejectNext = false, releaseRead = null, holdRead = false;
const node = id => {
  if (!nodes.has(id)) nodes.set(id, {id,open:false,hidden:false,disabled:false,dataset:{},textContent:'',innerHTML:'',listeners:{},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); }
  });
  return nodes.get(id);
};
const sandbox = {Date:FixedDate,Intl,console,URLSearchParams,location:{search:''},crypto:{randomUUID:()=> 'operation-'+requests.length},
  localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)},
  document:{getElementById:node,addEventListener(){},hidden:false},
  setInterval(){},setTimeout(){},window:{addEventListener(){},ScheduleAuth:{async request(path, op) {
    if (offline) throw Object.assign(Error('网络离线'),{status:503});
    if (path === '/agenda') {
      const snapshot = clone(remote);
      if (holdRead) { holdRead = false; await new Promise(resolve=>{releaseRead=resolve;}); }
      return snapshot;
    }
    requests.push(clone(op));
    if (rejectNext) { rejectNext = false; throw Object.assign(Error('状态冲突'),{status:409}); }
    const item = remote.items.find(v=>v.id===op.itemId);
    if (op.type === 'resolve') item.resolvedAt ??= op.at;
    if (op.type === 'cancel') item.cancelledAt ??= op.at;
    return clone(remote);
  }}}
};
vm.createContext(sandbox);
for (const file of ['agenda-core.js','agenda-client.js']) vm.runInContext(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),sandbox,{filename:file});
const client = sandbox.window.AgendaClient, A = sandbox.window.ScheduleAgenda;
const flush = async () => { for (let n=0;n<4;n++) await new Promise(setImmediate); };
client.init(()=>{}); await flush();

// A running, unconfirmed item may block gym indefinitely, but its estimated
// calendar block must not turn every later date into the same activity.
assert.equal(client.blocks('2026-10-20','week'),'','running activities must not spill into tomorrow');
assert.equal(client.overlaps('2026-10-20',...A.dayRange('2026-10-20')),false,'future courses must retain their full column');
assert.equal(A.busyInterval(client.list().find(v=>v.id==='ongoing'),now)[1],Infinity,'unconfirmed gym occupancy remains open');
const legacyMeeting={id:'legacy',startAt:now-hour,endAt:null,confirmedAt:null};
assert.equal(client.blocks('2026-10-20','day',[legacyMeeting]),'','legacy meeting display must remain bounded too');

client.open();
assert.equal(node('agendaDialog').open,true);
client.open('ongoing'); await flush();
assert.equal(node('agendaDialog').open,false,'item navigation closes import/settings');
assert.equal(node('agendaDetailDialog').open,true);
assert.equal(node('agendaDetailTitle').textContent,'活动 ongoing');
assert.match(node('agendaDetailBody').innerHTML,/信息B520/);
assert.equal(node('agendaDetailEnd').textContent,'结束活动');
client.openDetail('future'); await flush();
assert.equal(node('agendaDetailEnd').disabled,true);
assert.equal(node('agendaDetailCancel').hidden,false);
node('agendaDetailEnd').listeners.click();
assert.equal(requests.length,0,'future activities cannot be ended');
client.openDetail('deadline'); await flush();
assert.equal(node('agendaDetailEnd').disabled,false,'a deadline can be achieved early');
assert.equal(node('agendaDetailEnd').textContent,'DDL 达成');

client.openDetail('ongoing'); await flush(); offline = true;
node('agendaDetailEnd').listeners.click(); await flush();
assert.equal(node('agendaDetailDialog').open,true,'ending keeps the resulting detail visible');
assert.equal(node('agendaDetailEnd').hidden,true);
assert.match(node('agendaDetailBody').innerHTML,/实际结束/);
assert.match(node('agendaDetailStatus').textContent,/等待同步/);
assert.equal(A.busyInterval(client.list().find(v=>v.id==='ongoing'),now)[1],now,'ending releases the remaining gym window locally');
node('agendaDetailEnd').listeners.click();
assert.equal(JSON.parse(store.get('neu-agenda-queue-v1')).length,1,'repeat taps do not enqueue duplicate endings');
offline = false; await client.sync(); await flush();
assert.equal(remote.items.find(v=>v.id==='ongoing').resolvedAt,now);
assert.equal(JSON.parse(store.get('neu-agenda-queue-v1')).length,0);
assert.equal(node('agendaDetailStatus').textContent,'');

client.openDetail('rejected'); await flush(); rejectNext = true;
node('agendaDetailEnd').listeners.click(); await flush();
assert.equal(node('agendaDetailEnd').hidden,false,'rejected completion restores the action');
assert.match(node('agendaDetailStatus').textContent,/操作未生效：状态冲突/);
assert.equal(client.list().find(v=>v.id==='rejected').resolvedAt,null);

holdRead = true; client.openDetail('racing');
assert.equal(typeof releaseRead,'function');
node('agendaDetailEnd').listeners.click(); releaseRead(); await flush();
assert.equal(remote.items.find(v=>v.id==='racing').resolvedAt,now,'an ending during an in-flight refresh is drained immediately');

client.openDetail('future'); await flush(); node('agendaDetailCancel').listeners.click(); await flush();
assert.equal(remote.items.find(v=>v.id==='future').cancelledAt,now);
assert.equal(node('agendaDetailCancel').hidden,true);
assert.equal(node('agendaDetailEnd').hidden,true);
remote.items=[{...activity('midnight'),anchorAt:A.localTime('2026-10-19T23:30')}];
await client.sync(); await flush();
assert.match(client.blocks('2026-10-19','day'),/midnight/,'genuine midnight activity begins on its own date');
assert.match(client.blocks('2026-10-20','day'),/midnight/,'the next date retains the real three-hour window');
assert.equal(client.overlaps('2026-10-20',A.localTime('2026-10-20T02:29'),A.localTime('2026-10-20T02:30')),true);
assert.equal(client.overlaps('2026-10-20',A.localTime('2026-10-20T02:30'),A.localTime('2026-10-20T03:00')),false,'midnight carry-over stops at its finite boundary');
assert.equal(client.blocks('2026-10-21','week'),'','a real two-date interval must not spread to a third date');
remote.imports=[{id:'read-only',status:'review',revision:1,createdAt:now,expiresAt:now+hour,images:[],result:{intent:'analysis',analysis:'12:30 外出训练\n\n16:30 外出就餐 <script>ignored</script>',items:[]}}];
await client.sync();await flush();client.open();
assert.match(node('agendaContent').innerHTML,/图片解读已完成/);
await node('agendaContent').listeners.click({target:{closest:()=>({dataset:{agendaReview:'read-only'}})}});
assert.match(node('agendaReviewResult').innerHTML,/图片解读 · 已完成/);
assert.match(node('agendaReviewResult').innerHTML,/12:30 外出训练/);
assert.match(node('agendaReviewResult').innerHTML,/&lt;script&gt;/);
assert.equal(node('agendaConfirm').hidden,true);
assert.equal(node('agendaConfirm').disabled,true);
const beforeAnalysis=requests.length;await node('agendaConfirm').listeners.click();
assert.equal(requests.length,beforeAnalysis,'read-only reports never submit an apply request');
console.log('Agenda details and read-only image analysis: navigation, offline recovery, revisions and agenda isolation OK');
