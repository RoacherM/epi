### 总体判断

这份方案把当前对话区最扎眼的噪音源（独占一行的 `exit 0`、整段琥珀色的长命令、散落在右侧的时钟、无上限的散文行宽、字面量 ` ``` ` 围栏）抓得很准，而且用真实会话切片做出了可运行的逐列对比原型，大方向成立。

但它**还不能直接按 §4 的路径进实现**。原型之所以看起来顺，是因为它绕过了 `Transcript`、`AssistantBlock`、`ToolExecutionComponent` 的真实生命周期，直接消费了离线 JSON。放回真实代码后，有 6 个会直接导致排版错位、功能损坏或测试挂掉的硬缺陷。把下面「必须改」的 6 项在设计文档里定死后，即可进入实现。

---

### 一、必须改（进实现前必须修正的 6 个问题）

#### 1. `[排版理论 · R3 网格]` 正文缩进到第 5 列后，主次层级反了，左边缘变成锯齿
- **现象**：R3 规定「第 3 列标记（`◆ ∴ ◈ ❯`），第 5 列内容；眼睛沿一条直线即可给信息分类」。为此 §4-J 把 `assistant-block.ts` 的 `CONTENT_PAD` 从 3 改成了 5。但看 `reports/transcript-layout-prototype.html` 的提案画面（第 180 至 209 行、第 580 至 651 行）：
  - 用户消息 `❯` 在第 2 列（`src/tui/chrome.ts:198` 是 `"  ❯ "`，文本在第 4 列），并不在第 3 列。
  - `∴ 10.3s` 在第 3 列。
  - 回答正文（L1 最高层级）因为**没有第 3 列标记**，直接缩进到了第 5 列。
  - 紧接着 `◆ $ ...` 的标记回到第 3 列，回合末尾的 `Worked for 19m32s`（`transcript.ts:378`）又回到第 3 列。
- **为什么有问题**：在排版里，向右缩进代表「从属层级」。现有代码（`assistant-block.ts:23`、`tools/block.ts:14`）让正文和工具标记 `◆` 都对齐在第 3 列，只有从属的工具输出（`RESULT_PREFIX = 5`）才退到第 5 列。把没有前置标记的正文推到第 5 列后，L1 正文在视觉上变成了 `∴ 10.3s` 的下级缩进块，和工具输出落在同一列，左边缘在「第 2 列 → 第 3 列 → 第 5 列 → 第 3 列」之间来回跳。
- **怎么改**：
  - **方案 A（推荐，改动最小且省列宽）**：以**第 3 列**为主轴。`∴`、`◆`、`◈`、**回答正文**、`Worked for` 全部从第 3 列起排（`CONTENT_PAD` 保持 `3`）；工具调用的文本因前面有两列宽的 `◆ ` 自然落在第 5 列，折叠态或展开态的工具次级输出也缩进到第 5 列。顺手把 `chrome.ts:198` 的用户消息前缀从 2 空格改成 3 空格，让 `❯` 真正落到第 3 列。
  - **方案 B**：如果坚持所有正文从第 5 列开始，那么正文首段第 3 列必须有一个起首标记（或把 `∴`、`◆`、`◈` 全部退到第 1 列、内容统一在第 3 列），同时消除窄屏对称内边距浪费（见第 2 条）。

#### 2. `[遗漏场景 · 窄屏与 R1]` Pi 的 `Markdown` 对称施加 `paddingX`，改成 5 会白白吃掉 10 列
- **代码事实**：`node_modules/@earendil-works/pi-tui/dist/components/markdown.js:187, 233` 里，`paddingX` 是**左右对称扣除**的（`contentWidth = width - this.paddingX * 2`）。
- **后果**：
  - 把 `CONTENT_PAD` 从 3 改成 5，等于每行左右各留 5 列空白，总共扣掉 10 列。
  - 在标准 **80 列**终端里，可用宽度只剩 `80 - 10 = 70` 列，连 R1 定的 76 列行宽（measure，单行字符数上限）都填不满，右侧平白浪费 5 列。
  - 在 **40 列**窄分屏里，可用宽度从 34 列跌到 30 列。
  - 顺带一提，设计文档第 28 行写的是「含左侧网格共 86 列」，而 HTML 报告第 68 行和第 493 行还写着「共 81 列」，两处口径不一致。
- **怎么改**：保持 `CONTENT_PAD = 3`（左右共 6 列，外框宽度设为 `Math.min(width, 76 + 6)` = 82 列），或者不在 `Markdown` 里用大 `paddingX`，而是给 `Markdown` 传 `paddingX = 0`，由外层统一在左侧补固定空格。

#### 3. `[实现风险 · §4-D]` 实时会话丢弃了 `durationMs`，且合并不该做在 `tools/block.ts`
- **原型为什么没暴露**：原型直接读了离线会话文件里的 `msg.durationMs`（`prototype.mjs:221`）。
- **代码事实**：
  1. 在真实运行中，Pi 的 `tool_execution_end` 事件把 `durationMs` 放在事件顶层（`event.durationMs`），不在 `event.result` 里。
  2. `src/tui/transcript.ts:308-309` 的 `toolEnded` 写的是：
     `this.tool(event.toolName, event.toolCallId).updateResult({ ...event.result, isError: event.isError }, false)`
     **实时跑完工具时，`event.durationMs` 被直接丢掉了！** 只有重放历史消息（`transcript.ts:396`）才有 `durationMs`。
  3. `src/tui/tools/group.ts:83` 的 `ToolEntry.updateResult` 参数类型和 `src/tui/tools/types.ts:6-19` 的 `ToolRenderContext` 接口都漏了 `durationMs?: number`。
  4. §4-D 计划在 `tools/block.ts` 把调用行与结果合并成一行，但 Pi 的 `ToolExecutionComponent`（`tool-execution.js:207-237`）是把 `renderCall` 和 `renderResult` 返回的两个组件塞进纵向容器上下排列的，且 sudah 把 `durationMs`、`isPartial`、`isError`、`expanded` 全传给了 `renderCall` 的 `context`（`tool-execution.js:76-92`）。
- **怎么改**：
  - 先在 `transcript.ts:309`、`tools/group.ts:83`、`tools/types.ts` 把 `durationMs: event.durationMs` 透传打通。
  - 不要去魔改容器合并两行，直接在 `renderCall`（或 `tools/block.ts` 的 `Railed` 在 `isCall === true && !context.isPartial && !context.isError` 时）把状态和耗时拼在调用行尾部；成功且未展开时，`bash` 的 `renderResult` 直接返回空数组 `LinesComponent([])`。

#### 4. `[实现风险 · §4-E]` 连续工具之间的空行来自 Pi 的 `ToolExecutionComponent` 内部，改 `transcript.ts` 无效，且删空行会弄坏鼠标点击坐标
- **代码事实**：
  - §4-E 写「改哪里：`transcript.ts` 间距规则；风险：低」。但 `src/tui/transcript.ts:450` 添加工具时**本来就是 `this.add(component, false)`（不加 `Spacer`）**。
  - 连续工具之间的空行，实际上来自 `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:230-232`：
    `if (contentLines.length > 0) { lines.push(""); lines.push(...contentLines); }`
    也就是说，每一个工具组件自己在渲染结果第 0 行硬塞了一行空行！
  - 更隐蔽的坑在同一文件第 253 行：`ToolExecutionComponent.handleMouse` 处理点击展开时，写死了 `y: event.y - 1` 来跳过第 0 行的空行。
- **后果**：如果不在 `ToolEntry.render`（`src/tui/tools/group.ts:106`）里剥掉这个前导空行，§4-E 根本实现不了；而一旦剥掉前导空行却不修 `handleMouse`，用户点击单行工具（第 0 行）时，`event.y - 1` 变成 `-1`，点击展开功能直接失效！
- **怎么改**：在 `ToolEntry`（或 `GroupedMessages`）判断前一个可见块是否也是工具或 `∴` 思考行，若是则裁掉 `super.render(width)` 首行空串，并在 `ToolEntry.handleMouse` 中把裁掉空行时的 `event.y` 加 1 补偿回去，同时在 `docs/pi-internals.md` 登记这个契约并补回归测试。

#### 5. `[实现风险 · §4-F / §4-G]` 正则切分 Markdown + `\x01FENCE\x01` 哨兵过滤有 4 处结构性破损
- **原型已出现的 bug**：`prototype.mjs:206` 把所有代码块写死成了 `` `\`\`\`text\n${seg.text}\n\`\`\`` ``，丢掉了 `seg.lang`，导致所有语法高亮全部失效。
- **放到真实渲染里的 4 个破损点**：
  1. **破坏列表与引用上下文**：`splitMarkdownSegments` 用 `/^\s*```(\S*)\s*$/` 在源码层切分。一旦代码块嵌在有序列表（`1. 第一步` 下面跟缩进代码块，再跟 `2. 第二步`）或引用块（`> `）里，切开成多个 `Markdown` 实例后，代码块会丢失列表/引用缩进，下半截列表的序号会重置，甚至后续缩进段落会被 Marked 误判成 4 空格缩进代码块。
  2. **破坏表格（违背 R1）**：R1 明确写「代码块、表格、工具输出是数据，不受度量限制」，但 `splitMarkdownSegments` 只切了围栏代码块，Markdown 表格仍然留在 `prose` 段里被强行压到 76 列，在宽屏下会被挤碎。
  3. **窄屏下 `\x01FENCE\x01` 哨兵泄漏**：`pi-tui` 的 `Markdown.render`（`markdown.js:227`）会对 `renderToken` 产出的每一行执行 `wrapTextWithAnsi(line, contentWidth)`。如果代码块语言标签较长或终端很窄，`codeBlockBorder` 返回的带 `\x01FENCE\x01` 的行会被折成两行，第 2 行不包含 `\x01FENCE\x01`，过滤后就会把半截残余字符漏到屏幕上。
  4. **绕过 `AssistantMessageComponent` 会破坏扩展钩子和增量缓存**：真实代码里 `AssistantBlock` 把文本交给 Pi 的 `AssistantMessageComponent` 渲染，后者负责调用扩展注册的 `MarkdownTransformer`。切成多段不同宽度的 `Markdown` 会让转换器在碎片段落上重复执行。
- **怎么改**：
  - 围栏符号不要靠「塞控制字符再按行删除」的后处理。如果只改样式，可以让 `codeBlockBorder` 对空标签返回 `""`，对有语言标签返回暗色文字；如果一定要去掉闭围栏空行，建议在 AST/token 层或 forked 渲染分支处理，至少要把 `codeBlockBorder` 文本控制在单列内防止折行泄漏。
  - 如果保留分段宽度方案，切分器必须用 `marked.lexer(text)` 在顶层 token 级别把顶层 `code` 和 `table` 切出来（嵌在 `list` 或 `blockquote` 内部的不切），而不是用行正则切原始字符串。

#### 6. `[遗漏场景 · 非 bash 工具与回放态]` 方案漏掉了 `edit`、单次只读工具、用户 `!cmd`、展开态和历史回放态的规则
- **历史回放没有分段思考耗时**：
  - 原型用整条消息的模型总耗时 `msg.durationMs` 冒充了 `∴ 16.9s`（`prototype.mjs:261`）。
  - 真实代码里（`src/tui/assistant-block.ts:108-115`），实时流式有精确的 `thinking_start` 到 `thinking_end` 计时；但 **`/resume` 或启动加载历史会话时，JSONL 里没有保存单段思考耗时**（只有整条回复含输出文本在内的总耗时）。现有代码在回放时特意渲染为不带时间的 `◆ Thought`。
  - 如果改成 `∴ <耗时>`，历史回放时没有耗时，单独一个 `∴` 晾在行首像乱码；如果拿整条消息的 `durationMs` 顶替，又会把模型写 200 行代码的时间全算在思考头上。必须定死回放态的回退文案（例如回放无计时时显示暗色 `∴ thought`，或扩展 session 数据持久化思考耗时）。
- **同一条消息内交错的多段思考不能硬合并成一行**：
  - §4-A 写「同一消息的多段思考合并成一行」。但 `assistant-block.ts:47-62` 的 `splitSegments` 已经合并了相邻的 `thinking` 块；当模型出现 `thinking → 输出一段话 → thinking → 调工具` 时，两段思考中间隔着正文，强行合并会打乱时间顺序，也会破坏按 `startIndex` 绑定的点击展开状态。应明确为「仅合并相邻的思考块（保持现有 `splitSegments` 行为）」。
- **`edit`、单条 `read/grep/find/ls`、`!cmd`（`UserBashBlock`）怎么显示未定义**：
  - 原型只测了 `bash`、`write` 和聚合的 `◈ Read 3 files`。
  - `edit`（`src/tui/tools/mutating.ts:360-365`）：现在第 1 行是 `◆ edit path`，第 2 行是绿红配色的 `+N -M`。按新规是把 `· +N -M ✓ 耗时` 内联到第 1 行，还是保留第 2 行？
  - 单个未聚合的只读工具（`src/tui/tools/read-only.ts`）：当只有 1 个 `read` 时不触发 `◈` 聚合，现在会画两行（第 1 行 `◆ read path`，第 2 行重复一遍 `path (120 lines)`）。新方案下应当把 `(120 lines)` 像 `write` 一样内联到第 1 行并省掉第 2 行。
  - 用户自己执行的 `!cmd`（`src/tui/bash-block.ts`）：§4-C 和 §4-J 点名要改 `bash-block.ts`。但 `!cmd` 的折叠态默认就要展示最多 5 行命令输出，最后跟一行 `exit 0`。如果去掉 `exit 0` 改成调用行尾部的耗时，当下面跟着 5 行输出时视觉边界在哪？需要明确。
  - **测试契约冲突**：`test/tui-thinking-parity.test.mjs` 强制要求展开态思考块与 Pi 原生 `AssistantMessageComponent`（`paddingX = 3`、全宽、原版 `MarkdownTheme`）逐字节一致。改 `CONTENT_PAD`、行宽或列表符号前，必须明确展开态思考块是否同步调整并更新该测试。

---

### 二、建议改（明显影响视觉品质与可读性的 4 个问题）

#### 1. `[排版理论 · R2 对比 §4-C]` 工具命令行用了 L1 正文色 `#e1e1e1`，在宽屏下压过了真正的回答正文
- **矛盾点**：
  - R2 白纸黑字写着：「回答正文（L1 `text` `#e1e1e1`）＞ 工具调用（L2 `toolOutput` `#c8c8c8`）＞ 思考与状态（L3 `muted`/`dim`）」。
  - 但 §4-C 和 `prototype.mjs:226` 却把 `bash` 命令体和 `write` 工具名涂成了 L1 的 `text`（`#e1e1e1`）！
