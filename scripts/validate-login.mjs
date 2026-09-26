import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const saved = new Map([['neu-schedule-data-token-v1', 'old-persisted-token']]);
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, addEventListener(_event, listener) { this.listener = listener; } });
  return elements.get(id);
};
const original = '<header>课表主体</header>';
const classes = new Set();
const app = { innerHTML: original, classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
let loaded;
let requests = 0;
const context = {
  window: {},
  document: {
    getElementById: id => id === 'app' ? app : element(id),
    createElement: () => ({}),
    body: { append: script => { loaded = script.src; } }
  },
  localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  },
  fetch: async (url, options) => {
    requests++;
    assert(url.startsWith('https://backend.example/'));
    if (url.endsWith('/auth/login')) {
      assert.equal(JSON.parse(options.body).code, 'private-key');
      return { ok: true, status: 200, json: async () => ({ token: 'A'.repeat(43) }) };
    }
    assert.equal(options.headers.authorization, 'Bearer ' + 'A'.repeat(43));
    return { ok: true, status: 200, json: async () => ({ data: { semester: {}, courses: [], gym: {} } }) };
  },
  URL,
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
assert.equal(saved.has('neu-schedule-data-token-v1'), false, 'old persistent credential is removed');
assert.equal(element('loginEndpoint').value, '', 'backend address is not prefilled');
element('loginEndpoint').value = 'http://backend.example';
element('loginKey').value = 'private-key';
await element('loginSubmit').listener();
assert.equal(requests, 0, 'insecure endpoint is rejected before sending key');
element('loginEndpoint').value = 'https://backend.example';
await element('loginSubmit').listener();
assert.equal(context.window.PUSH_API_BASE, 'https://backend.example');
assert.equal(context.window.DATA_TOKEN, 'A'.repeat(43));
assert.equal(saved.has('neu-schedule-data-token-v1'), false, 'new credential stays in memory');
assert.equal(app.innerHTML, original, 'login must restore app markup before app.js runs');
assert.equal(loaded, './app.js?v=20');
for (const path of ['../index.html', '../bootstrap.js', '../cloud-sync.js', '../sw.js']) {
  assert(!fs.readFileSync(new URL(path, import.meta.url), 'utf8').includes('neu-schedule-push-api.pages.dev'), path + ' embeds backend address');
}
console.log('Manual endpoint and key gate, memory-only token, restored shell OK');
