import '../../agenda-core.js';
import { sessionFor } from './auth.js';

const A = globalThis.ScheduleAgenda;
const enc = new TextEncoder();
const MAX_IMAGE = 5 * 1024 * 1024, CHUNK = 256 * 1024;
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(value);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
const item = row => ({ id: row.id, kind: row.kind, title: row.title, anchorAt: row.anchor_at, explicitEndAt: row.explicit_end_at,
  location: row.location, evidence: row.evidence, resolvedAt: row.resolved_at, cancelledAt: row.cancelled_at, revision: row.revision });
const importView = row => ({ id: row.id, status: row.status, revision: row.revision, note: row.note, referenceAt: row.reference_at,
  createdAt: row.created_at, expiresAt: row.expires_at, error: row.error, result: row.result_json ? JSON.parse(row.result_json) : null });

async function body(request, maximum = 100000) {
  const reader = request.body?.getReader();
  if (!reader) throw Error('请求为空');
  const parts = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) { await reader.cancel(); throw Error('请求过大'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
const input = async request => JSON.parse(new TextDecoder().decode(await body(request)));

export async function agendaSnapshot(env) {
  const [rows, imports, digests, meta] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items ORDER BY anchor_at').all(),
    env.DB.prepare('SELECT * FROM agenda_imports ORDER BY created_at DESC LIMIT 30').all(),
    env.DB.prepare('SELECT * FROM agenda_digests ORDER BY slot_at DESC LIMIT 14').all(),
    env.DB.prepare('SELECT revision FROM agenda_meta WHERE id=1').first()
  ]);
  return { protocol: 1, items: rows.results.map(item), imports: imports.results.map(importView),
    digests: digests.results.map(d => ({ id: d.id, slotAt: d.slot_at, entries: JSON.parse(d.content_json) })), revision: meta.revision };
}

