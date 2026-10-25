# R2 原图分段协商：开发审查与待验收清单

状态：开发及本地验证完成，**不批准生产发布；没有完成真实预览/设备性能验收**。默认仍为 1MiB，2MiB 是下一步优先实验候选，不是已经证实的生产推荐值。本文不使用历史 13.1 秒样本推算收益。

## 1. 实施前只读核对（2026-10-25，北京时间）

| 对象 | 本轮重新读取的实际状态 |
| --- | --- |
| GitHub main | `d462ff4eb96a48de8a82b0baa00bc4ef920ed625`，tree `01fddd3574c633063ab99682815eb9a803f6e699` |
| Vercel love | `dpl_HLDGoobn3PxMo36x1ubs8ZWLw3TW`，Production READY，同一 main 提交，`iad1` |
| love-media-api | deployment `3b380fec-a782-47fb-9408-9fd9b4aeb842`，version `b145417a-168a-42f0-997a-2a78175c7f53`，100% |
| 工作基线 | 从重新 fetch 的 origin/main 新建独立分支，不覆盖其他功能 |

本轮没有修改生产或预览环境变量、部署、地域、Worker、R2 文件、数据库、权限或套餐。Git PR 平台自动构建与手工部署不同；即使平台自动生成预览链接，也不等于完成真实照片验收。

## 2. 受影响文件和安全边界

| 文件 | 行为变化 |
| --- | --- |
| `server/photo-parts.mjs` | 明确 1/2/3MiB 白名单、服务端选择策略、正文显式尺寸与独立业务上限 |
| `server/photos.mjs` | 严格拒绝重复/异常参数；根据显式尺寸计算偏移；单图元数据增加协商信息；R2 正文要求 206，校验 Range 和精确长度 |
| `server/photo-worker.mjs` | Vercel→Worker Range 适配层使用协商尺寸；批量原图元数据附加同一服务端策略；10MiB 上限不随分段变化 |
| `assets/media.js` | 读取元数据尺寸、原图逐段携带尺寸；续传包含尺寸；跨尺寸不拼接；R2 原图逐段核对 MIME |
| 测试及本地基准 | 见下方证据表；少量旧测试夹具补充正确 MIME，不改变产品行为 |

Cookie 解封/续期、Supabase 用户验证、成员检查、业务关联、RLS 和私有 R2 不变。每个正文请求仍独立实时核验，不以元数据作为授权凭据。响应继续 `private, no-store`，二进制 Buffer，不使用 Base64 JSON。无新令牌、Cookie、账号、照片 key 或私人 URL 日志。

Worker 源码无需修改：现有 Worker 以显式 HTTP Range 的 offset/length 读取 R2，并已校验整数、版本、登记及业务关联。源码与 Dashboard 生成单文件均未变化，本地一致性检查通过。真实 Cloudflare 运行时冒烟仍待授权后进行。

独立保持原限制：R2 原图/上传 10MiB、legacy 读取 20MiB、缩略图 512KiB、IndexedDB 200MiB、未完成分段 40MiB/5 分钟。仍为两照片任务并发、单张串行；原图不压缩，不改 CDN 或鉴权查询。

## 3. 协议与异常表

服务端环境变量（本轮仅实现读取，没有设置平台配置）：`PHOTO_ORIGINAL_PART_SIZE`。

