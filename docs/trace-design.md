# /trace：执行轨迹与步骤详情

状态：**已实现第一版**（2026-10-15，内置扩展 `epi:trace` 0.1.0，随下一次 Epi 版本发布）。用户已定入口、全屏无输入框、第一版含时间轴/耗时/步骤详情；下文其他交互与存储选择中，未实现的在 §10 末尾列出。证据见 [trace-review-probes.md](notes/trace-review-probes.md)。

## 1. 用户要解决的问题

在 Epi 内回答：刚才做了哪些步骤、时间花在哪、哪个调用失败、参数与结果是什么、当时使用哪个模型和工具定义。运行中和恢复历史都能看。切模型、缺字段、嵌套工具不能让轨迹失真。

用户给的截图展示了点击工具行后的 inspector：Summary / Payload / Result / Schema / Timing。这是第一版目标，不只做一个折叠消息列表。

已定：

- `/trace` 是斜杠命令，不再要求选择额外组合键。
- 全屏专用页覆盖消息区和 composer，退出恢复对话及草稿。
- 时间轴和每一步耗时进入第一版。
- 点击或 Enter 打开细节，所有操作有键盘路径。
- TUI 内完成，继续用 Pi 内核和 pi-tui。

## 2. 信息结构与视觉

用三层信息密度：时间轴概览 → 单行步骤 → 详情。默认不铺原始 JSON，不给每行加卡片外框。对齐和留白承担层次，颜色表达选中、运行、失败；错误另有文字/符号，不能只靠红色。

### 2.1 全屏布局

顶部：当前分支、用户消息分组、步骤数、运行状态、时间资料覆盖情况。其下是同一刻度的 Model / Tools 两行时间轴；输入、压缩、重试是标记，不常占第三条泳道。相较最初的一行半格草图，两行更容易识别并行和点击目标，代价只多一行。

中间：步骤列表；≥120 列且打开详情时，左侧至少 56 列、右侧至少 48 列，以一条竖线分开。更窄时详情替换列表，时间轴仍可保留。底部一行显示当前焦点可用操作。

示意（合成内容，不代表现有真实会话）：

```text
 Trace  ·  当前分支  ·  用户消息 3  ·  18 steps               idle
 Model  ━━━━━━···················━━━━━━················━━━━
 Tools  ······━━━━━━━━━━━━━━━━━━━······━━━━━━━━━━━━━━━━····
        0s                    12s                       24s

   11   2.4s  model   读取实现与测试              │ Step 13 · bash
   12   9ms   read    src/agent.ts                │ Summary  Payload  Result  …
 › 13   4.8s  bash    npm test       error        │
   14   1.2s  model   分析失败                    │ 状态       error
   15  12ms   edit    src/agent.ts   +6 −3        │ 调用       call_…
                                                 │ 执行耗时   4.8s · SDK 记录
                                                 │ 参数       command: npm test
                                                 │ 结果       …原始结果摘要…

 j/k 选择 · Enter 详情 · Tab 切焦点 · / 搜索 · Esc 返回
```

终端短于 16 行时收起统计和冗长提示；仍保留紧凑时间轴、选中步骤和返回键。低于可用最小高度时只保留当前步骤和详情入口，明确提示扩大窗口。宽度阈值是实现建议，P4 只验证 24 行的布局。

### 2.2 一行是什么

- **一个模型响应 = 一行模型步骤**，有完整耗时、usage、结束原因和模型身份；text/thinking/toolCall 是该响应的子内容。
- 纯工具调用的 assistant 仍保留为“模型请求 N · 产生 3 个调用”，可折叠子内容。不能删掉这一行，否则模型耗时无处归属。
- **一个工具调用 = 一行工具步骤**，参数与 toolResult 按 ID 关联；并行调用保持原始调用次序，不按完成顺序跳动。
- 用户输入/转向、压缩、上下文编辑、分支摘要、重试和模型切换是明确事件。低频系统配置默认折叠成摘要，可在“全部”里找。
- SDK 的 `turn_start` 表示模型/工具循环，不能当成人发起的一整轮。界面写“用户消息分组”和“模型请求”，避免与现有 preview 的 agent_start 计轮混淆。插话是标记；已有请求及工具不被重新分组。