- **视觉后果**：看 HTML 报告 200 列提案图（第 580 至 593 行）：回答正文被限制在 76 列，而紧挨着的 `bash` 命令长达 190 列、同样用最高亮度的 `#e1e1e1`，头尾还带着琥珀色 `$` 和亮绿色 `✓`。结果就是**工具行在面积、亮度和色彩饱和度上全面压倒了夹在中间的两行正文**，违背了 R2 的初衷。
- **建议**：严格执行 R2。工具命令体和参数用 L2 `toolOutput`（`#c8c8c8`），把 L1 `text`（`#e1e1e1`）留给模型的回答正文。`#c8c8c8` 依然是干净的中性灰白，既彻底消除了整行琥珀色的刺眼感，又能和 `#e1e1e1` 的正文拉开细腻的主次层级。

#### 2. `[具体挑刺 · R4/R5 色彩纪律]` 每条成功工具尾部的亮绿色 `✓`（`#9ece6a`）制造了新的「绿点噪音」
- **问题**：§1 问题 3 说得很对，「成功是常态」。既然成功是常态，就不该给每一条常态行都挂一个高饱和度的语义色图标。在连续多条长短不一的工具调用里（如 HTML 报告第 192 至 194 行），亮绿色的 `✓` 随着命令长度参差不齐地散落在屏幕中右部，形成了新的视觉噪点。而当工具真正完成的那一刻，Epi 已经有 400ms 的绿色流光轨道（`flash.ts`）提供即时反馈了。
- **建议**：把色彩留给异常（失败时用红色 `✗` 或红色 `◆` + 错误摘要行）。常态成功时，调用行尾部**只放暗色耗时**（如 `  2m20s`，`dim` `#585858`），或者把 `✓` 也降为 `dim` 色。没有报错就是成功，版面会干净得多。