| 项目 | 约定 |
| --- | --- |
| 候选值 | 精确十进制字符串 `1048576`、`2097152`、`3145728` |
| 未设置/空配置 | 元数据选择 1048576；其他非空配置返回 503 `MEDIA_PART_CONFIG`，不静默试验其他值 |
| 单图元数据 | `GET /api/photo?source=r2&key=…&meta=1`：原有 size/type/version/sha256/variant/source_version 加 `part_size: 2097152`（示例） |
| 批量元数据 | `POST /api/photo-meta` 请求结构不变；`status=available, variant=original` 的条目增加相同 `part_size`；缩略图不增加传输协商 |
| 正文 | `GET /api/photo?source=r2&key=…&part=N&version=<sha256>&part_size=2097152`；参数不得重复，显式尺寸须同时有 part 和合法 version |
| 偏移 | start=`part × part_size`；end=`min(start+part_size−1,size−1)`；count=`ceil(size/part_size)` |
| 旧请求 | 不带 part_size，**始终**使用 1MiB，不读取当前策略来猜偏移 |
| 旧元数据 | 新前端未收到 part_size 时采用 1MiB；若收到非法值，拒绝元数据，不下载正文 |
| 非法参数 | 400 `MEDIA_INPUT`，拒绝重复参数、负数、小数、指数、空值、前导零 part、非安全整数、非白名单尺寸；在读取用户/R2 前拒绝 |
| 适用范围 | 仅 R2 原图正文接受显式尺寸；legacy/缩略图不发送该字段；向这些路径强行提交字段会拒绝，不能改变旧协议 |
| 越界 | 合法整数但超过文件范围返回 416 `MEDIA_RANGE_INVALID`；超出保留的全局 part 上限也可提前 400，均不读取 R2 |
| 版本/权限变化 | 412；匿名/会话失效 401；无权或失联业务记录按既有拒绝规则处理，不读取正文 |
| 错误响应 | 错误 Range、MIME、版本、过长/截断正文、最终 SHA 不符不得写入完整缓存；错误不通过更换尺寸绕过 |
| 回退 | 仅旧元数据缺字段回退 1MiB；不会在同一次失败后静默降尺寸。网络故障按既有重试预算重试相同段 |
| 请求预算 | 单段至多 3 次尝试；两次约 500–750ms / 1000–1250ms 退避；Retry-After 不缩短，超过 5s 留手动重试 |
| 超时预算 | 前端单请求含正文 45s、整图 10min；Vercel→Worker 现有 25s 信号；均不因大段而延长 |
| 正文预算 | 每段最大 3,145,728 字节，末段更小；不扩大完整原图或缩略图上限 |

Vercel 官方文档本轮重新核对仍声明普通 Functions 请求/响应正文 4.5MB 上限：https://vercel.com/docs/functions/limitations#request-body-size 。三个候选二进制段均低于该上限；**这不是对真实部署无 413 的验证**。本地 Buffer 测试也不能代替真实平台响应测试。

## 4. 缓存、取消和兼容/回滚表

完整缓存键保持账号、来源/表示、内容版本，不含 part_size。完整缓存命中后零正文请求；元数据仍实时核验。未完成的内存数据新增 `part_size`，同时进入 signature；新旧尺寸不一致、版本变化、TTL、清除、退出或切账号时丢弃不兼容数据。相同尺寸允许复用已完成段。

| 前端 / API / Worker 组合 | 结果与发布要求 |
| --- | --- |
| 旧前端 / 新 API / 当前 Worker | 旧页面没有 part_size，固定 1MiB；即使新元数据选择 2/3MiB 也不会错位 |
| 新前端 / 旧 API / 当前 Worker | 旧元数据没有字段，新页面用 1MiB；旧 API 忽略新的 1MiB 字段仍得到相同偏移 |
| 新前端 / 新 API / 当前 Worker | 完整支持三尺寸，元数据服务端选，正文显式解释，Worker 仍只看 Range |
| 页面已协商 2/3MiB / 新 API 配置恢复 1MiB | **兼容**：正文仍尊重请求显式尺寸；之后新元数据采用 1MiB。对应自动化覆盖 |
| 页面已协商 2/3MiB / 整体回滚旧 API | **不安全的兼容组合**：旧 API 可能忽略尺寸、按 1MiB 定位；新页面会因 Range 不符拒绝，但体验失败。不得直接这样回滚 |

发布（另行授权）：无需 Worker 发布，先保留兼容 API，再开放新前端；默认 1MiB。预览只在经批准的隔离环境测试三种服务端配置，生产配置不参与比较。

配置回退：将已授权环境的策略恢复 `1048576`（或删除变量）并部署对应配置。保留支持三尺寸的 API，允许打开中的页面完成其显式 2/3MiB 请求；下一次核验会改用 1MiB 并丢弃不兼容 partial，完整缓存保留。

代码回滚：先把客户端恢复旧版，但继续保留本 PR 的兼容 API。确认旧新版在途任务及打开页面已退场后，才可恢复旧 API；不能只以固定等待时间当作旧页面已退场的证据。Worker 无代码变化，不需要回滚。未达到退场条件时保留兼容 API 是安全停留点。

## 5. 证据表

下面每个“已实现”条目对应同一个代码与测试提交 `3e3a6e048ef4c474512378e4e8e55a4a09c0f5f7`（tree `f16f698701d58ded5401201c31586f287e1c5bdb`）；后续报告提交只增加文档及原始测量记录。该 tree 与本地已测代码完全一致。

