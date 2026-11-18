# Supabase Storage 回切：审查与切换任务单

状态：草稿，禁止自动合并或发布。以用户修订后的范围为准：只恢复原桶现存历史文件，不复制或恢复任何 R2 后增照片。R2、旧对象和数据库记录均保留。

## 已核实的生产事实

核查时间：2026-11-18（北京时间）。GitHub main 与 zhangkk.com 当前生产版本均为 d462ff4eb96a48de8a82b0baa00bc4ef920ed625；生产部署 dpl_HLDGoobn3PxMo36x1ubs8ZWLw3TW，函数区域 iad1。数据库位于东京 ap-northeast-1。

- love-photos 有 15 个真实文件，总计 33,696,318 字节。逐个 GET 原始文件后，15/15 大小与 Storage 元数据及迁移登记一致，15/15 SHA-256 与 media_objects 原迁移登记一致。未修改对象或权限。核验利用旧桶现有公开读取能力，仅用于核查，不是应用交付方案。完整路径、哈希及引用快照保存在本地私有核查文件，未提交到仓库。
- daily_checkins 有 17 条：14 条仍保留原 Storage 路径、2 条仅有 R2 key、1 条无照片。2 条 R2 独有照片在本方案中明确不恢复。它们的 photo_key、media_objects 和文字记录均不清空、不改写、不自动删除。
- spot_checkins 当前为 0 条。旧桶中的 1 张地点照片及其 media_objects 登记仍在，但业务记录不存在。代码支持现有或经另行批准恢复的地点记录；本 PR 不凭空创建地点名称、日期、坐标或记录。完整恢复此卡片需要另外提供可核实的记录备份并明确授权。
- media_objects 有 17 条登记。不能把登记数量当作 R2 实际对象清单。Cloudflare 连接要求重新认证，未完成 R2 实际对象及衍生图枚举，也未修改 R2。用户已取消 R2 补迁移，本次不依赖 R2 清单执行任何复制或清理。
- 旧桶 public=true。旧的匿名读/上传/删除 permissive 策略还在，但 v21 restrictive 策略已禁止旧桶写入。不能只解除只读限制，否则会恢复不安全的旧公网行为。

## 最小代码变更

1. 列表优先使用 photo_path/photo_url 所指的原 Storage 文件，即便同条记录还有迁移时留下的 photo_key。前端只把记录 id/kind 交给同源 API，不把数据库中的公网 URL 写入 img.src。
2. R2-only 记录展示“照片暂不可用”占位，没有损坏图片、无限重试或 Worker 回源；文字、评论、作者控制和引用原样保留。
3. /api/photo 复用现有 authenticate、业务记录 RLS、authenticated Storage、版本和 1 MiB 分段响应；拒绝 source=r2。/api/photo-meta 和 /api/photo-thumbnail 的旧协议登录后返回 410，提示刷新；没有 Worker 调用。保留 Worker 源码作为未部署的备份，但无网站运行入口引用它。
4. 首页请求 960px WebP 缩略图，原图按钮单独请求原始字节。沿用 sharp 参数，按用户 token、路径、ETag 隔离短期内存衍生缓存（最多 32 项，60 秒）；每次先重新鉴权、查业务关联和 authenticated Storage。生成失败显式回退到原图。首次冷启动生成仍要读取原图，不能承诺冷加载必然更快。
5. IndexedDB 保留 200 MiB、30 天、账号隔离、版本校验、退出清理和失败重试。新 storage-v1 引用空间不读取旧 r2 缓存。刷新仍先做授权元数据核查，不无条件展示旧缓存。删除记录后清理对应本机缓存。
6. 新上传先经同源会话与成员核验，再用用户 JWT、publishable key 直接 POST 私有 love-photos，路径 private/<user>/<record>/<uuid>，upsert=false。照片正文不经过 Vercel，避免其请求体上限影响 10 MiB 文件；不发公开/签名下载链接。准备接口发现桶非私有即拒绝，当前生产旧桶上无法误启用上传。真实 Storage 策略与 CORS 尚需预览实测。
7. 新记录保存 photo_path，photo_url=''、photo_key=null。不写 media_objects；旧登记只读保留。原有 guard_daily 的 R2-only 插入限制必须随 SQL 提案调整，作者、长度、时间和不可变关联保护继续保留。
8. 停用 R2 自动孤儿清理和所有物理照片删除。用户主动删除自己的日常仍按原权限删除该业务记录，清本机缓存；存储原文件作为备份保留，解除业务关联后 RLS 不再允许读取。上传成功而保存失败的孤儿文件也保留且不可读，后续清理需要单独审查，不冒险在保存结果不明时删除文件。
9. 不更改登录、心情、评论、分页、文字编辑、情书或 DNS。地点功能维持当前“历史只读卡片”，没有增加原本不存在的地点上传界面。

