import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const saved = new Map();
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, addEventListener(_event, listener) { this.listener = listener; } });
  return elements.get(id);
};
const original = '<header>课表主体</header>';
const classes = new Set();
const app = { innerHTML: original, classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
let loaded;
const context = {
  window: { PUSH_API_BASE: 'https://backend.example' },
  document: {
    getElementById: id => id === 'app' ? app : element(id),
    createElement: () => ({}),
    body: { append: script => { loaded = script.src; } }
  },
  localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value)
  },
  fetch: async (url, options) => {
    if (url.endsWith('/auth/login')) {
      assert.equal(JSON.parse(options.body).code, 'private-key');
      return { ok: true, status: 200, json: async () => ({ token: 'data-token' }) };
    }
    assert.equal(options.headers.authorization, 'Bearer data-token');
    return { ok: true, status: 200, json: async () => ({ data: { semester: {}, courses: [], gym: {} } }) };
  },
  JSON,
  console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8'), context);
await new Promise(resolve => setTimeout(resolve, 0));
assert(classes.has('login-mode'));
assert.match(app.innerHTML, /后端地址/);
assert.match(app.innerHTML, /访问密钥/);
assert.equal(loaded, undefined, 'app must not load before login');
element('loginKey').value = 'private-key';
await element('loginSubmit').listener();
assert.equal(saved.get('neu-schedule-data-token-v1'), 'data-token');
assert.equal(app.innerHTML, original, 'login must restore app markup before app.js runs');
assert.equal(loaded, './app.js?v=19');
console.log('Login gate and restored app shell OK');
