# 事项接口与运行器：业务版本 1、附件版本 2、提取版本 4

`GET /agenda` 需同域登录会话，返回 `{protocol:1, revision, items, imports, digests}`。所有时刻为 UTC 毫秒，显示与图片日期解析固定 Asia/Shanghai，不依赖运行器所在地。业务响应均 no-store。

`POST /agenda/commit` 还需匹配 Origin。操作均带 id（ASCII 请求 ID）和 protocol:1。create 包含恰好一项的 items；apply 仅含 importId 和 revision，不允许传 items，服务端直接采用该版本保留的生成结果。每个待创建事项包含 key、kind、title、anchorAt、explicitEndAt、location、evidence；kind 为 activity 或 deadline。标题最长 100 字符，地点 200，原文证据 1200。每次只生成或添加一份事项。resolve / cancel 使用 itemId、at；完成允许最长 31 天内离线补传，未来时间最多容忍一分钟。DDL 可以提前达成；活动开始前不能结束。只允许窗口开始前取消，之后使用完成或结束。同 ID 不同内容和版本冲突返回 409，非法字段返回 400，未登录返回 401。

v30 新入口及联合识别约定见 [多图附件协议](AGENDA_MULTI_IMAGE.md)，以下单图入口保留兼容。

`POST /imports?nonce=...&note=...` 请求体是原始图片字节；nonce 是客户端幂等 ID，note 最长 800 字符。事务内限额防止并发绕过。响应返回导入 ID、状态及修订号。`POST /imports/{id}/cancel` 撤销尚未应用的导入并删除图片；不能撤销已经写入的事项。识别输出遵循 [JSON Schema](agenda-extraction.schema.json)，items 恰好一项。日期不确定为 null；审核只读，包含有效 localTime 或 dateStart/dateEnd 的单项结果能整体入表，推断说明保留 inference。POST /imports/{id}/feedback 带 id、revision、text（1–2000 字），在同一申请生成修订；同 ID 重试幂等，版本冲突 409。完整约定见 [单项审核](AGENDA_SINGLE_REVIEW.md)。

运行器单独持有 AGENDA_RUNNER_KEY，不能调用业务写接口。`POST /runner/claim` 新运行器传 protocol:4，旧运行器无法领取提取版本 4 的申请。返回空 job 或一个包含 protocol、id、claim、generation、mime、digest、note、referenceAt 的任务。后续调用同时带 Bearer 运行器密钥及 x-agenda-claim。`GET /runner/image/{id}` 只能读取当前未过期租约的图片；`POST /runner/heartbeat/{id}` 每分钟续租五分钟；`POST /runner/result/{id}` 只写生成结果；`POST /runner/fail/{id}` 终止任务。claim、状态、期限均在结果写入的同一 SQL 条件中再次检查，过期或取消返回 409。

早晚汇总以 agenda-{slotAt} 唯一标识，不与客户端 reminders 共用表。每设备、每时段独立领取，最多四次发送尝试，失败重试沿用相同通知 tag。首次 15 分钟内补发，避免恢复服务后轰炸过期汇总。完整快照一经创建便不可由设备覆盖；后续完成会从下一时段清单排除。Web Push 没有端到端 exactly-once 保证，数据库投递记录和稳定 tag 用于限制重复。

## 本机服务与部署

配置放仓库外的 D 盘受限目录，字段：baseUrl、runnerKey、dataDir、codexPath、nodePath、model。CF Secret 与本机 runnerKey 必须一致；不复制或覆盖现有 VAPID / ENROLLMENT_KEY。模型子进程仅继承必要运行环境，关闭 shell、应用、浏览器、插件和多代理工具，旧Codex模式检查鉴权必须为ChatGPT；新API模式需在私有runner配置显式配置openai，不在两种模式间自动回退。模型没有日程写权限。