以下均为本地测试，不是生产结果。测试名称可直接用于 `node --test --test-name-pattern=…`。

| 已实现条目 | 主要测试名称 | 本地结果 |
| --- | --- | --- |
| 三尺寸范围连续、边界/末段、上限独立 | `all part sizes cover exact boundaries, plus-one boundaries and short tails without gaps or overlap` | 通过 |
| 两种鉴权路径二进制正文、同字节与 SHA、每段重鉴权 | `binary API and unchanged Worker assemble identical SHA-256 at 1/2/3MiB, in both authorization paths` | 通过 |
| 单/批元数据一致、旧客户端、配置回退后仍尊重显式大段 | `server-selected single and batch metadata agree; config rollback never reinterprets explicit in-flight offsets` | 通过 |
| 参数白名单、重复/负数/异常值与错用路径拒绝 | `strict part parameters reject duplicates, abnormal numbers and non-original use before credentials or R2` | 通过 |
| 越界、版本变化、匿名/撤权/删除关联 | `out-of-range, stale, anonymous, detached and revoked segments do not read R2 at any size` | 通过 |
| API 拒绝错误 Range/版本/MIME/长度/状态 | `API refuses wrong ranges, versions, MIME, oversized and truncated segment bodies` | 通过 |
| 前端组装 SHA、跨尺寸完整缓存零正文 | `negotiated original boundaries assemble and hash identically at 1/2/3MiB, then reuse the same full cache` | 通过 |
| 同尺寸复用、跨尺寸丢弃 partial | `same-size retries reuse complete parts; changing negotiated size discards incompatible partial bytes` | 通过 |
| 新客户端兼容旧元数据、拒绝非法元数据 | `a new client defaults old metadata to 1MiB and rejects invalid advertised part sizes before body downloads` | 通过 |
| 前端拒绝错误 MIME/Range/版本/哈希、截断重试 | `larger originals reject wrong MIME, range, version and hash; truncated responses retry without caching bad bytes` | 通过 |
| 大段迟到响应/退出/换账号取消 | `logout while a 3MiB body is in flight aborts it; another account cannot receive its late bytes` | 通过 |
| 两任务/单图串行、原内存/超时/限流预算 | `larger parts retain two-photo concurrency, serial per-photo requests and the unchanged partial budget`；`3MiB keeps the existing timeout, retry and Retry-After budgets` | 通过 |
| 缩略图与 legacy 原协议 | 现有 `photo-variants-client`、`photo-optimization`、`photo-api`、`photo-transfer` 回归集 | 通过 |
| 完整仓库测试 | `npm test` | **129/129 通过** |
| 检查 / 构建 | `npm run check`；`node scripts/build.mjs`；`git diff --check` | 通过，Dashboard Worker 与源码一致；情书 SHA 未改 |
| GitHub CI | PR 检查 | 提交后核对，本文不以本地成功替代 CI |
| 真实预览、设备和生产读取 | 下方实际测试矩阵 | **待验证** |

## 6. 已测结果：仅本地合成链路

运行 `node scripts/benchmark-original-parts.mjs --rounds=3`。真实 API 和 Worker handler + 内存 R2/合成 Cookie/Auth/DB，各 Auth/DB/R2 操作注入 5ms；每组 3 次、同一字节样本。没有网络、浏览器解码、真实认证、真机、弱网或 Cloudflare/Vercel 运行时。

完整原始记录见 `original-part-local-results.jsonl`。全部 36 次测量 SHA 正确；健康样本没有注入错误，失败/重试正文为 0，**不代表真实错误率为 0**。表中耗时是本地元数据到组装/哈希完成的中位数，不是点击到图片显示，更不能宣称同倍率提速。

| 合成文件字节 | 1/2/3MiB 正文请求数 | 三方案相同成功正文总字节 | 1/2/3MiB 组装中位数（ms） |
| --- | --- | --- | --- |
| 524,288（小于 1MiB） | 1 / 1 / 1 | 524,288 | 72 / 69 / 70 |
| 1,048,577（1—2MiB） | 2 / 1 / 1 | 1,048,577 | 99 / 59 / 63 |
| 6,291,456（6MiB） | 6 / 3 / 2 | 6,291,456 | 263 / 143 / 93 |
| 10,485,760（现上传上限） | 10 / 5 / 4 | 10,485,760 | 327 / 204 / 188 |