标题只做确定性投影：已知工具读取已验证的路径/命令/结构化计数；扩展工具用工具名、参数键或明确 description。**不取第一个任意字符串当摘要，不从任意 stdout 猜“51 tests passed”。** 未知结构仍可打开看原始记录。

## 3. 点击后的五个栏目

栏目可点选；Tab 切列表/详情焦点，详情内左右键切栏目，数字 1–5 直选，避免一个 Tab 同时承担两种语义。窄屏显示当前栏目及切换提示。详情正文独立滚动与搜索。

| 栏目 | 工具步骤 | 模型步骤 |
|---|---|---|
| Summary | 名称、ID、所属请求、父工具/任务、状态、执行耗时、参数/结果各几行预览 | provider/api/model/responseModel、结束原因、内容概览、usage、耗时 |
| Payload | 存下来的 toolCall.arguments；有实时有效参数观察时另列“执行参数” | 已记录的响应元数据和调用声明；模型输入只展示能回放的上下文来源，并标明不等于实际 HTTP request |
| Result | 原始结果 content、details、isError；附件按类型/MIME/大小呈现 | text/thinking/toolCall 分区；空或 redacted thinking 明确显示无可见文本 |
| Schema | 调用发生时的工具声明、来源 entry；缺失原因 | 通常不适用；不占用一个伪造模型 Schema |
| Timing | SDK execute 耗时、生命周期开始/结束观察、结果入会话时刻，各自来源 | 响应总耗时；有观察时显示首内容/分段事件到达时间；缺 TTFT/细分时间就写未记录 |

Payload/Result 是 **Pi 归一化记录**，不是抓包。模型输入会经过 context hooks、provider 转换和 Epi 强制 system prompt；仅凭历史消息不能宣称恢复了完整请求载荷。原始 provider stream 不默认采集。

长 JSON 按结构按需展开/分页；保留未知键。图片 base64、thinking/text signatures 只显示元信息，不默认展开大块 opaque 数据。所有原始文字在终端显示前处理控制字符，底层记录不改。

状态区分 pending/running/completed/error/aborted/deferred/unknown。模型 `length` 显示“达到输出上限”，不当正常完成。缺 toolResult 不自动判失败；实时已启动可显示 running，历史缺结果则 unknown/incomplete。无 execute 时长也不能仅据此判“被阻止”，还可能是旧记录。

## 4. 时间轴必须诚实

### 4.1 两种时间，不混用

| 字段 | 意义 | 用途 |
|---|---|---|
| assistant.timestamp + durationMs | 声明的响应起点 + SDK 的响应耗时；需校验字段 | 模型响应跨度，注明 SDK 记录；deferred/旧记录可能缺失 |
| toolResult.durationMs | execute 函数耗时，不含全部前后置 hook | 列表执行耗时与排序 |
| 实时 tool_execution_start/end 的观测时间 | 从工具生命周期开始到结果处理结束的观察区间，含调度/校验/hook | 工具时间轴跨度，详情另列 execute 耗时 |
| toolResult.timestamp | 结果消息创建时间；并行批次可能集中生成 | 历史结果标记，绝不减 duration 冒充开始时间 |
| entry.timestamp | SessionManager 追加记录的时刻 | 存储信息；不冒充网络或执行时刻 |

P2 已证明 timestamp−duration 的工具定位是错误的。撤回之前“只用现有持久字段就足够精确回放全部时间轴”的判断。

校验不只检查字段存在：耗时必须有限且非负，时间戳必须有效；来源不可信、明显在未来、start/end 自相矛盾的记录不画精确跨度，保留原值与诊断。观察时间用每次进程的 clock epoch（墙钟锚点 + 单调偏移）表达。检测墙钟跳变时分段标记，不把负间隔夹成零。跨进程恢复不能比较裸 performance.now()，只能用各自锚点定位；存在时钟冲突的分段保留事件顺序、分段显示，不强行对齐。模型的声明 timestamp 与 observer 时间域不能证明一致时，模型仍可显示记录耗时，时间轴只显示事件标记。

没有观测跨度的历史工具仍显示执行耗时，但轴上只画结果时刻的空心点；详情说明“执行起止未记录”。缺少全部时间时按列表可见，不塞进一个假零秒格。标题显示覆盖情况，例如“18 步，11 步有区间，5 步仅耗时，2 步无计时”。

