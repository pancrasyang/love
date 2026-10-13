# V2.0 P1 审查（2026-10-13）

基线 d099d2c0c3831ca2a510cbfa65b74f6278fd0f84。完整读取仓库两个文件：index.html（2024 行）、letter.html（24 行）。无 AGENTS.md、SQL、Worker、构建配置及测试。

- 首页保留粉色玻璃卡片、响应式 940/560px 断点、计日、心情、日常、时间线、爱心动画和独立情书入口。
- Supabase 项目 oemwxlvdpowjxhipcqil，前端 key 是 publishable key，不是服务端密钥。
- daily_checkins 使用 id/content/created_at/photo_url/photo_path；没有作者校验。现有删除流程先删除图片再删记录，且忽略图片删除错误。
- 2026-10-13 只读探测：未登录的 publishable key 可读取一条 daily_checkins，确认匿名读取目前开放；未做写入/删除试探。
- Auth settings 显示 disable_signup=false。上线须在控制台关闭公开注册；数据库仍须独立限制两个授权 UUID。
- REST OpenAPI 返回 401，无法由仓库确定列类型、现有 RLS/触发器。上线前须运行 preflight.sql 并备份数据库。迁移不删除任何业务记录。
- 心情仅存 localStorage 的 loveDailyMoodRecordsV1；日期按设备时区。没有可靠作者信息。保留本地原始值并云端暂存待确认，不自动归属登录者，不直接补写历史心情。
- 图片 bucket=love-photos，历史记录 photo_url 是公开地址。新文件走私有 R2；迁移逐项 SHA-256 验证后回填 photo_key，保留旧字段和旧文件。
- letter.html 含完整正文、原有前端密码校验、信封和逐字动画；以 SHA-256 基线保护，整文件不修改。既有静态情书/封面不是服务端保密内容；此次 Auth 密码不进入源码。
- 音乐仅为网易云 audio 元素、专用样式和播放事件，P7 定点删除。

## 实施边界

在 upgrade/v2 分支分阶段验证并提交。保留 main 现有网站；完成数据库权限、账户绑定、服务端配置和真实验收后才能合并生产。
当前仅已具备 GitHub 权限，没有 Supabase 管理凭据、Cloudflare 部署凭据、两人邮箱/UUID或已确认前端域名。准备可运行代码、迁移、验证脚本及部署说明，不能把本地测试标记成生产验收。
