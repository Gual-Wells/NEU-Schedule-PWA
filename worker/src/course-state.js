// Explicit restored-attendance IDs in the existing D1 daily_skips JSON column.
const MODE = 'default-skip-v1';
export function encodeRestores(ids) {
  return JSON.stringify({ mode: MODE, ids: [...new Set(ids)] });
}
export function decodeRestores(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || Array.isArray(value) || value.mode !== MODE || !Array.isArray(value.ids)) return [];
  return [...new Set(value.ids.filter(id => Number.isInteger(id) && id >= 0 && id < 300))];
}