#### 3. `[具体挑刺 · §4-C]` 多行命令与 heredoc 的 `· +N lines` 存在 3 个细节瑕疵
- **瑕疵 1（原型上色写错了）**：`prototype.mjs:82, 226` 把 `shortenCommand` 返回的 `· +29 lines` 直接包在了 `themeNext.fg("text", ...)` 里面。所以在 HTML 报告里，`· +29 lines` 和 `· +8 lines` 全是高亮的 `#e1e1e1`，根本不是 §4-C 说的暗色（而且 HTML 第 261 行图例还残留着旧文案 `heredoc 标 ⏎N`）。
- **瑕疵 2（长首行会把 `+N lines` 截断吞掉）**：`prototype.mjs:241` 先把 `· +N lines` 拼进命令字符串，再做整行宽度截断 `truncateToWidth(content, budget, "…")`。一旦多行命令的第 1 行本身超过预算宽度，尾部的 `· +N lines` 就会被直接截掉，用户完全看不出这是一条多行脚本。
- **瑕疵 3（与输出省略号撞词）**：Epi 在折叠工具**输出**时已经用了 `… +N lines`（`src/tui/tools/common.ts:78`）。在**输入**命令行上也写 `· +8 lines`，容易让人误以为「这条命令有 8 行输出被折叠了」。
- **建议**：将多行命令标记从命令字符串中拆出来，作为受保护的尾部后缀（截断完首行命令后再拼上去），用 `dim` 色渲染为 `⏎ +8 lines`（与 HTML 图例一致，一眼能看出是换行脚本行数而非 stdout 行数）。

