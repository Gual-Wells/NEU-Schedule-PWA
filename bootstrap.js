(() => {
  'use strict';
  const cacheKey = 'neu-schedule-data-cache-v1';
  const app = document.getElementById('app');
  const appMarkup = app.innerHTML;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  // v19 kept a data token across launches. Revoke that local copy before showing login.
  try { localStorage.removeItem('neu-schedule-data-token-v1'); } catch {}

  function normalizeBase(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 HTTPS 后端地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('后端地址只能是 HTTPS 站点根地址。');
    return url.origin;
  }

  async function request(base, path, body, token) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '请求失败');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const start = data => {
    window.APP_DATA = data;
    app.innerHTML = appMarkup;
    app.classList.remove('login-mode');
    const script = document.createElement('script');
    script.src = './app.js?v=20';
    document.body.append(script);
  };

  async function load(base, token) {
    const result = await request(base, '/schedule', undefined, token);
    if (!result.data?.semester || !Array.isArray(result.data.courses) || !result.data.gym) throw new Error('课表数据无效');
    write(cacheKey, JSON.stringify(result.data));
    start(result.data);
  }

  function showLogin(message = '') {
    app.classList.add('login-mode');
    app.innerHTML = `<section class="login-box">
      <div class="login-head"><strong>个人课表</strong><span>NEU SCHEDULE</span></div>
      <div class="login-body">
        <p>输入后端地址和访问密钥，验证后进入课表。地址与密钥不会保存在本机。</p>
        <label for="loginEndpoint">后端地址</label>
        <input id="loginEndpoint" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://..." />
        <label for="loginKey">访问密钥</label>
        <input id="loginKey" type="password" autocomplete="off" placeholder="输入访问密钥" />
        <button id="loginSubmit" type="button">验证并进入课表</button>
        <p id="loginMessage" role="status"></p>
      </div>
    </section>`;
    document.getElementById('loginMessage').textContent = message;
    document.getElementById('loginSubmit').addEventListener('click', async () => {
      const button = document.getElementById('loginSubmit');
      const status = document.getElementById('loginMessage');
      button.disabled = true;
      status.textContent = '正在验证…';
      try {
        const base = normalizeBase(document.getElementById('loginEndpoint').value);
        const code = document.getElementById('loginKey').value.trim();
        if (!code) throw new Error('请输入访问密钥。');
        const result = await request(base, '/auth/login', { code });
        if (!/^[A-Za-z0-9_-]{40,60}$/.test(result.token || '')) throw new Error('后端返回的凭证无效。');
        window.PUSH_API_BASE = base;
        window.DATA_TOKEN = result.token;
        try { await load(base, result.token); }
        catch (error) {
          if (error.status === 401) throw error;
          let cached = null;
          try { cached = JSON.parse(read(cacheKey) || 'null'); } catch {}
          if (!cached) throw error;
          start(cached);
        }
      } catch (error) {
        window.PUSH_API_BASE = '';
        window.DATA_TOKEN = '';
        status.textContent = error.message;
        button.disabled = false;
      }
    });
    for (const id of ['loginEndpoint', 'loginKey']) {
      document.getElementById(id).addEventListener('keydown', event => {
        if (event.key === 'Enter') document.getElementById('loginSubmit').click();
      });
    }
  }

  showLogin();
})();
