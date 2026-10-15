# Trace 与 TUI 审查：源码研究及 probe

状态：研究完成，方案待评审；没有实现产品命令。Epi 起点 `3660215`，依赖版本以 `package.json` / `npm-shrinkwrap.json` 为准。Mayoi 固定到 main 的 `9c64af8dcbcb69cffecaa492791537ef32792dac`。参考截图是交互需求，不是 Epi 已拥有的数据契约。

## 1. 需求来源

用户明确要求：`/trace` 打开轨迹；隐藏对话输入框；第一版包含时间轴和每一步耗时；选中步骤查看 Summary / Payload / Result / Schema / Timing；先做 probe，再写通用方案，兼容不同模型字段。后续增加 Mayoi 研究：在 Epi TUI 内完成代码审查，不切换应用。

本次分别验证数据语义与显示可行性。源码阅读、合成输入实测、历史语料统计分开说明。没有向真实 provider 发起兼容性测试请求；独立阅读与顾问使用 Epi 会话。

## 2. 已执行的 probe

| Probe | 方法 | 结果 / 限制 |
|---|---|---|
| P1 历史字段覆盖 | 只读统计已有 249 个 JSONL，不修改它们；脚本与原始统计仅留 `.dev/probes/trace/p1-*` | 第一轮快照：7,443 条 assistant，只有 1,343 条带 durationMs；7,831 条 toolResult，1,562 条带 durationMs。真实语料有 5 类 API。不是各模型当前版本支持率 |
| P1b 时间戳交叉检查 | 对另一时刻语料快照统计 | assistant 的 entry timestamp − message timestamp − durationMs 在该样本约 −1～3ms。但这不能证明任意导入/旧记录可可靠反推耗时；不能用于工具定位 |
| P2 执行时间语义 | [trace-contract.mjs](../../scripts/probes/trace-contract.mjs)，真实 Pi core + 假流 + 快慢工具 + 延迟 hook + blocked tool | PASS：事件完成顺序不同于持久化顺序；timestamp−duration 不能定位工具；无执行工具无 duration；Schema 变更/分支回放；压缩保留 raw branch；custom entry 不进入模型上下文，但在摘要之前分叉会失去该摘要 |
| P3 SDK 消息追加时序 | [trace-session.mjs](../../scripts/probes/trace-session.mjs)，Epi createRuntimeFromPrepared + faux provider，`--no-session` | PASS：message_end 订阅回调执行时消息尚未入内存 SessionManager；turn_end 时模型响应已入；system 消息包含 edit/write Schema。未验证磁盘耐久性、恢复及全部异常路径 |
| P4 TUI | `.dev/probes/trace/trace-view-prototype.mjs` + `p4-ui.mjs`，真实 Epi TUI、pi-tui、headless xterm | 40/80/120/160 ×24 行：全屏覆盖、无 composer、Enter 详情、Tab 切节、鼠标点击选中、Esc 返回均 PASS。两个临时布局：宽屏侧栏 / 整页 inspector。fixture 数据，未连接真实轨迹，也未做长会话性能或真人终端验收 |
| P5 Git 审查基线 | [review-baselines.mjs](../../scripts/probes/review-baselines.mjs)，隔离临时 Git repo + 现有 ChangeLedger | PASS：HEAD/index/worktree/首次触碰前快照四者不同；空格重命名、未跟踪、binary 条目；ledger 不包含 shell-only 文件；恢复无账；旧行号在插行后失效 |

重跑三个已保存的离线契约 probe：

```sh
node scripts/probes/trace-contract.mjs
node scripts/probes/trace-session.mjs
node scripts/probes/review-baselines.mjs
```

脚本创建临时环境并清理，不联网，不读凭证或剪贴板。TUI 临时原型和屏幕文本保留在 `.dev/probes/trace/ui-{40,80,120,160}.txt`，不作为产品源码。旧语料统计是只读调查，不是自动测试的一部分；不把私人会话内容复制进 repo。

## 3. 对之前建议的修正

### 3.1 durationMs 不能单独重建精确工具时间轴

Pi 的 `executePreparedToolCall` 记录 execute 的单调时钟耗时；之后才 await afterToolCall。并行批次先发各自的 tool_execution_end，再等整个批次完成，按调用顺序创建 toolResultMessage。message.timestamp 是结果对象创建时间。

P2 一次运行：fast 实际执行约 16ms，后置 hook 约 40ms；slow 执行约 161ms。两者 toolResult.timestamp 相同。用 fast.timestamp−16ms 推算开始，比真正开始晚约 146ms。blocked 有错误结果但没有执行时长。

依据：安装依赖 `pi-agent-core/dist/agent-loop.js` 的 `executeToolCallsParallel`、`executePreparedToolCall`、`finalizeExecutedToolCall`、`createToolResultMessage`；`types.d.ts` 的 AgentEvent 定义。

结论：**记录的 execute 耗时可以显示；观察到的生命周期区间用于时间轴；历史缺起止时显示定位未知。** start/end 事件区间也含校验、hook 和调度，不能叫“纯执行时间”。

### 3.2 模型级计时不等于内容块级计时

`pi-ai/dist/utils/event-stream.js` 的 AssistantMessageEventStream 在完成时填 durationMs；对已有 duration 或 timestamp 早于当前流创建时刻的 deferred result 不覆盖/补写。text/thinking/toolCall 共用一次模型响应，不各自拥有这份时长。

实时可以观测 text/thinking 的事件到达时间，但这只是客户端观察值；不能标成服务器内部推理时间。历史只有整个响应时长时，子块耗时显示未知。

### 3.3 Schema 不必依赖当前工具注册表