## 权限提案（仅审查，尚未执行）

见 supabase/proposals/restore-storage.sql。它是显式人工发布步骤，不在自动迁移目录内；本 PR 没有新增自动 SQL 或自动部署工作流。

- 将 love-photos 设为私有，保留历史文件；旧公开 URL 停止提供正文。这一步需要用户另行确认，不能通过前端登录替代桶权限。
- 用 restrictive 成员/业务关联 SELECT 限制已有宽松规则；拒绝匿名与非成员读取。两名已授权成员共享业务关联照片。
- 只放行本人 record-scoped INSERT，Storage owner_id 与 auth.uid 匹配，文件扩展名受控，桶原 10 MiB/MIME 限制继续有效。原有 no-update/no-delete 继续保留，禁止覆盖或删除历史文件。
- 新日常只允许自己的 Storage 路径、禁止新公网 URL/R2 key；保留原作者和内容保护。
- 所有旧 photo_key/media_objects 不变，无业务 UPDATE/DELETE、无对象复制、无 R2 删除。

## 发布前任务（全部完成才可申请生产授权）

- [x] 固定 main 与生产 SHA；核查引用、真实 Storage 清单及所有旧文件大小/SHA-256。
- [x] 回切本地代码、合成双账号权限/缩略图/分段/IndexedDB 检查、构建检查。
- [ ] 复核 main/生产是否在审查期间发生变化；若变化，重新比对。
- [ ] 选择隔离的 Supabase 预览数据库和私有 love-photos；仅使用测试账号和样本，不把预览写请求连到生产。应复制必要表/函数/策略，执行提案后再逐项验证。上传 URL 与 publishable key 由同源后端返回，和会话所在项目一致；不能混用项目 URL/Key。
- [ ] 审核 Storage bucket GET 策略、CORS、10 MiB/MIME 限制和所有其他 storage.objects restrictive 策略。真实 Supabase API 与本地 PostgreSQL 策略测试不是同一证据。
- [ ] Vercel 预览用独立会话密钥、两个测试账号、对应 Supabase URL/Key。只可设置 preview/本分支环境；独立项目就绪后才设置 LOVE_STORAGE_PREVIEW_WRITES=isolated。代码对连接生产 Supabase 的 Vercel preview 始终拒绝业务写入，即使误设该变量；禁止改 production 环境、DNS、桶权限或生产数据库。
- [ ] 在预览分别登录两账号：历史日常缩略图、原图、地点样本；互相可看已关联文件；陌生账号/退出/撤销会话不可读；缓存刷新不下正文、账号切换/退出清理、弱网恢复、MIME/超限拒绝、9–10 MiB 实际上传、上传失败/保存失败、本人删除、他人删除拒绝。
- [ ] 浏览器 Network 检查所有照片加载、上传、删除流程：workers.dev 和 R2 请求总数为 0；R2 数据/登记数量和原引用不变。保留脱敏截图/日志。
- [ ] 地点真实记录缺失：获得可核实备份和另行授权，或明确接受“文件保留、无卡片可显示”的限制。不得伪造完整恢复已完成。
- [ ] 用户在中国大陆无代理的真实移动数据网络对比当前生产与同照片预览。见下方采样要求。不能用 Vercel/境外服务器 curl 代替。
- [ ] 展示最终预览、待执行 SQL、精确发布 SHA、核查结果及回退路径，等待明确生产发布和权限变更授权。

