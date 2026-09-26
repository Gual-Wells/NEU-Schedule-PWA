(() => {
  'use strict';
  const auth = window.ScheduleAuth;
  const app = document.getElementById('app');
  const appMarkup = app.innerHTML;
  const cacheKey = 'neu-schedule-data-cache-v1';
  try { localStorage.removeItem('neu-schedule-data-token-v1'); } catch {}
  window.PUSH_API_BASE = location.origin;

  function start(data) {
    window.AUTHENTICATED = true;
    window.APP_DATA = data;
    app.innerHTML = appMarkup;
    app.classList.remove('login-mode');
    const script = document.createElement('script');
    script.src = './app.js?v=21';
    document.body.append(script);
  }
  async function load() {
    const result = await auth.request('/schedule');
    if (!result.data?.semester || !Array.isArray(result.data.courses) || !result.data.gym) throw new Error('课表数据无效');
    try { localStorage.setItem(cacheKey, JSON.stringify(result.data)); } catch {}
    start(result.data);
  }
  function show(message, state) {
    app.classList.add('login-mode');
    const enrolled = state?.enrolled;
    const open = state?.enrollmentOpen;
    app.innerHTML = `<section class="login-box">
      <div class="login-head"><strong>个人课表</strong><span>NEU SCHEDULE</span></div>
      <div class="login-body">
        <p>${enrolled ? '使用已登记的通行密钥登录。' : open ? '后台登记窗口已开放，请输入初始化密钥并创建唯一的通行密钥。' : '尚无通行密钥。请先在 Cloudflare 后台打开五分钟登记窗口。'}</p>
        ${open ? '<label for="setupKey">初始化密钥</label><input id="setupKey" type="password" autocomplete="off" placeholder="输入初始化密钥" />' : ''}
        <button id="loginSubmit" type="button">${enrolled ? '使用通行密钥登录' : open ? '登记通行密钥' : '检查登记窗口'}</button>
        <p id="loginMessage" role="status"></p>
      </div>
    </section>`;
    document.getElementById('loginMessage').textContent = message;
    document.getElementById('loginSubmit').addEventListener('click', async () => {
      const button = document.getElementById('loginSubmit');
      const status = document.getElementById('loginMessage');
      button.disabled = true;
      status.textContent = enrolled ? '正在验证通行密钥…' : open ? '正在登记…' : '正在检查…';
      try {
        if (enrolled) await auth.login();
        else if (open) await auth.enroll(document.getElementById('setupKey').value.trim());
        else { await boot(); return; }
        await load();
      } catch (error) {
        try {
          const fresh = await auth.status();
          if (fresh.enrolled !== enrolled || fresh.enrollmentOpen !== open) { show(error.message || '状态已更新', fresh); return; }
        } catch {}
        status.textContent = error.message || '操作未完成';
        button.disabled = false;
      }
    });
  }
  async function boot() {
    try {
      const state = await auth.status();
      if (state.authenticated) { await load(); return; }
      show('', state);
    } catch (error) { show(`连接失败：${error.message}`, { enrolled: false, enrollmentOpen: false }); }
  }
  boot();
})();