#### 4. `[遗漏场景 · 失败工具与长用户消息]` 失败工具不该只显示 `exit 1`，用户长消息也应遵守行宽
- **失败工具的诊断信息**：原型第 245 行对所有失败工具一律在第二行画 `exit 1`。在真实使用中，`edit` / `write` / `read` 失败需要显示具体错误原因首行（现有 `mutating.ts:249`、`read-only.ts:95` 已实现，不应退化为 `exit 1`）；而 `bash` 失败时如果折叠态只写 `exit 1`，用户每次都得按 `Ctrl+O` 才能看到为什么挂。建议 `bash` 失败时在第二行显示 `exit N · <stderr 最后一行摘要>`（`error` 色）。
- **长用户消息的行宽**：`UserMessageBlock`（`src/tui/chrome.ts:168-205`）目前按整行宽度减去时钟宽度来折行。在 200 列终端下，用户贴一段长问题会拉满 183 列，而下面模型的回答折在 76 列，上下脱节。建议用户消息的文本折行宽度也同样受 76 列度量限制（背景色条仍可铺满整行，保持回合分隔感）。

---

### 三、可选（锦上添花的打磨项）

1. **`[具体挑刺 · 思考行可发现性]` 折叠思考行 `∴ 16.9s` 的交互提示**：
   去掉 `Thought` 词根后，新用户可能不知道 `∴ 16.9s` 是思考过程、更不知道它可以点击或按 `Ctrl+T` 展开。可以在底部状态栏提示或首次悬停/展开态保留完整标题（例如展开后首行显示 `∴ Thought for 16.9s`），折叠态保持极简的 `∴ 16.9s`。
