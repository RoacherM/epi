# 对话区排版实现（V-S 脊柱 · 动画）

日期：2026-10-21；状态：**W0–W9 已实现**（分支 `feat/tui-transcript-spine`，与本文的差异见 §7），待 Orca 实测与合并前审查。
设计依据：[tui-transcript-layout-design.md](tui-transcript-layout-design.md)（问题清单、R1–R5 排版系统、两轮 argon 评审）；视觉验收基准：`reports/transcript-layout-prototype.html`（`scripts/probes/transcript-layout-prototype.mjs` 生成，含 V-S 静态帧与 85 帧动画「一个回合的一生」）。

用户已确认：V-S 回合脊柱 + 简约动画风格（2026-10-21："我靠 这个太优雅了……做成简约的动画风格"）。

## 1. 目标与不变量

一句话：把对话区从「一列相同的 ◆ 矩形串」改成「一个回合 = 一条有主干、分支、收口的脊柱」，运行中脊柱即 M4/M6 动效的载体。

不变量（每条都要有测试守着）：

1. **纯渲染层**：模型收到的内容零变化——`test/model-snapshot.test.mjs` 必须无差异通过。
2. **宽度安全**：40/80/120/230 列下每行 `visibleWidth ≤ width`。
3. **鼠标契约不回归**：点击展开/折叠工具、思考、inspector 的行为与坐标不变（W2 是唯一的雷区，见该节）。
4. **回放一致性**：`/resume`、历史加载与实时流式走同一条渲染路径，布局规则不得分叉（gutter 结构在渲染时推导，同 `group.ts` 的折叠）。

## 2. 锁定决策（设计文档 §5/§7 的最终态）

| # | 决策 | 状态 |
|---|---|---|
| 思考行 | 单行 `∴ 2.1s`（dim）；纯"思考+工具"的步骤不印；回放无计时回退 `∴ thought`；只合并相邻思考段 | ✅ 用户定 |
| gutter 结构 | **V-S 回合脊柱**：主干 `│`、工具分支 `├─`、失败红分支、收尾 `╰─ Worked for`；V-T 弃用 | ✅ 用户定 |
| 动画 | 脊柱 = M4 流光轨的常驻形态；思考完成、工具完成沿脊柱/分支做 M6 衰减闪烁； settle 后沉淀为 `borderMuted` | ✅ 用户定 |
| bash 调用行 | `$`（琥珀）占标记位；去同 cwd 的 `cd … &&`；`$HOME` → `~`；多行/heredoc 首行 + 受保护暗色后缀 `· +N lines`；命令体 L2 `toolOutput` | ✅ |
| 成功状态 | 不占行、不打 `✓`，尾部暗色耗时（2 列空格脱开）；失败才 `✗ exit N · stderr 末行` 红字独占一行 | ✅ |
| 回复时钟 | 彻底移除（含展开态）；时间只在用户消息与 `Worked for` | ✅（评审 §3.2：展开加回会导致重排跳动） |
| 正文 measure | 76 列（内容列），`/settings` 可配（默认 76，可选"不限"）；代码块/表格/工具输出不受限 | ✅ |
| Markdown | 围栏行删除，真实语言给暗色标签（`text`/`txt`/`plain`/无语言不印）；无高亮代码块 `#b8c0cc`；行内代码 `#8fb3c0`；列表符号 `•` muted | ✅ |
| 用户消息条 | 保持通栏灰底（v1 不动；版心对齐留作后续可选项） | ✅ 默认 |
| `∴` 字形 / 加粗纪律 | 保持 `∴`；bold 渲染规则 v1 不动 | ✅ 默认 |
| formatTokens | `156M`/`1.2B`，独立先修 | ✅ |

## 3. 工作分解

依赖序：`W0`、`W1` 独立；`W3` 依赖 `W1`；`W2` 独立但建议在 `W7` 前；`W4`/`W5`/`W6`/`W9` 独立；`W7` 依赖 `W2`–`W5`（脊柱叠加在最终字形上）；`W8` 依赖 `W7`。

### W0 · formatTokens 补 M/B（独立小提交）
- 改：`src/tui/chrome.ts` `formatTokens`（现只有 K，156186k 应显示 156M）。
- 测：`test/tui-chrome.test.mjs` 加 999K/1.0M/156M/1.2B 边界。

