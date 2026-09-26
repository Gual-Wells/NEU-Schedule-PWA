# 单人 PWA 登录规范

本文件是未来个人 PWA 可参照的**逻辑规范**，不是跨项目共享的账号服务或代码包。每个项目独立部署自己的认证模块、密钥槽、会话库、初始化密钥和网站域名。WebAuthn 通行密钥受网站 RP ID 约束，不同域名不能默认共用一枚密钥。

## 状态机

| 状态 | 条件 | 允许的操作 |
| --- | --- | --- |
| `LOCKED_EMPTY` | 密钥槽空；窗口关闭或已过期 | 无法登录、无法登记；后台可打开窗口 |
| `ENROLLMENT_OPEN` | 密钥槽空；服务端时间未到截止点 | 只有正确初始化密钥才能获取并完成 WebAuthn 登记；不能用初始化密钥读取业务数据 |
| `ACTIVE` | 唯一密钥槽有记录 | 只允许该通行密钥完成登录；禁止登记第二枚密钥 |

首次部署与手工重置都从 `LOCKED_EMPTY` 开始。清空密钥槽绝不自动打开窗口。窗口以 D1 中毫秒时间戳为准，后台执行 `admin/open-enrollment.sql` 后开放五分钟；登记成功立即关闭。登记挑战只在窗口内有效，最多两分钟，且只能消费一次。单行主键确保只能写入一枚密钥；同时提交时只允许一个登记成功。

## 接口与会话

`GET /auth/status` 返回是否登记、是否登录以及窗口是否开放。`POST /auth/enroll/options` 和 `/auth/enroll/verify` 需要窗口与 `ENROLLMENT_KEY`；`POST /auth/login/options` 和 `/auth/login/verify` 需要槽内已有密钥。WebAuthn 后端严格校验随机挑战、来源、RP ID、签名和用户验证。`POST /auth/logout` 删除当前会话。

会话令牌仅在服务端保存 SHA-256 散列。浏览器使用同域 `__Host-neu_session` Cookie，具备 `HttpOnly; Secure; SameSite=Strict; Path=/`，有效期上限为 90 天。认证状态和课表 API 都设置 `Cache-Control: no-store`；Service Worker 不缓存这些 API。登录时创建新的会话；登出删除当前会话。D1 `auth_control.epoch` 让后台重置立即使所有旧会话无效。

业务 Worker 使用 `sessionFor(request, env)` 判定授权。初始化密钥不产生会话。推送登记要求会话；修改提醒还同时要求设备令牌。旧访问密钥登录接口永久关闭。

## 后台人工恢复

在 Cloudflare 账号内执行 `admin/reset-auth.sql`：先增加 epoch 并关闭窗口，再删除密钥、挑战、会话、旧数据令牌和推送订阅。该操作不会自动允许任何人重新登记。用户准备好设备后，执行 `admin/open-enrollment.sql`，并在五分钟内用独立初始化密钥创建新通行密钥。窗口过期则需重新执行打开操作；不要延长已有窗口。新通行密钥创建后立即登录验证。

Cloudflare 账号拥有最终恢复权限，应开启强身份验证。设备本地或旧站点曾缓存的数据无法通过服务器重置远程抹除；历史公开仓库文件也不会因此变成私有。

## 模块边界

- `src/auth.js`：唯一密钥槽、挑战、会话、窗口和认证路由。
- `migrations/0004_single_passkey.sql`：认证存储模式。
- `admin/*.sql`：只在 Cloudflare 后台手工执行的窗口与重置动作，不暴露为公网 HTTP 接口。
- 根目录 `auth-client.js`：WebAuthn 浏览器交互和同域请求。
- `bootstrap.js`：课表特有的登录界面与登录后的课表加载；可换成其他 PWA 的入口页面。
- `src/index.js`、`cloud-sync.js`、`app.js`：业务代码只消费认证结果，不保存初始化密钥。

复用到其他项目时复制**状态机、边界和验证规则**，再为各项目建立自己的 RP ID、数据库、Secret、页面入口和业务授权测试。