### 4.2 刻度、并行与选择

默认聚焦最新/选中的用户消息分组，可切整段会话；缩放和平移只改变时间窗口，不改事件。选择步骤时保证对应区间/标记可见。

- 同一刻度定位所有 lane。并行跨度重叠，同一格保留命中集合；点击聚集格列候选步骤，不随机选一个。
- 小于一格的短任务画最小标记；详情展示真实数值。零毫秒是 `<1ms` 或 `0ms（记录精度）`，缺失是 `—`。
- 长空闲保留为真实空白；如提供折叠空闲模式，断轴必须可见并标注跳过时长。
- 总墙钟区间、execute 耗时之和、lane 占用并集是三个概念。嵌套跨度不重复计占用。资料不全时不展示凑成 100% 的 Model/Tools 百分比。
- 耗时排序是列表的可选“耗时排行”，时间轴保持时间顺序；缺失值放末尾并明示，执行耗时和生命周期耗时不能混排。
- 流式更新时跟随尾部；人选中历史、搜索或进入详情即停止抢夺，显示有新事件。`G` 回最新。

## 5. 通用数据投影与兼容规则

模型差异交由 Pi 的 provider 适配归一化。Trace 只依赖公开的 SessionEntry、AgentMessage、AgentSessionEvent，同时对可选/未知结构宽容。不得写 `if model.includes('claude')` 之类分支。

建议的内部边界（不是新的公共插件框架）：

```ts
type TraceOrigin = 'session' | 'observation';
interface TraceStep {
  id: string;                         // 分支中的稳定身份，不是屏幕行号
  entryId?: string;
  parentId?: string;
  kind: 'model' | 'tool' | 'user' | 'event' | 'unknown';
  source: TraceOrigin;
  status: string;
  raw: unknown;                       // 引用记录，保留未知字段
  duration?: { ms: number; scope: 'response' | 'execute'; source: string };
  span?: { startMs: number; endMs?: number; source: string };
}
```

实际实现可用 discriminated union 表达更严的状态；这里只约定信息边界。`duration` 与 `span` 独立，防止为了画条形图捏造起止。

| 输入差异 | 显示/计算规则 |
|---|---|
| 同会话切 provider/API/模型 | 每个模型响应自带身份；不能拿当前模型填历史；model_change 单独记录 |
| usage.reasoning、cacheWrite1h | 保留子集含义，分别已包含在 output/cacheWrite，禁止重复加 |
| 缺 usage、缺字段、全零 partial | 缺失为未知；partial 标“流式暂计”；message_end 最终值校准。零可能是 provider 默认值时展示“记录值”，不声称测量精度 |
| cost 全零且定价来源不明 | “未提供有效计价依据”，raw 中仍可看零；不武断写免费 |
| 无 thinking / 空 thinking / redacted | 分别显示未提供、无可见文本、隐藏内容；不能推断没有推理 |
| arguments 不完整 / partialJson | 运行中显示部分参数；截断/中止保留不完整标记，不再执行或自动修补 |
| image / 未知 content / 非数组 content | 图片元信息；未知块保留类型和原值入口；坏形状有诊断，不让整个页面崩溃 |
| IDs 重复/缺失/孤立 result | 用 session+所属 assistant entry+content index 建身份，ID 在分支作用域内关联；不能按工具名配对；歧义保留孤立项并说明 |
| nestedCalls.complete=false | 显示记录不完整；参数/结果被省略的原因明确；无绝对时间不画虚假子跨度 |
| toolsAdded / toolsRemoved / namespace | 在当前分支中回放调用前状态，使用 Pi 公共工具身份与回放函数；缺历史声明则显示未知，当前 Schema 另标参考 |
| custom/context_edit/usage/compaction/branch_summary | 原始历史可见，压缩前步骤仍保留；context_edit 标注模型上下文中的替换/移除，不改原始显示记录 |
| 未知 entry / role | 通用事件 + raw 入口，不悄悄丢弃 |

不使用 getSessionStats 的累计值当作当前上下文占用。每请求、工具嵌套模型用量、压缩/独立 usage 分栏显示，汇总需去重。

## 6. 历史与实时接入

### 6.1 历史

从当前 SessionManager.getBranch() 构建投影；不用 session.messages（已应用压缩/context edit），也不直接把 getEntries() 的所有分支串成一条轨迹。