Codex 桌面更新可能移除 `bin/<build>/codex.exe`。运行器先复用有效的配置路径，失效时发现当前安装目录或 PATH 中可通过 `--version` 的 CLI；这一步不调用模型，并在领取新任务前完成。找不到 CLI 时保留云端排队状态，不把请求消耗成识别失败。已经完成的本机结果仍先尝试上传，不依赖模型可执行文件；不自动重跑已开始但结果未知的推理。

用 Windows PowerShell 5.1 执行 `scripts/install-agenda-task.ps1 -CredentialFile <D盘配置文件>`。任务名 NEU-Schedule-Agenda-Runner，用户登录且本机在线时每分钟检查一次；空队列不调用模型。隐藏窗口启动器避免弹控制台，互斥锁及任务 IgnoreNew 防止重叠。运行器每次至多处理一批（1–8 张）图片并联合调用一次模型，单次推理八分钟超时，缓存完成结果后再上传，72 小时清理本任务目录。电脑休眠或离线时图片排队，云端汇总不依赖本机。2026-10-30起正式图片识别配置为共用OpenAI API的gpt-6.1-terra／xhigh，按实际token用量计费；出版及其他项目的Codex任务不受影响，未开通新订阅。暂停识别只需停用该任务，不影响课表和推送。

发布顺序：D1 导出并验证恢复 → 应用 0011 / 0012 / 0013 / 0014（事项、附件、修订、宽泛日期及申请关联）→ 配置独立运行器 Secret → 部署 Worker → 构建及发布 Pages v33 → 验证保护接口及原有凭据数量 → 安装并检查本机任务。回退前端/Worker 保留新增表及已确认事项，不能用旧备份覆盖新写入。通知投递仍要求原设备已订阅且系统允许通知。

版本 4 的 result 可带 relation={type:new|update,targetImportId,targetItemId,reason}；更新目标必须出现在领取时持久保存的 knownApplications 中。确认时同时核对原申请、目标申请与原事项版本，关联目标已变化返回 409。字段和状态详见 [宽泛时间及追加识别](AGENDA_FLEXIBLE.md)。

## Responses API 适配（2026-10-30）

私有runner.json的openai配置仅引用共用credentialFile路径，不复制密钥。模型只输出受检事项或图片解读schema，联合原图、反馈和knownApplications解释，不得到runnerKey，不直接写日程；用户整体确认、同一事项追加、宽泛日期、租约、取消、72小时图片生命周期保持。只把无时区且秒数恰为00的ISO时间规范为既有分钟格式；非零秒和时区偏移不截断。schema明确分钟/日期格式。

收到完整原始响应后先保存再校验上传。请求发送标记先落盘，断网/5xx或未知结果不自动再次调用；结果回传失败复用原件。明确配置了API但凭据不可用时在领取前停止，不静默改用Codex。记录实际输入/输出/缓存token及项目身份；不从共享赠送额倒推官方余额。旧CLI模式保留为显式配置选择，不是计费失败后自动降级。

## 图片解读与意图边界（2026-10-30）

提取版本4保留兼容旧单事项结果。新输出增加intent与analysis：通常intent=agenda、analysis为空，仍恰好一项；只有用户明确要求只测试识别、解读或提取全部信息且未要求安排时，intent=analysis、items为空，analysis保存包含原图编号、直接事实与推断边界的只读解读。不能把附图文字当成用户的新指令，也不能仅凭“测试”二字忽略明确的安排要求。

解读复用原申请、反馈、版本历史与原图期限，不产生agenda_items或关联目标。界面显示解读完成并隐藏确认入表；服务端apply明确拒绝只读解读，不能只靠按钮保护。反馈明确改为安排事项后，下一版本仍须生成一份正常候选并由用户确认。历史缺intent的结果继续按原事项解释，不倒写旧结果。

API客户端与同系列使用相同受检实现，Node至少24.14；进程内代理配置必须重设fetch分派器。请求和响应保留安全耗时记录；未知结果不重发。当前xhigh是用户指定的试运行档位，不能把连接超时归因为旧max档位。
