# V2 验证记录

2026-10-13。本地 25 项测试通过：登录拒绝/允许、两个角色和会话撤销、心情日期/唯一性/权限、日常作者与旧宽松策略约束、媒体关联/删除、Worker 身份/CORS/类型/大小、迁移校验/试运行、首页身份切换/退出/迟到响应/图片正文保留、Supabase 默认函数权限收紧、JPEG 扫描结构/附加数据与上传规范化。

另外通过：所有 JavaScript 语法检查；两个 HTML 结束结构；letter.html 原始 SHA-256；静态输出构建。

已验证读取的生产现状：匿名 publishable key 可读 daily_checkins，公开注册尚未禁用。现有业务记录和照片未进行写入、删除或迁移；后续已建立两个新表，见下方进度。

未验证/未执行：真实双账号完整场景、授权 R2 上传/读取/删除、实际旧照片搬运、旧 Storage 私有化、手机/桌面浏览器视觉验收、main 合并和最终生产部署。

P1—P7 为按阶段通过本地验证后的代码提交，不表示对应生产验收已经完成。详见 README 上线顺序与真实验收表。

## 连接建立后的生产核查

Supabase 已成功应用 001/002 新表迁移，未触碰现有记录与其权限。数据基线：daily 14 条/14 张图，spot 1 条/1 张图；Storage 15 个 JPEG，总 33,696,318 字节，最大 5,700,846 字节。追加 006 保护旧地点数据，并将照片脚本扩展到该记录。

新表建立后复核：profiles/mood_records 对 anon 的 SELECT 权限为 false；daily 与 spot 全表校验和与核查前完全一致，Storage 对象数仍为 15。

后续核查：两个 Auth 用户已创建且邮箱已确认，profiles 恰有 pengpeng / kaikai 两行。Vercel 带团队参数请求 403，但按项目 ID 直接访问成功。已创建并复核 Production / Preview 的 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY、PENGPENG_EMAIL、KAIKAI_EMAIL；邮箱映射为 sensitive，无账号密码配置。升级分支提交 `8b3e45ef34c5110fc8ffb191f614fcff8ac82d5b` 重新部署为 Preview，`dpl_5eaBawDb966dH1s1nk84M5MWanuZ` 状态 READY、target 为 null。构建成功不等于真实账号或浏览器验收通过。

用户反馈预览版可以正常登录。其他登录场景和端到端权限仍待验收。Worker CORS 配置已写入实际生产域名及稳定升级预览域名；单文件 dashboard-worker.mjs 与原模块源码一致性纳入检查。Cloudflare 连接搜索无结果，尚未部署远端 Worker。

后续用户在 Cloudflare 后台部署代码与三个运行时变量，反馈未登录接口返回“请先登录”。本运行环境的远端请求返回 Cloudflare 1010，未进行真实授权文件验收。
生产依次成功应用 love_v2_daily_authors / love_v2_media / love_v2_hardening / love_v2_legacy_spots / love_v2_function_permissions。数据旧字段校验值：daily f25d16f3060663a0ce87d50116ecf3ce、spot f2e853174b8f8a6428c7a5ef68566af4，前后相同；14 条日常、1 条地点、15 个 Storage 对象均保留。匿名 REST 读 daily / media 为 401。
生产函数 ACL 复核：六个应用函数均无 anon EXECUTE；authenticated 只可执行 is_love_member / begin_media_delete / finish_media_delete，三个入口均校验实时会话，删除额外校验归属及关联。触发器助手对 authenticated 无 EXECUTE，回归确认其业务触发正常。
Advisor 中匿名 definer 提示已消失；剩余三个 authenticated definer 提示属于有意授权的入口（严格检查实时身份/归属，固定 search_path），参考 [0029 说明](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)。另有未开启[泄露密码保护](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)的提示，未修改 Auth 配置。
公开注册仍开启（disable_signup=false），需后台关闭。旧照片迁移和旧 Storage 封闭未执行。

真实 JPEG 上传失败已复现：用户原图 178,879 字节、1279×1706 像素，JPEG 图像码流在 178,855 字节处结束，后有 24 字节附加数据。原校验要求 EOI 位于文件末尾，误报非 JPEG。修复后按分段和扫描定位 EOI；原图通过校验，去尾处理前后尺寸和解码像素完全相同。新增测试覆盖渐进扫描、元数据中嵌入 EOI 字节、截断、伪 MIME、R2 实际字节/大小/hash；使用生成纯色图，无用户照片进入公开仓库。完整 25 项测试、语法及原情书 hash 检查通过。远端 Worker 仍需部署本次修复，再执行实际照片验收。

用户截图确认现有 love-media-api 已连接 GitHub 仓库 pancrasyang/love，部署分支 upgrade/v2。后台提示提交新 commit 后开始首次构建。本记录提交用于触发第一次自动部署；连接成功不等于构建或远端上传验收成功。
