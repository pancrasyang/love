# 我们的恋爱日常 V2.0

保留原生 HTML/CSS/JavaScript、现有粉色卡片布局、手机断点和情书原文件。
新增双账号登录、云端双人心情、作者权限、私有 R2 照片；删除背景音乐。

**当前状态：25 项本地测试通过，生产数据库权限已应用，用户反馈双账号测试正常，并授权将升级版上线。新照片已成功写入 R2 关联记录，公开注册已关闭。15 张历史照片暂保留旧 Storage 显示，后续迁移并私有化；此上线不代表历史照片迁移或全部浏览器验收已完成。**
用户已明确：旧心情不迁移。本地 `loveDailyMoodRecordsV1` 保留但不读取、不上传、不删除。

## 本地验证

Node.js 22 或更高：

```sh
npm ci --ignore-scripts
node scripts/check.mjs
npm test
node scripts/build.mjs
```

测试使用 PGlite 真实 PostgreSQL/RLS（模拟 auth.users/auth.sessions）、jsdom DOM 和模拟 Worker 网络/R2。
它们不替代实际 Supabase、Workers、Vercel 及桌面/手机浏览器验收。
`tests/baseline.json` 校验情书整个文件 SHA-256，正文、原密码逻辑和动画均保持原样。

## 上线顺序

1. 在 Supabase SQL 编辑器执行 `supabase/preflight.sql`，保存结果与数据库备份到私有位置。
   核对 `daily_checkins.id` 必须为 UUID；若不是，停止并调整迁移，不能删表重建。
   现有字段应包含 id/content/created_at/photo_url/photo_path。存在额外触发器时先审查其兼容性。
2. 在 Supabase Authentication 创建或确认两个 Email + Password 用户，邮箱和密码分别独立。
   关闭 Allow new users to sign up，不启用匿名登录。在 Auth 用户列表取得对应 UUID。
3. 在维护窗口按文件名顺序执行 `supabase/migrations/` 的全部迁移，最后执行 `20261013140850_function_permissions.sql`。
   每个文件独立事务；失败会回滚该文件，先处理错误再继续。不要重复执行已成功的建表文件。
   没有删表、清空记录或猜测旧作者；历史 `author_id` 保持 NULL。
4. 用 SQL 编辑器插入两行 profiles（下方占位符仅在控制台替换），核对 UUID 和角色。
5. 在 Vercel 项目的服务端环境变量设置 `.env.example` 前四项以及服务端 `LOVE_SESSION_SECRET`。确认 Production 和所测 Preview 环境均配置。
   邮箱映射只由 `api/login.js` 使用；不要把账号密码设置为环境变量或写入源码。
6. 在 `worker/wrangler.jsonc` 中把 `ALLOWED_ORIGINS` 改为实际前端 origin，多个域名用逗号分隔。
   例如只填实际使用的 `https://完整域名`，不带路径和尾斜杠；预览域名必须单独、精确列出。
   空字符串会拒绝全部文件请求，禁止使用通配符。保留现有 `LOVE_MEDIA` → `love-media` 绑定。
   保持 R2 公共开发 URL 与公共自定义域名关闭。
7. 使用已有 Cloudflare 账号的授权部署代码到现有 Worker：

```sh
npx wrangler deploy --config worker/wrangler.jsonc
```

没有本地命令行时，可在现有 Worker 的 **Edit code** 中粘贴 `worker/dashboard-worker.mjs` 的完整内容并 Deploy；该单文件由 `node scripts/build-worker.mjs` 生成，验证脚本会检查与源码一致。保留现有 LOVE_MEDIA 绑定。Worker 的 Settings → Variables and Secrets 中设置 wrangler.jsonc 的三项 vars；这些值为项目 URL、公开 publishable key 和精确的前端域名列表，不需要服务端 key 或账号密码。部署后先检查未登录请求被拒绝，再应用剩余迁移和测试上传。

现有 Worker 已由用户连接 GitHub Workers Builds：仓库 `pancrasyang/love`，当前部署分支 `main`，根目录 `/`，构建命令 `npm test`，部署命令 `npx wrangler deploy --config worker/wrangler.jsonc`；预览构建关闭。后续该分支提交会触发自动构建部署。Worker 和网页生产分支已统一为 `main`。首次连接不会立即构建，需新提交触发；实际构建及 R2 验收结果另行记录。