### W1 · durationMs 透传（评审必须项 1）
- 事实：`tool_execution_end.durationMs` 在事件顶层（`pi-agent-core/types.d.ts:491`），`src/tui/transcript.ts:309` 的 `toolEnded` 只透传了 `event.result`；回放路径（`addFinishedMessage` 的 toolResult 消息）自带 `durationMs`。
- 改法：`Transcript.tool()` 里为每个 `ToolEntry` 建一个共享 cell（如 `{ durationMs?: number }`），`toolBlock` 的 framed renderers 闭包读它；`ToolEntry.updateResult` 写它（实时从 `event.durationMs`、回放从 `message.durationMs`）。Pi 的 `updateDisplay()` 在结果到达时会重新调 `renderCall`，所以耗时能出现在调用行——不需要碰 Pi 的渲染容器。
- 测：实时（模拟 tool_execution_end 事件）与回放（JSONL）两条路径调用行都带耗时。

### W2 · 连续工具去空行 + 鼠标补偿（评审必须项 2）
- 事实：空行来自 Pi `ToolExecutionComponent.render` 首行硬塞的 `push("")`（`tool-execution.js:171`），且其 `handleMouse` 写死 `y: event.y - 1`（:195）。`Transcript.tool()` 本来就 `add(component, false)`，改 `transcript.ts` 无效。
- 改法：在 `GroupedMessages.render`（已经遍历 children、知道前一个可见块是什么）里裁掉工具块的首行空串——仅当前一个可见块也是工具/思考行时；`GroupedMessages.handleMouse` 分派给被裁块的点击时 `y + 1` 补偿。
- 登记：pi-internals.md 新行 `tool-exec-leading-blank`（依赖首行空串 + `y-1` 两个行为，附回归测试）。
- 测：`test/tui-tools-group.test.mjs` 更新；新增"裁行后点击单行工具仍能展开"的鼠标回归。

### W3 · bash/文件工具调用行（依赖 W1）
- 改：`src/tui/tools/mutating.ts`（bash/edit/write）、`src/tui/bash-block.ts`（`!cmd` 同规格）、`src/tui/tools/read-only.ts`（单条 read/grep/find/ls 的 `(120 lines)` 内联）。
- 规格：`$ `（`bashMode`）或 `◆ `（muted）+ 命令/动词（`toolOutput`）+ 受保护尾部（dim：`· +N lines`、`· N lines`、`  耗时`）。尾部后缀在截断后拼接，截断省略号 `…` 用 dim。
- 失败：第二行 `✗ exit N · <stderr/错误首行>`（error 色），不丢现有 edit/write/read 的具体错误文案（`mutating.ts:249`、`read-only.ts:95`）。
- 测：`test/tui-tools-mutating.test.mjs`、`tui-tools-read-only.test.mjs`、`tui-bash.test.mjs` 快照更新；`visibleWidth` 40/80/120/230 属性断言。

### W4 · 思考行
- 改：`src/tui/assistant-block.ts` `ThinkingBlock.renderLines`：折叠态 `∴ <dur>`（dim，无 bold 无时钟）；流式中保持 `∴ Thinking…` + 尾 3 行预览；回放无计时 → `∴ thought`。
- 眉题规则（排版系统 R4）：实现侧在 AssistantBlock 内做不到"看后面有没有正文"——规则放在 W7 的回合渲染层：布局时若该思考行之后到下一个工具/回合结束之间没有正文行，则不印该行（耗时仍在 `Worked for` 里）。`splitSegments` 的相邻合并行为不变，跨正文的思考段不合并。
- 测：`test/tui-thinking.test.mjs` 更新；`test/tui-thinking-parity.test.mjs` 只管展开态——展开态渲染不变，该测试应原样通过。

### W5 · 移除回复时钟
- 改：`assistant-block.ts` 删 `clock`/`spread`/`innerWidth` 收窄逻辑（整篇按全宽渲染，顺带消掉展开/收窄的重排跳动）；用户消息时钟不动。
- 测：`tui-transcript.test.mjs`、`tui-app.test.mjs` 快照。