Pi 的 system 消息包含 toolsAdded/toolsRemoved；公共 `getCurrentTools()` 可以回放。P2 验证工具移除、同名 Schema 更新和切回分支，P3 验证 Epi 内存会话中的实际声明。JSONL 持久格式依据 SDK 文档和源码，本轮未实测磁盘恢复。

依据：[Pi Session Format](../../node_modules/@earendil-works/pi-coding-agent/docs/session-format.md)、[Message Types](../../node_modules/@earendil-works/pi-coding-agent/docs/message-types.md)。历史步骤应查“当时声明”，当前 Schema 只能作为单独的参考。隐藏 / codemode 内部工具未必曾被声明给模型。

### 3.4 task 和 nestedCalls 是不同的数据源

Pi nestedCalls 有 name/arguments/status/duration，`complete:false` 可表示删节；没有历史嵌套结果、绝对开始时刻。实时 SDK 事件有 parentToolCallId，可见性更好。

Epi 的 [worker.ts](../../src/worker.ts) 使用 SessionManager.inMemory，只发送 started/result；[task-runtime.ts](../../src/task-runtime.ts) 管理 job 状态与工件。父 task 调用耗时不等于后台 job 总耗时，也没有完整子代理会话可回放。完整子轨迹需要另外设计 worker 事件/存储协议。

### 3.5 不可把 usage 零值当成确定事实

历史样本包含空 thinking + 非零 reasoning usage；reasoning 已包含在 output 中，cacheWrite1h 是 cacheWrite 子集。网关的 model 与 responseModel 也可能不同。部分 provider 整份 cost 都是 0，无法仅由数值断言免费。

缺少、未上报、明确 0、正在流式估计需要区别。compatibility 以字段和协议能力为准，不按模型名字硬编码。详情保留 provider/api/model/responseModel，signature 当 opaque 元数据。

## 4. Mayoi 值得迁移的设计

主来源：[README](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/README.md)、[Features: Diffs](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/docs/FEATURES.md#diffs)。只做源码研究，没有构建或启动 Mayoi 的 GUI。

| 设计 | 源码依据 | Epi 对应 |
|---|---|---|
| 所有文件连续显示在一个 Changes 页面 | [diffView](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/cmd/mayoi/diffview.go#L143)，按文件/hunk 跳转 `diffInput` | 现有 preview 列表→单文件→返回；可提升为连续阅读 |
| 三行上下文，gap 可展开，文件可折叠 | [foldRows](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/cmd/mayoi/diffrows.go#L104)、`activateRow`/`toggleGap` | Epi 已有三行上下文与 gap，但 gap 只是显示，不可展开 |
| 宽度足够才左右 diff，默认每侧 80 列 | Features Diffs、`diffLayout` | TUI 默认统一 diff，超宽可选并排，不强迫 80 列终端变两栏 |
| 近视口加载、四文件并发、超大文件默认折叠 | [diffReads/diffNear/foldedLines](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/cmd/mayoi/diffview.go#L329) | 避免每帧读全部文件和重算 diff |
| 明确 HEAD→Index、Index→Working Tree 两种差异 | [diffBase](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/cmd/mayoi/diffview.go#L23)、[Git Status](https://github.com/sorrycc/Mayoi/blob/9c64af8dcbcb69cffecaa492791537ef32792dac/internal/git/git.go#L210) | 补充 ledger 看不到的 bash、外部、未跟踪文件；不声称归因于 agent |

所读 diff/SCM/文档未发现批注或 AI review 的实现证据。Mayoi 的 stage/revert/commit/SSH/editor 是编辑器职责，本次不迁移。批注回给 agent 是 Epi 的设计建议。

## 5. Epi 已有基础及具体缺口

- [preview.ts](../../src/extensions/preview.ts)：全屏 custom overlay 已有，退出返回原对话。
- [ledger.ts](../../src/extensions/preview/ledger.ts)：只对 write/edit 抓首次触碰前快照；换会话失效。不是 session 开始时全仓快照。
- [diff.ts](../../src/extensions/preview/diff.ts)：统一 diff、旧/新行号、词级强调和计算上限已实现。显示规范化会忽略 CRLF/Tab 等纯格式差，不能直接拿显示后的文本做精确 patch 或批注版本指纹。
- [changes.ts](../../src/extensions/preview/changes.ts)：单文件审查、搜索、跳行、位置记忆和实时磁盘变化。
- 已登记文件之后被外部改动，ledger 的右侧也包含它；不能叫“只看 agent 的修改”。P5 钉住基线语义。
- 新增批注需绑定旧/新侧、原始内容摘要及选中范围；只有行号会漂移。审查中的快照先固定，磁盘变化提示，刷新后再确认关联。

## 6. 证据边界及下一步

已验证的是数据语义和布局可行性。尚未验证：完整 trace 的实时/历史合并、重载及恢复、万步轨迹性能、时间轴密集点击与缩放、未知第三方消息格式、真实终端字体/拖选体验、完整子代理轨迹。

正式设计见 [trace-design.md](../trace-design.md)；审查提案见 [review-design.md](../review-design.md)。两者共享定位/返回的交互原则，不据此先建一个庞大的工作台框架。

## 7. 独立设计审查

Epi 只读阅读会话核对 Mayoi 与 preview；独立顾问审查三份文档，指出五项：Index 必须冻结 blob 引用；custom entry 的分支可达性与 leaf 变化；P3 仅验证内存追加；显示规范化不能吞掉格式差异；跨进程/异常时钟需降级。主控已分别修订对应章节。审查材料在 `.dev/probes/trace/mayoi-reader.out` 与 `advisor.out`。这是设计审查，不是生产实现验收。