8. Vercel 预览构建使用 `vercel.json`，静态部分仅输出 index.html、letter.html、assets；登录接口是 Vercel `/api/login` 服务端函数。
9. 完成下方真实验收，再进行历史照片迁移、逐项核对和旧 Storage 封闭。
10. 验收通过后合并 PR 到 main，检查 Vercel 生产部署，并在生产域名重验登录、退出、上传和照片读取。

> 权限切换会让旧版匿名页面失去数据库访问，安排短暂维护窗口。不能为维持旧页面读写而重新开放匿名 RLS。

### 绑定两个授权用户

在 Supabase SQL 编辑器执行，替换 UUID；不把实际密码粘贴到 SQL 或聊天：

```sql
begin;
insert into public.profiles(id,role) values
 ('PENGPENG_AUTH_UUID'::uuid,'pengpeng'),
 ('KAIKAI_AUTH_UUID'::uuid,'kaikai');
select id,role,display_name from public.profiles;
commit;
```

角色唯一约束与 check 限定最多两位授权用户；浏览器不能新增/改动 profiles。
`is_love_member()` 同时核查 profiles 与实时 auth.sessions，退出后旧 access token 也不能继续读取业务表。

## 历史照片迁移

仅在可信管理员终端，使用环境变量提供 Supabase 服务端 key 和 R2 迁移凭据。
实际数据库包含 14 条日常和 1 条旧地点记录，脚本覆盖两表对应的全部 15 张照片。旧地点记录只保留为授权账号可读的历史数据，当前首页不新增地点模块。

这些凭据不用于 Worker：运行时 Worker 使用 R2 Binding 和用户令牌，不需要 R2 Access Key。
不要把迁移凭据放进 Vercel 前端配置，也不要提交本地报告或任何 `.env`。

```sh
# 环境变量名称：SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY、R2_ENDPOINT、
# R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY；值从平台后台安全设置。
node scripts/migrate-photos.mjs
# 检查 migration-report.local.json，无失败再复制：
node scripts/migrate-photos.mjs --apply
# 再次执行 --apply 会复核已有链接；不会删除源文件。
```

默认 dry-run 只读。apply 下载旧文件 → 校验格式 → 写 R2 → 重新读取 R2 → 比较 SHA-256 和大小 → 建立注册信息 → 条件回填 photo_key。
任一项失败不回填；保留 photo_url/photo_path、文字、日期和旧对象。未知照片域名、超限文件或不支持的类型报告失败并保留，需单独处理。
脚本按 200 行分页，可重跑；并发已更新记录不会被覆盖。

### 一次性 GitHub Actions 迁移

没有可信本地终端时，在仓库 Settings → Secrets and variables → Actions 中配置四项 Secret：
SUPABASE_SERVICE_ROLE_KEY（支持新的 sb_secret_ 服务端 key）、R2_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY。
Supabase key 只用于迁移任务；R2 token 只授予 love-media 桶的 Object Read & Write。不要把这些值写入 Worker vars、网页、源码或聊天。
建议使用独立临时凭据。可为 legacy-media-migration 环境设置本人为 required reviewer，并限制部署分支为 main，审批所运行的具体 main 提交。

在 Actions → Migrate legacy photos to R2 → Run workflow 中选择 main，先运行 dry-run，再运行 apply。
任务只接受本仓库 main 分支，使用固定提交版本的 GitHub Actions；安装及测试步骤不注入管理员凭据。
apply 先检查全部源文件，再复制/读回/链接，最后第二遍独立核对所有关联文件。控制台及任务摘要只输出数量和状态；包含私人文件 key 的报告不公开上传。
任务不会自动删除旧对象或封闭旧 Storage。成功后应核对数据库和网页，再执行 finalize-storage.sql；随后撤销临时 R2 token / Supabase secret，并移除仓库迁移 Secrets。

所有历史照片逐项通过后，才执行 `supabase/finalize-storage.sql`。
它检查有没有遗漏，将旧 bucket 设为私有并封闭客户端旧路径访问，**不删除任何旧对象**。
在此之前，旧版已经发出的公开 Supabase 图片地址仍可能访问，不能宣称全部历史照片已私有化。

