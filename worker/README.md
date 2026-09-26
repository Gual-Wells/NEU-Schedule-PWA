# Cloudflare 课表数据与后台提醒

公开接口：`https://neu-schedule-push-api.pages.dev`。Cloudflare Pages Function 通过内部 Service binding 调用 `neu-schedule-push` Worker；后者负责 Cron 和 D1。`workers.dev` 在当前网络不可达，所以页面使用免费的 `pages.dev` 子域名。

## 结构

- `POST /auth/login`：访问密钥验证后签发随机数据令牌。访问密钥只存 Cloudflare Secret，不进入浏览器持久存储。
- `POST /auth/logout`：删除当前数据令牌；数据令牌最长有效 90 天。
- `GET /schedule`：凭数据令牌读取 D1 的课程、节次和健身房开放表；未登录返回 401。网页不提供课程表写入接口。
- `GET /state`、`POST /state/commit`：凭数据令牌同步训练记录、当天翘课和视图偏好。过期翘课不能写入，Cron 会清理旧日状态。
- `POST /register`：用配对码登记浏览器 PushSubscription，返回仅此设备可用的随机令牌。
- `POST /sync`：用 Bearer 令牌提交剩余学期提醒；D1 原子替换未发送任务，相同计划跳过重写。任务经 `json_each()` 分批写入，每条 SQL 只用两个绑定参数，符合 D1 的 100 参数上限。
- `POST /test`：向当前设备发送测试通知，间隔至少一分钟。
- `POST /disable`：删除设备及其任务。
- Cron `* * * * *`：领取到期任务，发送 Web Push；失败可重试，失效订阅会删除，过期任务会清理。

Worker 只接受指定 GitHub Pages 来源的浏览器请求。订阅 endpoint 限制为 Apple、Google FCM 或 Mozilla 的推送服务域名，避免把 Worker 用作任意 HTTP 请求代理。课程、开放表、训练记录、当天翘课、偏好、订阅和令牌散列保存在 D1；原始令牌只在设备本地保存。`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`、`VAPID_PUBLIC_KEY` 和 `PAIRING_CODE` 通过 Cloudflare Secret 配置。CORS 仅限制浏览器来源，真正的访问边界是访问密钥和 Bearer 令牌。

## 本地验证与部署

需要 Node.js、pnpm、Wrangler 登录并拥有账户 Workers/D1 权限。

```sh
cd worker
pnpm install --frozen-lockfile
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler d1 migrations apply neu-schedule-push --remote
pnpm exec wrangler deploy --secrets-file /path/to/private-secrets.json
```

本地联调：先在仓库根目录运行 `node worker/scripts/seed-schedule.mjs`，然后运行 `pnpm exec wrangler d1 migrations apply neu-schedule-push --local`，再运行 `pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8791 --var PAIRING_CODE:local-test`；另开终端执行 `node scripts/integration-data-local.mjs` 与 `node scripts/integration-local.mjs`。前者验证私有课表和状态，后者使用假订阅验证推送流程。

首次部署前运行 `node scripts/generate-secrets.mjs /path/outside/repo/private-secrets.json` 生成密钥文件并保管在仓库外。已部署时**保持原 VAPID 密钥不变**，否则旧设备订阅需重新建立。`wrangler.jsonc` 中 D1 ID 是现有生产数据库；迁移到别的账户时先创建新 D1，再更新 ID 与页面的 `push-config.js`。

网关位于 `gateway/`。在该目录运行 `../node_modules/.bin/wrangler pages deploy dist --project-name neu-schedule-push-api --branch main` 可更新它。部署时 `gateway/wrangler.jsonc` 的 Service binding 必须继续指向 `neu-schedule-push`。

页面静态部署只打包根目录所需文件，不发布 `worker/` 源码或本地密钥文件。