### W6 · Markdown 分段渲染 + measure（依赖 W9 的色值）
- 新文件：`src/tui/markdown-layout.ts`（暂定名）——`MeasuredMarkdown` 组件：
  1. 用 marked 顶层 token 切分（**只切顶层 `code`/`table`**；嵌在 `list`/`blockquote` 里的不切，避免序号重置/缩进误判——评审必须项 3）。parser 用 `createRequire(piEntry).resolve("marked")` 取 pi-tui 的同一个副本（pi-tui 直接依赖 `marked@18.0.11`，照 `pi-diff-package` 的既有模式登记进 pi-internals.md）；Epi 不新增直接依赖。
  2. 正文段：`Markdown` 实例，`paddingX = 5`，渲染宽度 `min(width, 76 + 2×5)`；measure 从 settings 读（默认 76，"不限"= width）。
  3. 代码段：全宽 `Markdown` 实例（保留 `lang`，语法高亮走 `highlightCode` 真值）；`MarkdownTheme.codeBlockBorder` 覆盖：闭围栏/无语言开围栏 → `""`（短！该行会被 `wrapTextWithAnsi` 折行，返回值必须永远 ≤ 渲染宽度——评审发现的哨兵泄漏），有语言 → 暗色标签；删除残余空行的后处理在本组件内做。
  4. 代码段每行前缀：第 3 列 `│`（`borderMuted`）+ 内容第 5 列（替代 `codeBlockIndent` 的 2 空格）。
  5. `listBullet`：`- `→`• `（muted），有序数字 muted；`code` → `mdCode` 新色。
  6. transformers：逐段调用 `options.transform`，在文档注明"转换器会看到片段而非整篇"（Pi 的转换器协议本来就按 availableWidth 工作，风险低）。
- `/settings`：`settings-command.ts` 加"正文行宽"项（76 / 不限）。
- 测：分段正确性（列表内代码块不切、表格不切、未闭合围栏）、40/80/120/230 宽度断言、快照。

### W7 · 回合脊柱容器（依赖 W2–W5）
- 改：`src/tui/tools/group.ts` 的 `GroupedMessages`（或抽 `TurnSpine` 包装层）：渲染时推导回合范围（用户消息块 → 回合 footer），范围内：
  - 每行第 1 列叠 `│`（`borderMuted`），含空行；工具块首行叠 `├─`，失败行叠红色 `├─`；footer 叠 `╰─`。
  - 非回合行（欢迎页、notice、custom 消息、用户消息条）一律不叠。
  - 只读工具合并行 `◈ …` 叠 `├─`（与单个工具同构）；`UserBashBlock`（`!cmd`）：调用行分支、输出预览行主干。
  - W4 的眉题规则在这里执行（思考行后无正文则跳过该行——只影响显示，AssistantBlock 数据不变）。
- 坐标安全：叠加只换字形不改行数/行高，`handleMouse` 行高映射不受影响（这是渲染时叠加相比 W2 裁行的天然优势，W2 仍需补偿）。
- 测：回合边界的脊柱起止（连续两回合、`/new` reset、回放）、notice/错误行排除、宽度断言。

### W8 · 脊柱动效（依赖 W7）
- 语义：回合进行中，脊柱就是 M4 的流光轨——`railGlyph(theme, row, t)` 画每行第 1 列（代替现状各块自画第 0 列 `┃`）；思考完成/工具完成时对应区段走 M6 衰减（`flash.ts` 公式，glyph 换成 `│`/`├`）；回合 settle 后整列沉淀为 `borderMuted`。
- 改：`GroupedMessages`/TurnSpine 增加运行态读取（`ToolEntry.status`、streaming 状态）与 tick 生命周期（复用 `motion.ts` 的 MOTION_TICK 契约：只在活跃时 tick、完成即停）；`tools/block.ts`、`assistant-block.ts` 里各自的第 0 列 rail 绘制随之移除，统一上移。
- 参考：`reports/transcript-layout-prototype.html` 第四节的 85 帧分镜是验收基准（呼吸→绿闪→分支亮起→分支绿闪→沉淀收口）。
- 测：`test/tui-motion.test.mjs` 扩展（脊柱帧断言、tick 停止契约）；Orca 真实终端走一遍动画。

### W9 · 主题色（与 W6 同行）
- 改：`src/tui/theme.ts` + `docs/tui-theme.md` 同步——夜：`mdCode` `#3A95AB→#8fb3c0`、`mdCodeBlock` `#89ddff→#b8c0cc`、`mdListBullet` `#9abdf5→#6c6c6c`；日：`mdCode` `#0082AA→#4f6f7a`、`mdCodeBlock` → 低饱和灰蓝（约 `#5c6b77`，实现时对截图定稿）、`mdListBullet` → `#767676`。
- 测：`test/tui-theme.test.mjs` 色值快照；日夜两版各出一张 prototype 帧对色。

## 4. pi-internals.md 新增登记