## 真实环境验收（待执行）

| 项目 | 操作与预期 |
|---|---|
| 首次进入/错误密码 | 无痕访问显示名字选择；错误密码留在入口，不查询私人记录 |
| 双账号/会话恢复 | 两个独立浏览器分别登录两人账号；刷新和重新打开恢复对应身份 |
| 退出 | 退出后清空 DOM、图片对象地址和会话；原 access token 读取 DB/R2 被拒绝 |
| 跨设备打卡 | 两端发文字/照片，另一端刷新或 30 秒内看到作者和内容 |
| 双人心情 | 两人当天分别记录，日历同日显示两个表情；北京时间午夜边界正确 |
| 心情权限 | 只能编辑自己当天心情；能删自己的历史；直接 REST 请求也不能改/删对方 |
| 日常权限 | 作者由数据库生成；直接伪造 author_id 被拒；只能编辑/删自己的记录 |
| R2 | 上传真实 JPG/PNG/WebP ≤10MB 可读；伪装类型、超大、未登录、第三账号被拒 |
| 文件删除 | 对方不可删、仍被日常引用的照片不可单独删；删自己的日常后清理 R2 |
| 故障恢复 | 上传后保存失败不丢已关联图；R2 删除失败可重试；孤立旧上传在后续登录清理 |
| 历史数据 | 迁移前后数量、文字、日期、旧字段一致；每项照片报告 hash 一致 |
| 情书 | 原密码正常、全文完整、信封和逐字动画正常；文件 hash 匹配 |
| 响应式/音乐 | 实际电脑和手机检查日历、表单、照片与弹层；无音频元素和音乐请求 |

## 运行行为与限制

- R2 文件以授权 fetch + 临时 blob URL 展示；令牌不写入图片 URL，响应不缓存，退出即撤销 blob。
- 新图按 `daily/记录UUID/作者UUID/文件UUID.扩展名` 保存；数据库有独立归属与关联校验。
- 删除先删自己的业务记录，再将文件标记 deleting、删除 R2、清理注册信息；关联/删除加锁避免误删。
- 网络离线导致服务端退出失败时，页面会隐藏并提示重试退出，不伪报已撤销服务端会话。
- 旧匿名记录显示“历史记录”，不开放修改/删除。原静态情书和外部封面延续原设计，不属于 R2 私人文件授权范围。
- 此运行环境没有可用的浏览器控制能力，因此未做真实浏览器截图、布局或端到端验收；DOM 测试不是视觉测试。