初始投影 O(n)，构建 ID/调用/Schema 索引。详情按选中步骤读取，渲染不遍历全会话。读取完整大字段、搜索大结果分批进行。

### 6.2 实时观察

界面启动即订阅当前 AgentSession 的公开事件，不等打开 `/trace` 才计时。使用单调时钟记录间隔、墙钟锚点做定位，标注 observed。

P3 发现 message_end 通知先于消息追加到内存 SessionManager（probe 使用 `--no-session`，**未验证磁盘刷新或崩溃恢复**）。该时刻先保留临时步骤，**不能马上按 leafId 绑定消息**。在 turn_end 等确认消息已追加的边界对账；按对象/稳定 ID 和分支顺序匹配，校验后替换临时身份。不访问 SDK 私有 `_entryIdsByMessage`。该 probe 只覆盖正常 faux 模型路径；工具结果、重试、中止及无正常边界的情况仍需单独验证，在关闭/下一次同步时对账；没有证据则保持未绑定，而不配给邻近消息。

保存每次响应/工具/重试/压缩的有限时间摘要，不保存每个 token delta 或嵌套结果全文。嵌套实时结果可在有界内存中看，重启后明确只有已有 bounded metadata。

### 6.3 精细时间的持久化建议

为让新会话重启后仍有真实工具生命周期时间，建议通过公开 appendCustomEntry 写 `epi.trace.observation.v1`。custom entry 不进入模型上下文，P2 已验证；不修改 Pi 的 JSONL schema。

- completed request 对账后批量写一条，引用已有 message entryId / toolCallId / content index，记录观察起止和少量阶段时间。
- custom entry 会推进 leaf。只读取当前分支祖先链上的观察摘要；从响应位置、摘要追加之前分叉时，新分支可能保留步骤但没有它的计时摘要，显示“无可用观察记录”。第一版接受这种明确降级，不跨已弃分支搜索或借用元数据。不得改写消息/parentId，也不得因写摘要触发模型 continuation。
- 每条包含 version、session identity、分支锚点、clock origin、计时来源和完整性标记；新增字段可选。记录大小设上限，省略时写 incomplete。
- 不额外存参数、工具输出、图片或模型输入。写失败时一次可见诊断，继续内存查看，不能宣称已保存。
- `/new`、`/resume`、`/reload`、导航分支、退出先停止旧订阅；异步回调带 generation，禁止写入新会话。未完成记录不伪造完成。
- crash 最多丢未刷新的观察摘要；Pi 已存的步骤仍可读，缺失计时如实展示。
- `--no-session` 仅内存；旧会话不迁移、不反算。非交互生成的会话未必有该观察记录，按能力降级。第一版采集只保证交互宿主。

此处是设计建议，尚未新增持久化行为。详细批量写入与生命周期需正式实现阶段的 SDK 测试覆盖。

## 7. 接入位置与与审查联动

建议 `/trace` 是宿主 TUI 的专用页：公开 SDK 事件接入可取得重试等完整会话事件；归一化投影、计时观察、渲染分开。全屏容器复用已验证的 custom overlay 能力，不必和对话区共享同一个 ScrollView 实例。

建议模块职责：

| 模块职责 | 输入 / 输出 |
|---|---|
| trace 数据模块 | SessionEntry + 观察摘要 → 稳定步骤/Schema/索引 |
| trace observer | 公开事件 → 临时步骤及有界计时摘要 |
| trace page | 列表、timeline、inspector、焦点与导航 |
| app 接线 | 注册命令、会话绑定/替换、打开/关闭、返回定位 |

不直接改已有 ToolBlock 的 expanded 状态来显示详情；可以复用纯格式化函数，独立组件实例防止关掉详情后对话折叠状态被改变。

从 edit/write 步骤可以打开已记录 diff 或当前文件，来源在标题明确标注。**“这次工具调用的差异”“本会话 ledger 差异”“当前工作区差异”不同**。旧 before 快照不存在时，不拿当前磁盘伪造历史 diff。新的跨视图入口应接受明确来源和返回位置；不能只传一个 path 就宣称是那次编辑。

代码审查的连续 diff、基准与批注另见 [review-design.md](review-design.md)。先共用定位/返回约定，等两个页面实际出现重复代码再抽容器。