function insertion(env, id, value, source, key, now) {
  return env.DB.prepare('INSERT INTO agenda_items(id,kind,title,anchor_at,explicit_end_at,location,evidence,source_import_id,source_item_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, value.kind, value.title, value.anchorAt, value.explicitEndAt, value.location, value.evidence, source, key, now, now);
}

async function commit(env, op) {
  if(op.protocol!==undefined && op.protocol!==1)return json({error:'协议版本不支持，请更新课表'},409);
  if (!idOK(op.id)) return json({ error: '操作编号无效' }, 400);
  const digest = await hash(enc.encode(JSON.stringify(op)));
  const receipt = await env.DB.prepare('SELECT * FROM agenda_operations WHERE id=?').bind(op.id).first();
  if (receipt) return receipt.request_hash === digest ? json({ ok: true, ...await agendaSnapshot(env) }) : json({ error: '操作编号已被使用' }, 409);
  const now = Date.now(), commands = [];
  if (op.type === 'create' || op.type === 'apply') {
    if (!Array.isArray(op.items) || !op.items.length || op.items.length > 20) throw Error('请选择 1 至 20 个事项');
    let source = null;
    if (op.type === 'apply') {
      if (!idOK(op.importId) || !Number.isInteger(op.revision)) throw Error('导入版本无效');
      const row = await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(op.importId).first();
      if (!row || row.status !== 'review' || row.revision !== op.revision) return json({ error: '导入已更新，请刷新后确认' }, 409);
      source = row.id;
      const keys = new Set(JSON.parse(row.result_json).items.map(v => v.key));
      if (op.items.some(v => !keys.has(v.key))) throw Error('候选事项编号无效');
      commands.push(env.DB.prepare('INSERT INTO agenda_apply_guards VALUES(?,?,?)').bind(op.id, source, op.revision));
    }
    if (new Set(op.items.map(v => v.key)).size !== op.items.length) throw Error('事项编号重复');
    for (const [index, candidate] of op.items.entries()) {
      if (!idOK(candidate.key)) throw Error('事项编号无效');
      commands.push(insertion(env, 'a-' + op.id + '-' + index, A.normalizeItem(candidate, now), source, source ? candidate.key : null, now));
    }
    if (source) commands.push(env.DB.prepare("UPDATE agenda_imports SET status='applied',revision=revision+1,updated_at=? WHERE id=?").bind(now, source));
  } else if (op.type === 'resolve' || op.type === 'cancel') {
    if (!idOK(op.itemId) || !Number.isSafeInteger(op.at) || op.at > now + 60000 || op.at < now - 31 * A.DAY) throw Error('完成时间无效');
    const row = await env.DB.prepare('SELECT * FROM agenda_items WHERE id=?').bind(op.itemId).first();
    if (!row) return json({ error: '未找到事项' }, 404);
    if (op.type === 'resolve' && row.kind === 'activity' && op.at < row.anchor_at) throw Error('活动尚未开始');
    if (op.type === 'cancel' && op.at >= A.windows(item(row)).from) throw Error('事项已经开始，请使用完成或结束');
    const field = op.type === 'resolve' ? 'resolved_at' : 'cancelled_at';
    commands.push(env.DB.prepare(`UPDATE agenda_items SET ${field}=?,revision=revision+1,updated_at=? WHERE id=? AND resolved_at IS NULL AND cancelled_at IS NULL`).bind(op.at, now, row.id));
  } else throw Error('操作无效');
  // The receipt and all business changes commit in one transaction. Replays never recreate items.
  commands.unshift(env.DB.prepare('INSERT INTO agenda_operations VALUES(?,?,?,?)').bind(op.id, digest, '{}', now));
  commands.push(env.DB.prepare('UPDATE devices SET plan_hash=NULL'));
  try { await env.DB.batch(commands); }
  catch (error) {
    const replay = await env.DB.prepare('SELECT request_hash FROM agenda_operations WHERE id=?').bind(op.id).first();
    if (!replay || replay.request_hash !== digest) return json({ error: '数据已变化，请刷新后重试' }, 409);
  }
  return json({ ok: true, ...await agendaSnapshot(env) });
}

function imageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  throw Error('只支持 PNG、JPEG 或 WebP 图片');
}

function imageDimensions(bytes, mime) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let width=0,height=0;
  if(mime==='image/png' && bytes.length>=24) {width=view.getUint32(16);height=view.getUint32(20);}
  if(mime==='image/jpeg') {
    for(let p=2;p+9<bytes.length;) {
      if(bytes[p++]!==255)break;
      let marker=bytes[p++];while(marker===255)marker=bytes[p++];
      if(marker===0xd9||marker===0xda)break;
      const length=view.getUint16(p);if(length<2||p+length>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {height=view.getUint16(p+3);width=view.getUint16(p+5);break;}
      p+=length;
    }
  }
  if(mime==='image/webp'&&bytes.length>=30) {
    const kind=new TextDecoder().decode(bytes.slice(12,16));
    if(kind==='VP8X') {width=1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16);height=1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16);}
    if(kind==='VP8 ') {width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}
    if(kind==='VP8L') {const bits=view.getUint32(21,true);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  }
  if(!width||!height||width*height>16*1024*1024)throw Error('图片无效或超过 1600 万像素');
}

