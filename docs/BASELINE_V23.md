# v23 功能基线

此文件固定 **2026-09-27 的应用功能版本**。后续文档提交、`main` 的更新和 Cloudflare Pages 的部署编号都不改变这份基线的身份。

| 项目 | 固定值 |
| --- | --- |
| 仓库 | `Gual-Wells/NEU-Schedule-PWA` |
| 功能提交 | `73e873906896e41f0db4b047e013cf2300622465` |
| GitHub 基线分支 | `codex/v23-baseline`，创建时指向上述提交 |
| 客户端资源版本 | `?v=23`、Service Worker 缓存 `neu-schedule-v23` |
| 正式入口 | <https://neu-schedule-push-api.pages.dev/> |
| 部署构成 | Cloudflare Pages 静态页面及网关、Worker、D1、每分钟 Cron |

**精确提交 SHA 是不可变的版本依据。** 分支是便于寻找的引用，日后可能被有写入权限的人移动；比对或复原时始终核对完整 SHA。此处没有把 v23 声称为 GitHub Release，也没有把文档提交声称为 v23 应用版本。

## 基线范围与核验

- 基线提交包含页面、课程和开放表的种子迁移、Worker、网关、测试及 GitHub Pages 旧址的 404 页面。课程和开放表运行时从 D1 读取；提交固定的是应用代码与种子数据，**不会冻结之后 D1 的实时内容、会话、训练记录、订阅或 Cron 队列**。
- 建立分支时 `main` 与 `codex/v23-baseline` 均指向上述 SHA；正式入口返回 HTTP 200，线上 `sw.js` 首行是 `neu-schedule-v23`。对 9 个静态文本文件及 3 个图标逐一比对后，图标和 5 个文本文件与基线逐字节相同，另 4 个文本文件（`index.html`、`app.js`、`sw.js`、`manifest.webmanifest`）仅 CRLF/LF 换行符不同，规范化换行后内容相同。此检查不覆盖 Worker 运行代码或 D1 实时数据。
- GitHub Pages 已停用应用入口，其工作流只发布 `legacy-404.html` 为 404 页面。正式 PWA 入口是 Cloudflare Pages。
- 该基线已通过仓库静态验证与本地认证/Worker 验证。此前在 iPhone 主屏幕版收到测试推送；v23 的登录聚焦和标签回跳修复还需要设备上的实际操作回归，静态模拟不能替代 iOS 触摸、键盘和 PWA 生命周期检查。

## 复现与变更纪律

1. 从完整提交 SHA 检出源码，安装 `worker/pnpm-lock.yaml` 锁定的依赖，在仓库根目录执行 `.github/workflows/pages.yml` 中的校验命令，并在 `worker/` 执行 `pnpm test` 与 `pnpm exec wrangler deploy --dry-run`。
2. 核对 `index.html`、`bootstrap.js`、`app.js`、`sw.js` 的资源版本一致。改动应用后应整体递增版本，不直接改写这份基线说明。
3. 生产恢复前核对目标 D1、备份和迁移。恢复应用代码不自动回滚数据库；D1 的课程、开放表和用户状态需要独立评估。
4. 新版本使用新的提交和基线文档。不要强制移动 `codex/v23-baseline`；所有对照以完整 SHA 为准。

各模块的设计、失误与复用边界见 [项目经验报告](PROJECT_EXPERIENCE.md)。