技术依据：
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、
[Supabase sessions](https://supabase.com/docs/guides/auth/sessions)、
[Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。

## Supabase SDK 本地化

首页使用同域名的 `assets/vendor/supabase-2.117.3.min.js`，不再从 jsDelivr 实时下载 SDK。依赖及打包器版本均固定在 package.json / package-lock.json；用 `node scripts/build-sdk.mjs` 重建。检查脚本会比对本地资源与锁定依赖生成的输出，构建会将本地 SDK 一起发布。
SDK 缺失或初始化失败时，`sb` 安全设为 null，私人页面保持隐藏，并显示 SDK_LOAD / SDK_INIT 与“重新加载”按钮。该修复解决脚本加载问题；浏览器的后续 Supabase 请求也已改为同源接口，实际无 VPN 的 iPhone 网络验收尚需完成。

## 生产进度（2026-10-13）

已通过 Supabase 连接核实 schema、权限和数据基线，成功应用全部七个迁移。不能重复执行已应用文件。两个 Auth 用户已创建、确认邮箱，并绑定 profiles 的 pengpeng / kaikai 角色。
Vercel 显式团队参数请求返回 403，但直接通过项目 ID 可正常访问原 love 项目。已配置并复核 Production / Preview 的四项服务端登录环境变量；邮箱映射使用 sensitive 类型，无密码写入。升级分支原提交已重新构建为 Preview，部署 `dpl_5eaBawDb966dH1s1nk84M5MWanuZ` 为 READY，main 和生产域名未切换。历史照片迁移尚待执行。

用户已反馈预览版可以正常登录，并已在后台部署 Worker 与变量，直接访问接口返回“请先登录”；错误密码、双浏览器、退出后令牌撤销及真实照片权限验收尚待逐项确认。本运行环境访问 Worker 被 Cloudflare 1010 拒绝，因此不能据此宣称已通过真实 R2 验收。

003—006 迁移逐个应用并验证：daily 14 行、spot 1 行和 Storage 15 个对象仍在；旧字段校验值保持一致，旧作者保持 NULL。匿名 REST 读取 daily_checkins / media_objects 均为 401。
生产发现 Supabase 直接授予 anon 的默认函数权限不能靠 REVOKE PUBLIC 移除，追加权限迁移已明确移除直接授予 anon 的权限，同时只开放三个经过实时身份/归属校验的认证入口。触发器不可由客户端直接调用；新增回归测试验证触发器仍正常工作。
最新核查：Supabase 公开注册已关闭（disable_signup=true），匿名登录也关闭；profiles 限制只有两位已授权账号访问业务。用户反馈双账号测试正常，数据库有一条新 R2 图片记录，作者、业务记录、状态、hash 和大小登记关系一致。14 条原日常和1条原地点的旧字段校验值保持不变。历史照片尚未迁移，旧 Storage 桶仍为公开状态。

真实上传发现可正常解码的 JPEG 在 EOI 后带 24 字节附加数据，被旧校验误拒。已改为按 JPEG 标记/扫描结构定位 EOI，支持基线和渐进式 JPEG；新上传只将完整图像码流写入 R2，移除结束标记之后的附加数据，大小及 SHA-256 均按实际写入字节登记，不重编码图片。用户样本修复前后解码像素完全一致。回归样本为生成的纯色小图，用户照片未提交仓库。历史迁移仍按原文件字节复制并比对 hash，不删源文件。


## 同源会话与 Supabase 访问

`/api/login` 保留双账号密码验证。新增 `/api/session` 管理会话恢复、续期、退出及一次性导入旧浏览器会话；加密的 `__Host-love-session` Cookie 使用 HttpOnly、Secure、SameSite=Lax。`LOVE_SESSION_SECRET` 为服务器随机密钥，Production 与 Preview 分别配置，不能进入源码；轮换该密钥会让旧 Cookie 失效。所有私人响应禁止缓存。

本地 SDK 仅生成查询，通过 `/api/data` 访问受限的业务表。后端使用 Cookie 中的真实用户访问令牌及公开 publishable key，继续由现有 RLS 决定权限，不使用管理员 key。写请求校验同源 Origin 与自定义请求头。退出会撤销当前 Auth 会话，其他标签页也会清空私人视图。

历史 Supabase 照片通过 `/api/legacy-photo` 按业务记录 ID 校验访问权限，服务器读取固定 Storage 桶，并以不超过 1MiB 的分段响应返回，兼容原有大照片。此改动不会迁移或删除旧对象，也不等于旧公开 URL 已封闭；15 张历史照片的 R2 迁移仍独立待完成。

浏览器不再向 Supabase 发送请求，也不再持久保存新会话的刷新令牌。为保留 R2 的 10MB 上传能力，短期访问令牌仅保存在页面内存中，继续直接调用现有授权 Worker。它可被同源 JavaScript 访问，并非完全隐藏于浏览器；刷新令牌只在加密 HttpOnly Cookie 内。网页样式及情书原始文件保持不变。

## V2.1 照片加载修复

照片读取使用受会话验证的 `/api/photo` 同源接口，R2 由服务器携真实用户令牌访问已有 Worker，历史 Storage 按记录授权读取。每次响应不超过1MiB；Worker新增Range/HEAD支持，较旧Worker返回整图时代理仍能截取安全大小。上传和删除继续沿用现有授权Worker通道，保留10MB上传能力。所有私人HTTP响应仍禁止公共缓存。

浏览器通过IndexedDB保存按用户UUID、来源、媒体key、内容版本区分的Blob，最多30天、总上限200MiB，过期/LRU清理。缓存仅在服务器验证当前会话和业务记录后使用。R2版本为登记SHA-256，下载完成核验SHA-256；旧照片版本来自源路径和ETag/对象信息。浏览器可能提前回收存储；不可用或超额时回退到按需网络读取。

IntersectionObserver只调度可见区域及附近照片，全页面最多两个任务；同一图片共用在途请求。文字更新保留相同图片节点和URL，焦点复核后继续补载。退出/切换账号取消任务、隐藏私人视图并撤销内存URL。删除或媒体版本变化清理旧缓存；“清除本机照片缓存”清理持久数据并通知其他标签页，随后可见照片按需重新读取。数据库里的旧地点照片也以只读卡片保留。

迁移脚本现设置并签名正确Content-Type，读回校验实际MIME、大小、SHA-256与业务关联，全部通过才条件更新photo_key；原Storage对象及字段继续保留。每项报告保留previous_photo_key，可根据复制报告和私有业务快照条件回滚，禁止整体覆盖后来发布的记录。

新增 `20261014002953_love_v21_legacy_storage_readonly.sql` 已应用生产：普通anon/authenticated角色不能上传、改写或删除love-photos旧对象，旧读取及service-role迁移通道保持可用，其他桶权限不变。旧桶仍公开，15张历史照片尚无R2关联；完整迁移和设备验收通过后再封闭旧桶公开读取，不删除原图。迁移仍需要受限的R2凭据；没有凭据不能把源文件预检写为R2迁移成功。

新增回归覆盖持久缓存、未登录隔离、LRU/TTL、清缓存与未完成下载竞争、懒加载、并发去重、焦点恢复、版本/删除失效、只读旧地点、6MiB同源Worker/R2分段链路、匿名/失效会话拒绝、Range/超时/404/503/超限诊断，以及迁移MIME不符时不关联记录。真实iPhone/安卓无VPN测试仍需要在生产设备上完成。

## 照片故障隔离与诊断

日常和历史地点分别加载，某个来源失败时显示该来源的重试入口，其余成功记录及照片继续显示。列表不完整时不执行孤立照片清理。焦点复核遇到临时身份服务故障时保留现有视图、暂停照片调度并提供“重试验证”；确认会话失效或成员资格已撤销时才清空私人视图。照片源的 401/403 只影响对应照片，旧账号已取消请求的迟到响应不能清空新账号。

Auth、profiles 和续期的 429 返回限流错误，5xx 返回服务不可用，均不使 Cookie 过期；profiles 接口的 403 与成功查询后发现成员资格已撤销分别处理。Worker 也区分上游限流、权限拒绝、网络失败和服务故障。

Vercel 接口返回 `X-Love-Request-Id`，照片接口另外保留 `X-Photo-Request-Id`，并将该编号传给 Worker。错误 JSON 包含 `request_id`、`stage`；Worker 提供阶段头时，照片代理还返回 `upstream_stage`。使用请求编号关联两端的结构化日志，检查 `auth`、`profile`、`registry`、`business`、`legacy_storage`、`worker`、`photo_body` 和 Worker 的 `r2_read` 等阶段及耗时。Vercel 上游 fetch 耗时记录到响应头返回，照片正文读取另外计时；Worker 返回流后的传输错误仍由代理正文阶段捕获。应用日志不写入令牌、Cookie、账户编号、照片路径或内容。

Worker 配置启用结构化日志，关闭自动请求调用日志，避免自动采集含照片路径的请求 URL。通过 Dashboard 粘贴 Worker 的部署方式还需在该服务设置中启用日志、关闭 Invocation logs；仓库配置仅在对应配置部署生效后应用。更新 Worker 源码后运行 `node scripts/build-worker.mjs` 同步 Dashboard 文件，再运行 `npm test`、`npm run check` 和 `node scripts/build.mjs`。本地验证不代表 Vercel、Worker 已发布或真实设备已验收；历史迁移和旧桶隐私收口仍单独进行。

照片分段现支持有上限的自动重试，以及同账号、同版本的已完成分段复用；版本变化、权限拒绝或完整性错误会丢弃未完成数据。历史来源缺少强 ETag 时保守地重新读取整图。未完成分段仅留在页面内存，超过 5 分钟不再复用，保留量上限 40MiB；每次恢复仍重新鉴权。运行 `node scripts/benchmark-photos.mjs` 可复现本地合成基准，详见[恢复边界与测量结果](docs/photo-transfer-performance.md)。鉴权请求合并、生产设备验收、历史迁移和旧桶隐私收口仍分别进行。