async function upload(request, env, url) {
  const nonce = url.searchParams.get('nonce'), note = url.searchParams.get('note') || '';
  if (!idOK(nonce) || note.length > 800) throw Error('上传编号或补充说明无效');
  const bytes = await body(request, MAX_IMAGE), mime = imageMime(bytes), digest = await hash(bytes);
  imageDimensions(bytes,mime);
  const previous = await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(nonce).first();
  if (previous) return previous.digest === digest ? json(importView(previous)) : json({ error: '上传编号已被使用' }, 409);
  const now = Date.now(), id = crypto.randomUUID();
  const commands = [env.DB.prepare("INSERT INTO agenda_imports(id,client_nonce,status,digest,mime,byte_length,note,reference_at,expires_at,created_at,updated_at) VALUES(?,?,'queued',?,?,?,?,?,?,?,?)")
    .bind(id, nonce, digest, mime, bytes.length, note, now, now + 3 * A.DAY, now, now)];
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index++) commands.push(env.DB.prepare('INSERT INTO agenda_import_chunks VALUES(?,?,?)').bind(id, index, bytes.slice(offset, offset + CHUNK).buffer));
  try { await env.DB.batch(commands); }
  catch (error) {
    const replay = await env.DB.prepare('SELECT * FROM agenda_imports WHERE client_nonce=?').bind(nonce).first();
    if (replay?.digest === digest) return json(importView(replay));
    return json({ error: '图片队列已满，请稍后重试或清理待处理图片' }, 409);
  }
  return json(importView(await env.DB.prepare('SELECT * FROM agenda_imports WHERE id=?').bind(id).first()));
}

async function storedImage(env,row) {
  const {results}=await env.DB.prepare('SELECT content FROM agenda_import_chunks WHERE import_id=? ORDER BY chunk_index').bind(row.id).all();
  const bytes=new Uint8Array(row.byte_length);let offset=0;
  for(const part of results){const b=new Uint8Array(part.content);bytes.set(b,offset);offset+=b.length;}
  if(offset!==bytes.length||await hash(bytes)!==row.digest)throw Error('图片完整性检查失败');
  return new Response(bytes,{headers:{'content-type':row.mime,'cache-control':'no-store','x-content-type-options':'nosniff'}});
}

export function validateExtraction(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > 20 || typeof value.summary !== 'string' || value.summary.length > 2000) throw Error('识别结果格式无效');
  const seen = new Set();
  const items = value.items.map(v => {
    if (!idOK(v.key) || seen.has(v.key) || !['activity','deadline'].includes(v.kind) || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 100) throw Error('识别事项无效');
    seen.add(v.key);
    for (const field of ['localTime','localEnd']) if (v[field] !== null) A.localTime(v[field]);
    if (v.kind === 'deadline' && v.localEnd !== null) throw Error('DDL 不应含活动结束时间');
    if (v.localTime && v.localEnd && A.localTime(v.localEnd) <= A.localTime(v.localTime)) throw Error('活动时间顺序无效');
    if (typeof v.location !== 'string' || v.location.length > 200 || typeof v.evidence !== 'string' || v.evidence.length > 1200 || typeof v.question !== 'string' || v.question.length > 800) throw Error('识别说明无效');
    return { key:v.key, kind:v.kind, title:v.title, localTime:v.localTime, localEnd:v.localEnd, location:v.location, evidence:v.evidence, question:v.question };
  });
  return { summary: value.summary, items };
}