| id | 依赖 | 内容 |
|---|---|---|
| `tool-exec-leading-blank` | `tool-execution.js` | `render` 首行 `push("")`（:171）与 `handleMouse` 的 `y-1`（:195）；W2 的裁行与补偿依赖两者同时存在 |
| `markdown-codeblock-border` | `pi-tui/components/markdown.js` | `codeBlockBorder(text)` 收到围栏原文（:394,408）且该行会参与 `wrapTextWithAnsi` 折行（:227）——覆盖返回值必须短于任意渲染宽度 |
| `markdown-list-bullet` | 同上 | `listBullet(marker)` 收到 `- `/`1. ` 原文（:607-616） |
| `tool-exec-durationms` | `pi-agent-core/types.d.ts` | `tool_execution_end.durationMs` 顶层字段（:491）；W1 依赖 |

## 5. 测试与验收

- 单测/快照：上述各 W 的对应测试文件全量更新；新增 `test/tui-spine.test.mjs`（脊柱叠加、眉题规则、回合边界）。
- 属性断言：40/80/120/230 列逐行 `visibleWidth ≤ width`（覆盖所有新组件）。
- 不变量：`model-snapshot` 无差异；`pi-internals` 全绿。
- 原型回归：`scripts/probes/transcript-layout-prototype.mjs` 保持可跑，作为设计基准。
- 真实验收：Orca 真实终端 + 真实模型跑一个完整回合，对照 HTML 稿第四节逐帧核对动画；日夜两主题各一遍。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Pi 升级动了 `tool-execution.js` 首行/鼠标契约 | pi-internals 登记 + 点名报错（W2） |
| Markdown 分段破坏扩展 transformer 预期 | transformer 逐段调用 + 文档注明；若社区转换器出问题，`/settings` 行宽设"不限"即回退单段渲染 |
| 脊柱与极端内容（图片行、自定义扩展消息）叠加 | W7 白名单制：只有已知的回合内块型才叠脊柱，未知组件不叠 |
| 快照测试大面积更新掩盖真实回归 | 每个 W 独立提交、独立快照更新，review 按 W 粒度进行 |

## 7. 实现记录（主控定）

| W | 提交 | 与上文的差异及理由 |
|---|---|---|
| W0 | `formatTokens` 进位到 M/B（`999_999` → `1M`） | 无 |
| W1 | `toolEnded` 透传 `durationMs` | **不需要 per-entry cell**：Pi 的 `ToolExecutionComponent.getRenderContext` 已把 `result.durationMs` 作为公开字段 `context.durationMs` 交给渲染器（Pi 自己的 interactive-mode.js 也是 `updateResult({ ...event.result, isError, durationMs })`），只要实时路径不丢它。都是公开 API，**不登记** `tool-exec-durationms` |
| W3 | `CallLine`（`tools/common.ts`）：标记位 + 截断的主体 + 永不截断的暗色尾部 | 结果端只知道的摘要（`· 120 lines`、`· +3 −1`）经公开的 `context.state.callSummary` 交给调用行：`CallLine` 在 render 时才读尾部，那时 Pi 的 `updateDisplay()` 已跑过结果渲染器。调用行动词/路径一律 `toolOutput`、去掉 bold，read 的范围 `muted`；bash 失败行为 `✗ exit N · 输出末行`，超时/中止写原因（`✗ timed out after 30 seconds`）；`!cmd` 同规格（只有实时运行计时，回放没有耗时） |
| W4 | `∴` 行 | **眉题规则在 `AssistantBlock` 里执行**，不在 W7：一条消息内「思考段之后、下一个工具调用之前有没有正文」在消息内就能判断（正文在下一条消息里时中间必有工具调用）。流式时空的 text 部分也算正文，免得 `text_start` 到首个 delta 之间 `∴` 闪掉。被隐藏的思考让整条消息渲染 0 行，`GroupedMessages` 会桥接它：两侧的只读工具现在合并成一组（Ctrl+T 展开思考后又分开）。展开态与流式尾行的内容列随 W6 移到第 5 列（D22 对齐测试要求与正文同列），思考对拍测试改为 padding 5 比较 |
| W5 | 去掉回复时钟 | 无 |
| W6 | `MeasuredMarkdown`（`src/tui/markdown-layout.ts`） | 顶层代码块**直接绘制**（取 `token.lang` 首词做高亮与标签、`wrapTextWithAnsi` 全宽折行、复刻 Pi 的未闭合围栏裁剪），不再经 Pi `Markdown` + `codeBlockBorder` 后处理；`codeBlockBorder` 覆盖只管嵌在列表/引用里的代码块（返回 `""` 或语言名）。代码块空行也保留竖轨。转换器把代码段变成别的 markdown 时（如图表），按全宽 markdown 画。跨段的引用式链接定义（`[x]: url` 在代码块另一侧）会失效，LLM 输出里少见，接受。**`/settings` 的"正文行宽"项未做**：Epi 还没有存放自有显示设置的地方（Pi 的 SettingsManager 无通用键值），measure 先作为构造参数（默认 76，`Infinity` = 不限），设置项另立任务 |
| W9 | 主题色 | 日间 `mdCodeBlock` 定为 `#5c6b77`，还没对截图定稿 |
| W2/W7/W8 | `src/tui/spine.ts` + `GroupedMessages` 重写为 `Placed` 布局 | 回合 = 声明了 `spineRole` 的块的连续段（白名单），单独的 `!cmd` 不画脊柱。**动效只在运行中回合的末端 8 行（tip）**，其上各行已与沉淀后完全相同：pi-tui 主屏渲染器遇到屏外行变化会整屏重绘（清 scrollback），整条脊柱一起脉冲在超过一屏的回合上每帧触发（terminal-progress 测试超时暴露）。运行中工具的 `├─` 常亮（静态色，不逐帧变）。`AssistantBlock` 改为自己记录子块行范围（逐行闪烁与点击分派共用，`src/tui/rows.ts`）。`Worked for` 改为 `TurnFooter`（dim、第 4 列起），由脊柱画 `╰─`。回放仍没有 footer，脊柱止于最后一行 |