每组元数据 1 次。在现有 Worker 委派模式下，每个请求仍有 Auth/profile/registry/business 各 1 次；6MiB 的总鉴权/成员/登记/业务各为 7 / 4 / 3 次（含元数据），未缓存授权或合并权限查询。完整缓存热访问由浏览器测试实际走缓存路径确认 0 正文，而非仅根据 blob URL 推断。

## 7. 真实测试矩阵与测量门槛（尚未执行）

| 环境/场景 | 1MiB | 2MiB | 3MiB | 原因 |
| --- | --- | --- | --- | --- |
| 已授权预览 + 当前 Worker + 真实二进制功能冒烟 | 待验证 | 待验证 | 待验证 | 本轮未获独立预览测试授权/配置；未使用真实登录会话 |
| 桌面真实网络、四种大小、冷缓存 | 待验证 | 待验证 | 待验证 | 尚未进行真实端到端测量 |
| 同设备/账号/域名的完整 Blob 热缓存 | 待验证 | 待验证 | 待验证 | 本地合成测试通过，但真实结果未测 |
| 手机实际网络、断流恢复、退出取消 | 待验证 | 待验证 | 待验证 | 无已授权实际手机设备/会话 |
| Vercel 413/429/5xx、解码显示、真实内存峰值 | 待验证 | 待验证 | 待验证 | 普通本地 Response 无法验证平台限制与移动内存 |
| 生产 | 未测试 | 未测试 | 未测试 | 没有本轮生产测试或发布授权 |

后续预览流程：先功能冒烟再性能；固定同代码、Worker、iad1、账号、照片、网络，三次实验只调整预览服务端 `PHOTO_ORIGINAL_PART_SIZE`，重新部署后校验配置实际反映在元数据。保留部署 ID；不能让客户端任意 query 强制修改服务端选择以伪装配置对比。测试顺序轮转 1→2→3、2→3→1、3→1→2 以减少暖机/网络顺序偏差；每个条件先 3 次，确认收益后才扩大样本。

使用全新隔离浏览器配置/上下文，只登录授权测试账号。不在现有用户配置中使用“清除全部缓存”，不导出含 Cookie/token/完整私人 URL 的 HAR。每轮新上下文是图片冷缓存；同上下文完成原图后普通刷新，再次点击“查看原图”是热缓存；等待必要列表与缩略图请求结束后单独记录原图窗口。

每次记录：元数据请求数/耗时（含批量）、原图正文请求数、成功/失败/重试的实际传输字节、点击 `[data-view-photo]` 至 `.original-photo-dialog img` 的 `decode()` 完成且下一帧显示的时间；同时记录 HTTP 状态、超时、请求编号、SHA/Range/MIME 错误、取消原因及内存。只保存无身份无照片 key 的计数/大小/时长/编号，不保存完整 URL 或正文。必要时在 DevTools 中人工聚合响应正文传输量；请求中止后已传字节以网络层记录为准，不以 Content-Length 或现有 bodyBytes 计数代替。

已有 `getPhotoLoadMetrics()` 只作为交叉检查：`firstPhotoMs` 是页面加载协调器绑定 src 的时间，不是点击后的解码显示；`bodyBytes` 不保证包含断流前收到的部分正文，因此不能单独用它报告失败字节或总传输。P50/P95、移动端实际断流和内存峰值须用真实采样，不能从本地合成结果推导。

实验前记录的预算：沿用 40MiB 未完成段预算（自动化覆盖），2 个在途大段最多 6MiB 正文，文件/整图组装上限不变；真实浏览器总内存峰值另测。候选选择的预设门槛是同设备相同样本的总内存峰值相对 1MiB 不增加超过 16MiB、无新增移动端内存压力/标签页重载，且原硬限制不变。16MiB 是本轮保守比较门槛，不是已验证的设备能力；拿不到可比总内存证据就标为待验证，不能据此批准大段。

暂定结论：**保留生产 1MiB；优先实测 2MiB，3MiB 仅作为对照**。必须在真实冷缓存显示收益稳定、错误/恢复不恶化、没有 413/权限/完整性问题且内存满足门槛后才选择候选；3MiB 对 2MiB 无明显稳定收益时采用 2MiB；两者均无稳定收益则保持 1MiB，报告实际耗时阶段。PR 不自动合并或发布。