2. **`[排版理论 · §4-B]` 彻底移除回复行时钟，不必在展开态加回**：
   §4-B 提到「依赖每条时间的话，展开态保留」。但在 `AssistantBlock`（`src/tui/assistant-block.ts:321-336`）里，一旦展开态加回右侧时钟，`innerWidth` 就会少掉 10 列，导致按 `Ctrl+O` / `Ctrl+T` 时整篇回答重新折行跳动。直接彻底移除模型回复行的时钟，只保留用户消息时钟和回合末的 `Worked for` 最稳妥。
3. **`[实现风险 · §5]` `formatTokens` 的 `↑156186k` bug 单独成 PR 先修**：
   这个问题（`src/tui/chrome.ts` / 状态栏 token 格式化超过 `999k` 未进位到 `M`）与对话区排版正交，单独拆一个小提交先合入，能减小排版 PR 的审查面。

---

### 四、进入实现的检查清单（Pre-flight Checklist）

只要把以下 5 个决定写回 `docs/tui-transcript-layout-design.md`，就可以直接开工：
1. **左轴对齐**：正文留在第 3 列（`CONTENT_PAD = 3`），还是退到第 5 列？若留在第 3 列，`❯`、`∴`、`◆`、`◈`、正文、`Worked for` 全部对齐第 3 列，且自动避开 80 列窄屏浪费。
2. **工具行与成功标记配色**：工具命令体改回 R2 规定的 `toolOutput`（`#c8c8c8`）；成功态尾部是用暗色 `✓ 2m20s` 还是只显示暗色 `2m20s`？
3. **非 bash 工具与回放态规格**：明确 `edit`（`+N -M`）、单条只读工具、`!cmd`（`UserBashBlock`）的行内合并格式，以及历史回放无思考计时时的回退文案（如 `∴ thought`）。
4. **连续工具去空行的实现点**：从 `transcript.ts` 改为在 `ToolEntry.render` / `handleMouse` 处理 `ToolExecutionComponent` 的首行空串与鼠标 `y` 坐标补偿。
5. **Markdown 分段与围栏方案**：改用顶层 AST token（覆盖顶层 `code` 与 `table`，跳过列表/引用内嵌块）切分，修复 `seg.lang` 语法高亮丢失，并替换掉会因窄屏折行而泄漏的 `\x01FENCE\x01` 后处理。
