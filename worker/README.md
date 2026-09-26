# Cloudflare 课表、认证与后台提醒

`gateway/` 将静态 PWA 和 API 放在同一个 Cloudflare Pages 域名。`gateway/src/_worker.js` 把 API 请求通过 Service binding 转给 `neu-schedule-push` Worker，其余请求由 Pages 静态资源服务处理。Worker 使用 D1 保存课表、用户状态、唯一通行密钥、会话和推送订阅，并由 Cron 投递提醒。

## 登录

认证状态机、接口和后台操作见 [AUTH_DESIGN.md](AUTH_DESIGN.md)。`src/auth.js` 与根目录 `auth-client.js` 是独立认证模块。业务代码只调用 `sessionFor()` 或浏览器端 `ScheduleAuth`，不处理初始化密钥和 WebAuthn 挑战。

`ENROLLMENT_KEY` 是单独的高熵 Cloudflare Secret，只在后台开启的五分钟窗口内授权登记，不能直接登录或读取数据。网页登录成功后取得同域 `HttpOnly; Secure; SameSite=Strict` Cookie；服务端会话最长 90 天。旧 `/auth/login` 永远返回 403，旧 `app_tokens` 在首次登记或后台重置时清空。`PAIRING_CODE` 已不再使用。

## 业务接口

- `GET /schedule`：凭会话读取 D1 的课程、节次和健身房开放表；网页不提供课表写入接口。
- `GET /state`、`POST /state/commit`：凭会话同步训练记录、当天翘课和视图偏好。过期翘课不能写入，Cron 清理旧日状态。
- `POST /register`：凭会话登记浏览器 PushSubscription，返回设备专用令牌。
- `POST /sync`、`/test`、`/disable`：同时验证登录会话和设备令牌，更新提醒、发送测试或撤销订阅。
- Cron `* * * * *`：领取到期任务、发送 Web Push、清理旧数据。

订阅 endpoint 限制为 Apple、Google FCM 或 Mozilla 的推送域名。课程、训练、翘课、偏好、订阅和令牌散列保存在 D1；原始设备令牌只存客户端。`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`、`VAPID_PUBLIC_KEY` 和 `ENROLLMENT_KEY` 均通过 Cloudflare Secret 配置。

## 本地验证

在 `worker/` 中运行 `pnpm install --frozen-lockfile`、`pnpm test`、`pnpm exec wrangler deploy --dry-run`、`pnpm exec wrangler d1 migrations apply neu-schedule-push --local`。本地 Worker 用 `pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8791 --var ENROLLMENT_KEY:local-test` 启动。仓库根目录的 `scripts/integration-auth-local.mjs` 验证关闭窗口；执行 `worker/admin/open-enrollment.sql` 后可验证开启窗口和完整 WebAuthn 登记/登录；`worker/admin/reset-auth.sql` 验证重置后仍为关闭状态。

## 生产部署

先备份 D1 并运行 `pnpm exec wrangler d1 migrations apply neu-schedule-push --remote`。设置高熵 `ENROLLMENT_KEY` Secret 后运行 `pnpm exec wrangler deploy`。随后在仓库根目录运行 `node worker/gateway/build.mjs`，再从 `worker/gateway/` 运行 `../node_modules/.bin/wrangler pages deploy dist --project-name neu-schedule-push-api --branch main`。保留现有 VAPID 密钥，避免无故使推送订阅失效。确认页面与 API 同域、状态为未登记且窗口关闭，再按 [AUTH_DESIGN.md](AUTH_DESIGN.md) 开启窗口。

GitHub Pages 只发布跳转页。旧主屏幕 PWA 无法沿用新域名的 Cookie、本地存储和推送订阅；新站点需重新加入主屏幕、导入训练记录并开启提醒。
