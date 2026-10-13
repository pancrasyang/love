# V2 验证记录

2026-10-13。本地 22 项测试通过：登录拒绝/允许、两个角色和会话撤销、心情日期/唯一性/权限、日常作者与旧宽松策略约束、媒体关联/删除、Worker 身份/CORS/类型/大小、迁移校验/试运行、首页身份切换/退出/迟到响应/图片正文保留。

另外通过：所有 JavaScript 语法检查；两个 HTML 结束结构；letter.html 原始 SHA-256；静态输出构建。

已验证读取的生产现状：匿名 publishable key 可读 daily_checkins，公开注册尚未禁用。现有业务记录和照片未进行写入、删除或迁移；后续已建立两个新表，见下方进度。

未验证/未执行：真实两账号登录、其余生产表权限切换、Cloudflare 生产 Worker 部署、实际 R2 搬运、旧 Storage 私有化、手机/桌面浏览器视觉验收、main 合并和最终生产部署。

P1—P7 为按阶段通过本地验证后的代码提交，不表示对应生产验收已经完成。详见 README 上线顺序与真实验收表。

## 连接建立后的生产核查

Supabase 已成功应用 001/002 新表迁移，未触碰现有记录与其权限。数据基线：daily 14 条/14 张图，spot 1 条/1 张图；Storage 15 个 JPEG，总 33,696,318 字节，最大 5,700,846 字节。追加 006 保护旧地点数据，并将照片脚本扩展到该记录。

新表建立后复核：profiles/mood_records 对 anon 的 SELECT 权限为 false；daily 与 spot 全表校验和与核查前完全一致，Storage 对象数仍为 15。

后续核查：两个 Auth 用户已创建且邮箱已确认，profiles 恰有 pengpeng / kaikai 两行。Vercel 带团队参数请求 403，但按项目 ID 直接访问成功。已创建并复核 Production / Preview 的 SUPABASE_URL、SUPABASE_PUBLISHABLE_KEY、PENGPENG_EMAIL、KAIKAI_EMAIL；邮箱映射为 sensitive，无账号密码配置。升级分支提交 `8b3e45ef34c5110fc8ffb191f614fcff8ac82d5b` 重新部署为 Preview，`dpl_5eaBawDb966dH1s1nk84M5MWanuZ` 状态 READY、target 为 null。构建成功不等于真实账号或浏览器验收通过。

用户反馈预览版可以正常登录。其他登录场景和端到端权限仍待验收。Worker CORS 配置已写入实际生产域名及稳定升级预览域名；单文件 dashboard-worker.mjs 与原模块源码一致性纳入检查。Cloudflare 连接搜索无结果，尚未部署远端 Worker。