## 8. 子代理边界

第一版提供 task 调用、结果和已有 job 元信息；后台 task 的提交、等待、取消是各自步骤，不能把 wait 次数当子任务次数。job 身份只能取结构化 details 中的明确字段。

当前 worker 无持久会话/逐步事件，完整子轨迹显示“未采集”。后续如需展开全部子模型/工具步骤，单独扩展 worker 协议和有界存储，保持 process/session/job/call 的身份关联。不能解析自由文本猜它执行了什么。

## 9. 状态清单

| 状态 | 更新 | 重置与边界 |
|---|---|---|
| session/branch generation | 绑定、替换、导航 | 旧回调拒绝；关闭页面不清记录 |
| 历史投影与关联索引 | 初载、append、分支变更 | 分支变更重建；不把已弃分支混入 |
| 临时步骤/计时观察 | 实时事件 | 对账后替换；中止/重载标不完整 |
| 选中 stepId、列表锚点 | 键盘/鼠标/搜索 | 新输出不抢；目标消失显式提示 |
| 焦点、栏目、各栏滚动位置 | 页面操作 | 宽窄切换保留；退出恢复对话焦点/草稿 |
| timeline 窗口/缩放/跟随 | 用户导航、G | 详情/历史阅读暂停跟随 |
| 搜索/过滤/排序 | 本地交互 | 不修改源记录，不影响时间轴计时 |
| 待刷观察摘要 | request 完成边界 | session generation 与锚点校验；失败可见 |
| 查看器异步加载 | 选中/展开 | 步骤切换取消旧加载；不覆盖新选择 |

Esc 关闭当前搜索/详情/页面，不隐式中止 agent。全屏页保留明确 Stop 动作（建议 Ctrl+C），调用现有中止路径；不能让全局快捷键绕过焦点去清空背后的草稿。扩展在后台要求用户输入时要能显露 pending interaction 并切回卡片，避免全屏页遮住等待状态。这项尚未 probe，属于实现验收重点。

## 10. 实现验收

第一版的完整切片：`/trace` → 初载当前分支 → 时间轴/列表 → 点击详情五栏目 → 运行中刷新 → 重启后带来源的历史回放。时间轴不是后续可选项。

必须验证：

1. 五类 API 的归一化 fixture；同会话切模型；空/redacted thinking；缺失/零 usage；reasoning 子集；未知块及 malformed JS 工具结果。
2. 快慢并行、顺序工具、hook 延迟、blocked、length 截断调用、error/aborted/deferred；执行耗时与观察区间不混算。
3. message_end→turn_end 对账；临时 ID 稳定；重复/缺失 call ID；nestedCalls 不完整；后台 task 不虚构子步骤。
4. 压缩前历史保留；context_edit 不改原记录；分支回放 Schema；旧会话缺观察；非交互会话和无会话模式。
5. `/new`、`/resume`、`/reload`、`/tree`、退出/崩溃的订阅和写盘边界；在 metadata 追加前分叉的可达性与降级；custom 元数据不改模型上下文；采集开关前后模型可见快照一致。
6. 40/80/120/160 列，12/16/24 行；宽字符、长 JSON、大图片元信息、控制字符；鼠标与键盘；resize、搜索、滚动、扩展弹窗及 Stop。
7. 1万步骤、超长输出、密集时间轴：只渲染可视行；单步更新不全量重算；记录实际 p95 输入到绘制时间再确定上限，不以合成小样本声称性能达标。

本轮实现的是交互宿主里的第一版，已接正式轨迹（不再使用合成数据）：§1–§5 的信息结构、§6.1 的历史投影、§6.2 的实时观察（工具生命周期区间、running 临时步骤）、§7 的独立 `epi:trace` 页面。时间轴按用户反馈做成**顶部单行点阵**（只有亮起来的像素，模型/工具/运行/错误用颜色区分；时间窗只取当前屏幕内可见的步骤），列表是纯文字，取代 §2.1 最初的两行泳道草图。尚未实现：§6.3 的观察摘要持久化（重启后新会话仍是内存观察）；§7 的跨视图互相定位；§8 的完整子代理轨迹展开（仍如实显示 task 调用的已有信息）；时间轴缩放/平移等 §4.2 的交互；§10 的 1 万步性能上限未经真实验证。
