(() => {
  'use strict';
  const cacheKey = 'neu-schedule-data-cache-v1';
  const tokenKey = 'neu-schedule-data-token-v1';
  const base = String(window.PUSH_API_BASE || '').replace(/\/$/, '');
  const app = document.getElementById('app');
  const appMarkup = app.innerHTML;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const start = data => {
    window.APP_DATA = data;
    app.innerHTML = appMarkup;
    app.classList.remove('login-mode');
    const script = document.createElement('script');
    script.src = './app.js?v=19';
    document.body.append(script);
  };
  async function request(path, body, token) {
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
  async function load(token) {
    const result = await request('/schedule', undefined, token);
    if (!result.data?.semester || !Array.isArray(result.data.courses) || !result.data.gym) throw new Error('课表数据无效');
    write(cacheKey, JSON.stringify(result.data));
    start(result.data);
  }
  function showLogin(message = '') {
    app.classList.add('login-mode');
    app.innerHTML = `<section class="login-box">
      <div class="login-head"><strong>个人课表</strong><span>NEU SCHEDULE</span></div>
      <div class="login-body">
        <p>登录后读取课程、健身房开放表和训练记录。</p>
        <label for="loginEndpoint">后端地址</label>
        <input id="loginEndpoint" value="${base}" readonly />
        <label for="loginKey">访问密钥</label>
        <input id="loginKey" type="password" autocomplete="current-password" placeholder="输入你的配对码" />
        <button id="loginSubmit" type="button">验证并进入课表</button>
        <p id="loginMessage" role="status">${message}</p>
      </div>
    </section>`;
    document.getElementById('loginSubmit').addEventListener('click', async () => {
      const button = document.getElementById('loginSubmit');
      const message = document.getElementById('loginMessage');
      button.disabled = true;
      message.textContent = '正在验证…';
      try {
        const result = await request('/auth/login', { code: document.getElementById('loginKey').value.trim() });
        write(tokenKey, result.token);
        await load(result.token);
      } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
      }
    });
    document.getElementById('loginKey').addEventListener('keydown', event => {
      if (event.key === 'Enter') document.getElementById('loginSubmit').click();
    });
  }
  (async () => {
    let token = read(tokenKey);
    if (!token) { showLogin(); return; }
    try { await load(token); }
    catch (error) {
      if (error.status === 401) {
        write(tokenKey, '');
        write(cacheKey, '');
        showLogin('登录已失效，请重新输入密钥。');
        return;
      }
      let cached = null;
      try { cached = JSON.parse(read(cacheKey) || 'null'); } catch {}
      if (cached) start(cached);
      else showLogin('课表服务暂时不可用，请联网后再试。');
    }
  })();
})();
