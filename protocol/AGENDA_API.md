# 事项接口与运行器：业务版本 1、附件版本 2、提取版本 4

`GET /agenda` 需同域登录会话，返回 `{protocol:1, revision, items, imports, digests}`。所有时刻为 UTC 毫秒，显示与图片日期解析固定 Asia/Shanghai，不依赖运行器所在地。业务响应均 no-store。

`POST /agenda/commit` 还需匹配 Origin。操作均带 id（ASCII 请求 ID）和 protocol:1。create 包含恰好一项的 items；apply 仅含 importId 和 revision，不允许传 items，服务端直接采用该版本保留的生成结果。每个待创建事项包含 key、kind、title、anchorAt、explicitEndAt、location、evidence；kind 为 activity 或 deadline。标题最长 100 字符，地点 200，原文证据 1200。每次只生成或添加一份事项。resolve / cancel 使用 itemId、at；完成允许最长 31 天内离线补传，未来时间最多容忍一分钟。DDL 可以提前达成；活动开始前不能结束。只允许窗口开始前取消，之后使用完成或结束。同 ID 不同内容和版本冲突返回 409，非法字段返回 400，未登录返回 401。

v30 新入口及联合识别约定见 [多图附件协议](AGENDA_MULTI_IMAGE.md)，以下单图入口保留兼容。

`POST /imports?nonce=...&note=...` 请求体是原始图片字节；nonce 是客户端幂等 ID，note 最长 800 字符。事务内限额防止并发绕过。响应返回导入 ID、状态及修订号。`POST /imports/{id}/cancel` 撤销尚未应用的导入并删除图片；不能撤销已经写入的事项。识别输出遵循 [JSON Schema](agenda-extraction.schema.json)，items 恰好一项。日期不确定为 null；审核只读，包含有效 localTime 或 dateStart/dateEnd 的单项结果能整体入表，推断说明保留 inference。POST /imports/{id}/feedback 带 id、revision、text（1–2000 字），在同一申请生成修订；同 ID 重试幂等，版本冲突 409。完整约定见 [单项审核](AGENDA_SINGLE_REVIEW.md)。

运行器单独持有 AGENDA_RUNNER_KEY，不能调用业务写接口。`POST /runner/claim` 新运行器传 protocol:4，旧运行器无法领取提取版本 4 的申请。返回空 job 或一个包含 protocol、id、claim、generation、mime、digest、note、referenceAt 的任务。后续调用同时带 Bearer 运行器密钥及 x-agenda-claim。`GET /runner/image/{id}` 只能读取当前未过期租约的图片；`POST /runner/heartbeat/{id}` 每分钟续租五分钟；`POST /runner/result/{id}` 只写生成结果；`POST /runner/fail/{id}` 终止任务。claim、状态、期限均在结果写入的同一 SQL 条件中再次检查，过期或取消返回 409。

早晚汇总以 agenda-{slotAt} 唯一标识，不与客户端 reminders 共用表。每设备、每时段独立领取，最多四次发送尝试，失败重试沿用相同通知 tag。首次 15 分钟内补发，避免恢复服务后轰炸过期汇总。完整快照一经创建便不可由设备覆盖；后续完成会从下一时段清单排除。Web Push 没有端到端 exactly-once 保证，数据库投递记录和稳定 tag 用于限制重复。

## 本机服务与部署

配置放仓库外的 D 盘受限目录，字段：baseUrl、runnerKey、dataDir、codexPath、nodePath、model。CF Secret 与本机 runnerKey 必须一致；不复制或覆盖现有 VAPID / ENROLLMENT_KEY。模型子进程仅继承必要运行环境，关闭 shell、应用、浏览器、插件和多代理工具，且检查当前鉴权必须为 ChatGPT；不回退计费 API。模型没有日程写权限。

用 Windows PowerShell 5.1 执行 `scripts/install-agenda-task.ps1 -CredentialFile <D盘配置文件>`。任务名 NEU-Schedule-Agenda-Runner，用户登录且本机在线时每分钟检查一次；空队列不调用模型。隐藏窗口启动器避免弹控制台，互斥锁及任务 IgnoreNew 防止重叠。运行器每次至多处理一批（1–8 张）图片并联合调用一次模型，单次推理八分钟超时，缓存完成结果后再上传，72 小时清理本任务目录。电脑休眠或离线时图片排队，云端汇总不依赖本机。使用现有 ChatGPT 配额，新增 D1/Worker 用量，未开通新的付费产品。暂停识别只需停用该任务，不影响课表和推送。

发布顺序：D1 导出并验证恢复 → 应用 0011 / 0012 / 0013 / 0014（事项、附件、修订、宽泛日期及申请关联）→ 配置独立运行器 Secret → 部署 Worker → 构建及发布 Pages v33 → 验证保护接口及原有凭据数量 → 安装并检查本机任务。回退前端/Worker 保留新增表及已确认事项，不能用旧备份覆盖新写入。通知投递仍要求原设备已订阅且系统允许通知。

版本 4 的 result 可带 relation={type:new|update,targetImportId,targetItemId,reason}；更新目标必须出现在领取时持久保存的 knownApplications 中。确认时同时核对原申请、目标申请与原事项版本，关联目标已变化返回 409。字段和状态详见 [宽泛时间及追加识别](AGENDA_FLEXIBLE.md)。
