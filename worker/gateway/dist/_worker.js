export default {
  fetch(request, env) {
    return env.PUSH.fetch(request);
  }
};
