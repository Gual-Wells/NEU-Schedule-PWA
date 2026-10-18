export const enc = new TextEncoder();
export const MAX_IMAGE = 5 * 1024 * 1024, CHUNK = 256 * 1024;
export const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,90}$/.test(value);
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

export async function body(request, maximum = 100000) {
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
export const input = async request => JSON.parse(new TextDecoder().decode(await body(request)));

