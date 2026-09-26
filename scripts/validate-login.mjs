import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const saved = new Map([['neu-schedule-data-token-v1', 'old-token']]);
const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, addEventListener(_event, listener) { this.listener = listener; } });
  return elements.get(id);
};
const markup = '<header>课表主体</header>';
const classes = new Set();
const app = { innerHTML: markup, classList: { add: v => classes.add(v), remove: v => classes.delete(v) } };
let scriptLoaded;
let windowOpen = false;
let enrolled = false;
let authenticated = false;
const requests = [];
const context = {
  window: {
    PublicKeyCredential: true,
    SimpleWebAuthnBrowser: {
      startRegistration: async () => ({ id: 'new-passkey' }),
      startAuthentication: async () => ({ id: 'new-passkey' })
    }
  },
  document: {
    getElementById: id => id === 'app' ? app : element(id),
    createElement: () => ({}),
    body: { append: script => { scriptLoaded = script.src; } }
  },
  localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key)
  },
  fetch: async (path, options) => {
    requests.push(path);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers?.authorization, undefined);
    let data;
    if (path === '/auth/status') data = { enrolled, authenticated, enrollmentOpen: windowOpen };
    else if (path === '/auth/enroll/options') {
      assert.equal(JSON.parse(options.body).setupKey, 'setup-secret');
      data = { options: {}, ticket: 'registration-ticket' };
    } else if (path === '/auth/enroll/verify') { enrolled = true; data = { ok: true }; }
    else if (path === '/auth/login/options') data = { options: {}, ticket: 'login-ticket' };
    else if (path === '/auth/login/verify') { authenticated = true; data = { ok: true }; }
    else if (path === '/schedule') {
      assert(authenticated, 'schedule is gated by login');
      data = { data: { semester: {}, courses: [], gym: {} } };
    } else throw new Error(`Unexpected path ${path}`);
    return { ok: true, status: 200, json: async () => data };
  },
  location: { origin: 'https://app.example' },
  JSON,
  console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../auth-client.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8'), context);
await new Promise(resolve => setTimeout(resolve, 0));
assert(classes.has('login-mode'));
assert.match(app.innerHTML, /窗口/);
assert.equal(scriptLoaded, undefined);
assert.equal(saved.has('neu-schedule-data-token-v1'), false);
assert(!requests.includes('/schedule'));

windowOpen = true;
await element('loginSubmit').listener();
assert.match(app.innerHTML, /初始化密钥/);
assert(!requests.includes('/schedule'));
element('setupKey').value = 'setup-secret';
await element('loginSubmit').listener();
assert.equal(scriptLoaded, './app.js?v=21');
assert.equal(context.window.AUTHENTICATED, true);
assert.equal(context.window.PUSH_API_BASE, 'https://app.example');
assert.equal(saved.has('neu-schedule-data-token-v1'), false);
console.log('Closed enrollment, passkey creation, same-origin session and data gate OK');