async function runner(request, env, url) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!env.AGENDA_RUNNER_KEY || !token || await hash(enc.encode(token)) !== await hash(enc.encode(env.AGENDA_RUNNER_KEY))) return json({ error: '未授权' }, 401);
  const now = Date.now();
  if (url.pathname === '/runner/claim' && request.method === 'POST') {
    await cleanupAgenda(env, now);
    const row = await env.DB.prepare("SELECT * FROM agenda_imports WHERE status='queued' AND expires_at>? ORDER BY created_at LIMIT 1").bind(now).first();
    if (!row) return json({ job: null });
    const claim = crypto.randomUUID();
    const written = await env.DB.prepare("UPDATE agenda_imports SET status='running',generation=generation+1,claim_hash=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND status='queued' AND expires_at>?")
      .bind(await hash(enc.encode(claim)), now + 5 * 60000, now, row.id, now).run();
    if (!written.meta.changes) return json({ job: null });
    return json({ job: { protocol: 1, id: row.id, claim, generation: row.generation + 1, mime: row.mime, digest: row.digest, note: row.note, referenceAt: row.reference_at } });
  }
  const match = url.pathname.match(/^\/runner\/(image|heartbeat|result|fail)\/([A-Za-z0-9_-]{1,90})$/);
  if (!match) return json({ error: '未找到接口' }, 404);
  const [, action, id] = match, claim = request.headers.get('x-agenda-claim') || '';
  const row = await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND status='running' AND claim_hash=? AND lease_until>? AND expires_at>?")
    .bind(id, await hash(enc.encode(claim)), now, now).first();
  if (!row) return json({ error: '任务认领已失效' }, 409);
  if (action === 'image' && request.method === 'GET') {
    return storedImage(env,row);
  }
  if (request.method !== 'POST') return json({ error: '未找到接口' }, 404);
  let sql, args;
  if (action === 'heartbeat') {
    sql = 'lease_until=?,updated_at=?'; args = [now + 5 * 60000, now];
  } else if (action === 'result') {
    const result = validateExtraction(await input(request));
    sql = "status='review',result_json=?,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=?"; args = [JSON.stringify(result), now];
  } else if (action === 'fail') {
    sql = "status='failed',error=?,claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=?"; args = ['识别未完成，请检查本机识别服务后重新上传。', now];
  } else return json({ error: '未找到接口' }, 404);
  const written = await env.DB.prepare(`UPDATE agenda_imports SET ${sql} WHERE id=? AND status='running' AND claim_hash=? AND lease_until>? AND expires_at>?`)
    .bind(...args, id, row.claim_hash, now, now).run();
  return written.meta.changes ? json({ ok: true }) : json({ error: '任务已取消或失效' }, 409);
}

export async function agendaRoute(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  try {
    if (url.pathname.startsWith('/runner/')) return await runner(request, env, url);
    if (!await sessionFor(request, env) || (request.method !== 'GET' && request.headers.get('origin') !== env.APP_ORIGIN)) return json({ error: '请先登录' }, 401);
    if (url.pathname === '/agenda' && request.method === 'GET') return json(await agendaSnapshot(env));
    if (url.pathname === '/agenda/commit' && request.method === 'POST') return await commit(env, await input(request));
    if (url.pathname === '/imports' && request.method === 'POST') return await upload(request, env, url);
    const image=url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/image$/);
    if(image&&request.method==='GET') {
      const row=await env.DB.prepare("SELECT * FROM agenda_imports WHERE id=? AND expires_at>? AND status<>'cancelled'").bind(image[1],Date.now()).first();
      return row?storedImage(env,row):json({error:'图片已过期或不存在，原文证据仍保留'},410);
    }
    const cancel = url.pathname.match(/^\/imports\/([A-Za-z0-9_-]{1,90})\/cancel$/);
    if (cancel && request.method === 'POST') {
      await env.DB.batch([
        env.DB.prepare("UPDATE agenda_imports SET status='cancelled',claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('applied','cancelled')").bind(Date.now(), cancel[1]),
        env.DB.prepare('DELETE FROM agenda_import_chunks WHERE import_id=?').bind(cancel[1])
      ]);
      return json({ ok: true });
    }
    return json({ error: '未找到接口' }, 404);
  } catch (error) { return json({ error: error.message || '请求无效' }, 400); }
}

export async function cleanupAgenda(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("UPDATE agenda_imports SET status='failed',error='识别服务中断或图片已过期，请重新上传。',claim_hash=NULL,lease_until=NULL,revision=revision+1,updated_at=? WHERE (status='running' AND lease_until<=?) OR (status='queued' AND expires_at<=?)").bind(now, now, now),
    env.DB.prepare('DELETE FROM agenda_import_chunks WHERE import_id IN (SELECT id FROM agenda_imports WHERE expires_at<=?)').bind(now)
  ]);
}

