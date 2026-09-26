export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/auth/') || ['/health', '/config', '/schedule', '/state', '/state/commit', '/register', '/sync', '/test', '/disable'].includes(path)) {
      return env.PUSH.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
