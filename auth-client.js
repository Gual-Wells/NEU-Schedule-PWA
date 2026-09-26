(() => {
  'use strict';
  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin', cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function webauthn() {
    if (!window.PublicKeyCredential || !window.SimpleWebAuthnBrowser) throw new Error('当前浏览器不支持通行密钥。请用 iPhone Safari 打开。');
    return window.SimpleWebAuthnBrowser;
  }
  async function login() {
    const browser = webauthn();
    const { options, ticket } = await request('/auth/login/options', {});
    const response = await browser.startAuthentication({ optionsJSON: options });
    return request('/auth/login/verify', { ticket, response });
  }
  async function enroll(setupKey) {
    if (!setupKey) throw new Error('请输入初始化密钥。');
    const browser = webauthn();
    const { options, ticket } = await request('/auth/enroll/options', { setupKey });
    const response = await browser.startRegistration({ optionsJSON: options });
    await request('/auth/enroll/verify', { setupKey, ticket, response });
    return login();
  }
  window.ScheduleAuth = { request, status: () => request('/auth/status'), login, enroll, logout: () => request('/auth/logout', {}) };
})();