export function digestNotice(entries) {
  const lines = A.digestText(entries).split('\n'); let text = '';
  for (const line of lines) {
    if (enc.encode(text + line).length > 2700) break;
    text += (text ? '\n' : '') + line;
  }
  if (text.split('\n').length < lines.length) text += `\n共 ${entries.length} 项，打开课表查看完整清单。`;
  return text;
}

export async function dispatchDigests(env, send, now = Date.now()) {
  // Catch up only the current slot's first 15 minutes. A stopped scheduler does not send yesterday's digest.
  const [start] = A.dayRange(A.dayKey(now));
  const slot = [start + 7*A.HOUR, start + 22*A.HOUR].find(at => at <= now && now < at + 15*60000);
  if (slot === undefined) return;
  const id = 'agenda-' + slot;
  const [rows, meetings] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items WHERE resolved_at IS NULL AND cancelled_at IS NULL').all(),
    env.DB.prepare('SELECT id,start_at,end_at,confirmed_at FROM group_meetings WHERE end_at IS NULL').all()
  ]);
  const entries = A.digest(rows.results.map(item), meetings.results.map(m => ({ id:m.id, startAt:m.start_at, endAt:m.end_at, confirmedAt:m.confirmed_at })), slot);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO agenda_digests VALUES(?,?,?,?)').bind(id, slot, JSON.stringify(entries), now),
    env.DB.prepare('INSERT OR IGNORE INTO agenda_digest_deliveries(digest_id,device_id) SELECT ?,id FROM devices WHERE created_at<=?').bind(id, slot)
  ]);
  const snapshot = await env.DB.prepare('SELECT content_json FROM agenda_digests WHERE id=?').bind(id).first();
  const bodyText = digestNotice(JSON.parse(snapshot.content_json));
  const { results } = await env.DB.prepare('SELECT x.*,d.endpoint,d.p256dh,d.auth FROM agenda_digest_deliveries x JOIN devices d ON d.id=x.device_id WHERE x.digest_id=? AND x.sent_at IS NULL AND x.attempts<4 AND (x.claim_at IS NULL OR x.claim_at<?) LIMIT 40').bind(id, now-120000).all();
  for (const row of results) {
    const claim = await env.DB.prepare('UPDATE agenda_digest_deliveries SET claim_at=?,attempts=attempts+1 WHERE digest_id=? AND device_id=? AND sent_at IS NULL AND (claim_at IS NULL OR claim_at<?)').bind(now, id, row.device_id, now-120000).run();
    if (!claim.meta.changes) continue;
    try {
      const delivered = await send(row, '未来三日 · DDL 与活动', bodyText, 3600, env, { url: (() => { const u=new URL(env.APP_URL);u.searchParams.set('agenda','digest');return u.href; })(), tag: id });
      if (delivered) await env.DB.prepare('UPDATE agenda_digest_deliveries SET sent_at=?,claim_at=NULL WHERE digest_id=? AND device_id=?').bind(now,id,row.device_id).run();
      else await env.DB.prepare('DELETE FROM devices WHERE id=?').bind(row.device_id).run();
    } catch { await env.DB.prepare('UPDATE agenda_digest_deliveries SET claim_at=NULL WHERE digest_id=? AND device_id=?').bind(id,row.device_id).run(); }
  }
}

export async function agendaBlocksGym(env, from, to, now = Date.now()) {
  const [items, meetings] = await Promise.all([
    env.DB.prepare('SELECT * FROM agenda_items WHERE cancelled_at IS NULL').all(),
    env.DB.prepare('SELECT id,start_at,end_at,confirmed_at FROM group_meetings').all()
  ]);
  return items.results.some(row => { const b=A.busyInterval(item(row), now); return b && b[0]<to && from<b[1]; }) ||
    meetings.results.some(m => { const b=A.meetingInterval({startAt:m.start_at,endAt:m.end_at,confirmedAt:m.confirmed_at},now); return b && b[0]<to && from<b[1]; });
}
