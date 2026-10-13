# 我们的恋爱日常 V2.0

保留原生 HTML/CSS/JavaScript、现有粉色卡片布局、手机断点和情书原文件。
新增双账号登录、云端双人心情、作者权限、私有 R2 照片；删除背景音乐。

**当前状态：代码及 23 项本地测试完成，生产数据库迁移和作者/文件权限已应用；用户反馈可以登录，Worker 未登录请求被拒。真实双账号照片验收和历史照片实际迁移尚未执行。请勿在完成以下顺序前合并到生产 main。旧版正式网站已不能匿名访问业务表。**
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
5. 在 Vercel 项目的服务端环境变量设置 `.env.example` 前四项。确认 Production 和所测 Preview 环境均配置。
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

## 生产进度（2026-10-13）

已通过 Supabase 连接核实 schema、权限和数据基线，成功应用全部七个迁移。不能重复执行已应用文件。两个 Auth 用户已创建、确认邮箱，并绑定 profiles 的 pengpeng / kaikai 角色。
Vercel 显式团队参数请求返回 403，但直接通过项目 ID 可正常访问原 love 项目。已配置并复核 Production / Preview 的四项服务端登录环境变量；邮箱映射使用 sensitive 类型，无密码写入。升级分支原提交已重新构建为 Preview，部署 `dpl_5eaBawDb966dH1s1nk84M5MWanuZ` 为 READY，main 和生产域名未切换。Cloudflare 部署与历史照片迁移尚待执行。

用户已反馈预览版可以正常登录，并已在后台部署 Worker 与变量，直接访问接口返回“请先登录”；错误密码、双浏览器、退出后令牌撤销及真实照片权限验收尚待逐项确认。本运行环境访问 Worker 被 Cloudflare 1010 拒绝，因此不能据此宣称已通过真实 R2 验收。

003—006 迁移逐个应用并验证：daily 14 行、spot 1 行和 Storage 15 个对象仍在；旧字段校验值保持一致，旧作者保持 NULL。匿名 REST 读取 daily_checkins / media_objects 均为 401。
生产发现 Supabase 直接授予 anon 的默认函数权限不能靠 REVOKE PUBLIC 移除，追加权限迁移已明确移除直接授予 anon 的权限，同时只开放三个经过实时身份/归属校验的认证入口。触发器不可由客户端直接调用；新增回归测试验证触发器仍正常工作。
Supabase 公开注册当前仍开启（disable_signup=false），需在 Auth 设置关闭；profiles 仍限制只有两位已授权账号访问业务。历史照片尚未迁移，旧 Storage 桶仍为公开状态。
