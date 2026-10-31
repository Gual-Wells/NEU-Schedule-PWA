# 图片识别的云端执行

2026-10-31 已应用0015/0016、绑定 SECOND_SERIES_OPENAI_KEY 的共享 Secrets Store 并启用 API_CLOUD_ENABLED=true；Worker 版本 c479b456-d717-41e3-beda-f4769dc29772，v42 Pages 发布为 db824bdb。本次依用户明确授权，由 root 通过官方 Wrangler stdin 从本机既有文件安全导入共用密钥，明文未进入前端、Git或日志；Worker运行时才调用 binding.get()。已有 Worker OPENAI_API_KEY 仍保留为显式兼容路径，本次实际使用受保护 Store 绑定。

开启后新建上传的 execution_mode 为 cloud-v1；旧行迁移默认 legacy，不自动改动；用户明确提交反馈时，上次结果已知且云开关启用的同一申请新代次转为 cloud-v1。正在运行或结果未知的调用不能借反馈转换。外部 /runner/claim 只领取 legacy，不能通过请求字段取得 cloud-v1。云端 scheduled 只领取 cloud-v1；不批量重排 failed、review、applied 或 cancelled 历史。正常业务确认、同一事项关联、来源、原文与推断、只读解读和明确完成语义保持。

课表原每分钟 Cron 继续负责图片清理、固定提醒、早晚汇总和到期推送。系列 api-clock Worker 每分钟通过固定 service binding 调用本 Worker 的 ScheduleAPIExecutor.run()；RPC 无参数，仅取本项目 env，各次调用拥有独立 D1 查询预算。D1 的项目锁以 CAS 领取，最长十四分钟，一次只处理一批。每批仍联合调用一次 gpt-6.1-terra／xhigh，最多 8192 输出 token、480 秒时限；五分钟业务租约每分钟续租。空队列不调用模型。推理在系列 Cron 发起的 RPC 执行中等待完成，不依赖用户 HTTP 连接或本机在线。

共用 wire runtime 为 worker/src/shared/cloud-responses.mjs，数据库由本项目独立 DB 承担。api_cloud_runs 以 project=second-schedule、申请 ID、generation 确定一次调用；API 前先保存请求摘要。原始 SSE、完整终态、实际 usage 先持久保存，再转成待确认候选。请求正文与 base64 图片不持久化到新运行表，原图只沿既有 D1 图片表首次上传后的 72 小时生命周期，不增设图片缓存。

完整响应已保存而业务回写中断时，同一 generation 可从原返回恢复 review，不调用第二次 API，也不需要重建明文 claim。取消和代次冲突不能被恢复逻辑重新打开。网络中断、5xx、断流和云端租约失效均保持 outcome_unknown；用户界面显示“结果待核对”，服务端拒绝以反馈生成新代次。仍在处理的云端任务也暂不接受反馈，待本次计费结果明确后修订。明确拒绝或已保存但格式无效的结果可由用户明确反馈另行生成；不自动重试。

旧本机任务目录中的 request.json 可能含图片副本，不迁到云端。独立净化工具只处理显式确认的课表固定任务根、原图期限已到的任务；只删除请求中的 dataURL 图片值，保留摘要、计费状态与原始 SSE/完整返回。先 dry-run、检查统计再执行，不读取凭据、不生成模型请求。

统计命令：`node scripts/clean-expired-agenda-request-images.mjs --root D:\\CodexStorage\\services\\neu-schedule-agenda\\jobs`。默认只统计，changed 必须为 0；只列计数与总字节，不输出图像、提示词或任务内容。无 sourceExpiresAt、未到期、最近十五分钟且无结束记录、链接路径和非法 JSON 均跳过。审查后才加 --apply；工具还会独立要求 Windows 旧任务状态为 Disabled，核对固定物理根及逐层真实路径后才原子替换 request.json。不得改变根目录，也不处理 SSE、完整返回、failure.json 或凭据。

发布须先核对六份既有事项及历史申请数量、确认无在途本机租约，备份 D1，再应用迁移及部署。云端开关开启、凭据绑定与保护接口验证完成后，才停用旧本机任务；停用不删除其原件或未知计费证据。真实费用依实际 token 计量，没有新订阅。是否已完成发布和真实云端验证，以发布回执为准，mock 测试不冒称生产调用成功。