## 取得授权后的切换窗口（目前禁止执行）

1. 宣布短暂写入暂停，要求两账号刷新/退出旧标签，防止旧页面在切换后继续调用仍保留的 Worker。网站新版本无 R2 依赖，但未刷新的旧页面和直接 Worker 客户端无法靠本 PR 关闭。
2. 导出当前桶配置、RLS/函数定义、三表照片引用、Storage 清单及所有新旧对象备份；记录部署/代码 SHA。不要将密码、JWT、私有图片或签名链接放入 PR/日志。
3. 再次只读核对历史文件哈希、两条排除引用及 spot_count。差异出现即停止。
4. 经授权应用已预览验证的权限 SQL，确认 public=false、匿名原 URL/Authenticated API 均不返回正文；两成员已关联读取正常。不可用公开 URL 绕过问题。
5. 发布已审查提交到生产，确认自定义域名实际指向精确 SHA。刷新两账号全部客户端，确认新上传只进 Storage。
6. 用人工授权的测试记录做读/写/删除验收。删除表示业务删除并保留文件；不要自动清理 R2 或老文件。核对 DB/R2 保留项不变。
7. 在相同大陆手机移动网络补做切换后对比，保存真实证据。观察登录错误、照片失败率、上传失败和缓存情况；未达门槛即暂停扩量并按审查后的回退流程处理。

## 回退能力

- 原 main/生产 SHA、全部 R2 数据、原 Storage 文件和所有旧数据库引用保留；无需反向迁移照片。
- 回切后新照片仅有 Storage 路径，旧 V3 已支持这种 legacy 读取，但必须先预览验证兼容。禁止直接恢复“公开桶”或放开匿名规则来回退。
- 如用户明确授权退回旧 V3：短暂停写，恢复已备份的 guard_daily 定义，移除新 guard_storage_photo 触发器/函数；保留私有 Storage 的成员/关联读取与原文件，让已上传 Storage 照片仍可读。旧 V3 新 R2 写入与用户最终目标相反，必须另行明确批准；不能自动执行。
- 如仅回退本次权限/上传故障，应优先维持 Supabase 只读模式，修复预览后再恢复上传。不得丢弃新 Storage 文件或自动重放/清空旧 key。
- 删除用户主动删除的业务记录不自动撤销；恢复必须基于备份逐条审查。无照片物理删除，因此文件仍可人工恢复。

## 大陆真实移动网络对比证据

当前未取得，不能声称回切更快。建议同一手机、地点、运营商、时间段、无 VPN/代理，以生产 R2 与预览 Storage 对同样 5–10 张历史照片交替测试，各至少 10 次；冷应用缓存、暖 IndexedDB、首页缩略图、点开原图分开统计。记录城市/运营商、4G/5G、设备/浏览器、时间、字节大小、首次可见时间、原图完整时间、p50/p95、失败率及 getPhotoLoadMetrics()。避免把不同画质/字节数的结果说成同一下载速度。

建议接受门槛须用户确认：冷首页首图 p50/p95 不劣于当前、原图 p95 不劣于当前、无新增鉴权错误、暖缓存正文请求数为 0。回切后在原网络重复测试；提交脱敏结果，不上传 HAR 中的 cookie/token。

## 性能判断与未完成项

安全可行的优先路径是现有同源后端鉴权 → 私有 Supabase Storage，减少原 Vercel → Worker → Supabase 的重复跨服务查询，并保留缩略图/本机缓存。东京 Storage 加美国 Vercel 仍可能慢；本 PR 未调整函数区域或启用任何付费服务。authenticated 私有下载的 CDN 收益不能按公共对象推断。后续只有在同等权限下实测，才考虑东京预览函数或私有图片变换；任何新增配置/付费/生产改动需另行审查。

参考：[Supabase Storage 访问控制](https://supabase.com/docs/guides/storage/security/access-control)、[私有桶](https://supabase.com/docs/guides/storage/buckets/fundamentals)、[标准上传](https://supabase.com/docs/guides/storage/uploads/standard-uploads)。