合并前审查第 1 轮（`epi -p` 审查会话，NOT ACCEPTABLE，6 条，均 CONFIRMED，已全部修复并各加回归测试）：图片保留行被画上脊柱，导致半滚出屏幕的图片消失（脊柱跳过图片行及其后的空保留行）；完成闪烁与运行中分支在 tip 之外变色（闪烁、分支高亮也只在 tip 内，闪烁只在最新回合的 tip）；转换器改写的代码段在改宽度或 invalidate 后不更新（缓存按源文本 `setText`）；回放后发新消息时上一回合被当成活回合（回合之后出现非回合块即不再活）；错误结果仍显示部分结果留下的摘要（出错时不显示摘要）；两个无用导出。第 2 轮（NOT ACCEPTABLE，1 条 CONFIRMED）：iTerm2 图片的保留空行在图片行**之前**（光标上移后绘制），第 1 轮只保护了 Kitty 的后置空行——现在图片行前后相邻的空行都不画。第 3 轮（NOT ACCEPTABLE，2 条 CONFIRMED）：Markdown 里的保留行是空格填充而非空串；前后都保护会把 Kitty 图片前普通的 spacer 行也空掉。改为按 pi-tui `Image` 的实际版式算精确范围：Kitty 取序列的 `r=` 高度、向后；iTerm2 取 `ESC[<n>A`、向前；空串或纯空格行都算保留行。回归测试覆盖两种协议、工具结果与 Markdown 两条路径、动画下一帧，以及 spacer 行保留脊柱。第 4 轮（NOT ACCEPTABLE，1 条 CONFIRMED）：没有 `r=` 的 Kitty 图片（`encodeKitty` 只给列数、高度由终端定）被当成 1 行——没有声明高度时改为占用其后所有空行（iTerm2 没有上移序列时同理）。

pi-internals 新登记：`tool-exec-leading-blank`、`pi-tui-marked`、`markdown-codeblock-border`、`markdown-list-bullet`（§4 的 `tool-exec-durationms` 不需要，见 W1）。

验证：完整测试 1203/1203（禁网沙箱）；`model-snapshot --diff` 无变化；`scripts/probes/transcript-layout-prototype.mjs` 仍可跑。Orca 实测（2026-10-21，夜间主题，GPT-6 Astra，一个 ls/read/git log/false 的只读回合）：静态布局与 HTML 稿 V-S 帧一致（连排 `├─`、红色失败分支、`│ │ ts` 代码块、`•` 列表、`╰─ Worked for`）；流式时 tip 为 `┃`；Ctrl+O 展开/收起正常；逐行点击三个相邻（已裁空行的）工具行，各自展开/收起的都是被点的那一个。**未做**：逐帧对照 85 帧分镜（Orca 读屏只有文本，颜色与脉冲靠 `test/tui-spine.test.mjs`、`test/tui-motion.test.mjs` 断言）、日间主题实测与 `mdCodeBlock` 定稿、`/settings` 行宽项、合并前审查。
