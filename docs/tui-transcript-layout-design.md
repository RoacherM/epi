# 对话区排版与视觉层级设计

日期：2026-10-21 起草；状态：**已确认（V-S 脊柱 + 动画），已实现（W0–W9），实现方案与差异见 [tui-transcript-layout-implementation.md](tui-transcript-layout-implementation.md)**。
依据：用户 0.1.21 实际使用截图（"整体的布局不是特别的优雅，尤其是视觉层面……比如输出的排版"），以及下文列出的代码位置。基线设计见 [tui-design.md](tui-design.md)、[tui-theme.md](tui-theme.md)。

**设计稿（先看这个）**：`reports/transcript-layout-prototype.html`，由 `node scripts/probes/transcript-layout-prototype.mjs` 生成。同一段真实会话（0.1.21 发布当天的 session 切片，fixture 在 `scripts/probes/fixtures/transcript-layout-session.json`）渲染两遍：「现状」帧是 dist 真实组件（`AssistantBlock` / `UserMessageBlock` / `toolBlock` + 内置渲染器）的输出，「提案」帧是 §4 规则的可执行实现的输出。不是手绘稿。本文 §3 的文本 mock 从渲染结果誊录。

## 1. 截图里看到的问题（都对照过代码）

| # | 现象 | 原因（代码） | 影响 |
|---|---|---|---|
| 1 | 每一步前都有一行 `◆ Thought`，右边还有时间 | `assistant-block.ts` 每个思考段都画标题行，每条回复都带右侧时钟（`clock`） | 一轮 6 个工具调用就有 6 行 `Thought` + 6 个时间，信息最少的行最显眼 |
| 2 | bash 调用行整行橙色、几乎每条都以 `cd /Users/…/epi &&` 开头、被截成 `…` | `mutating.ts` `renderCall` 把整条命令画成 `bashMode` 色，只取第一行 | 命令是最长、最亮的元素，压过了回答正文；真正有区别的部分被截掉 |
| 3 | 每个 bash 下面单独一行 `exit 0` | 折叠态的结果就是一行状态 | 成功是常态，却占了一半的行数 |
| 4 | 正文一行横跨整个终端（截图约 230 列） | 回答的 Markdown 按终端全宽排 | 长行难读；列表、段落的视线来回跨度过大 |
| 5 | 代码块露出 ` ```text ` 和 ` ``` ` 两行 | Pi 的 Markdown 组件把围栏画成 `codeBlockBorder` 色的原文（`pi-tui/components/markdown.js:394,408`） | 像没渲染完 |
| 6 | 行内代码到处是青色 | `mdCode` 是饱和的 `#3A95AB` | 一段话里五六处跳色，抢走粗体标签的层级 |
| 7 | 思考的 `◆` 在第 1 列、工具的 `◆` 在第 3 列、正文在第 3 列 | 两套前缀宽度 | 左边缘参差，没有一条对齐线 |
| 8 | 右下角 `↑156186k` | `chrome.ts` `formatTokens` 只有 K，没有 M | **缺陷**：156M 显示成 156186k |

勘误（原型跑真实代码后发现）：上一版 §3 的"改前" mock 里第三条命令下面画了输出（`epi-0.1.21.tgz` 等），实际折叠态的 bash 永远只画 `exit 0`（`mutating.ts` `renderResult` 的 `!options.expanded` 分支）。HTML 稿的现状帧是真实输出，以它为准。

## 2. 排版系统：五条规则

每条规则先给理论依据，再给可执行定义。§3 的提案帧就是这套定义的渲染结果。

**R1 · 度量（measure）** — 连续阅读的最佳行长是 45–75 个拉丁字符（Bringhurst《The Elements of Typographic Style》；WCAG 1.4.8 要求 ≤80）。终端等宽，中英混排时汉字占两列，约 38 个汉字即达上限。
→ **正文内容列宽封顶 76 列**（含左侧网格共 86 列：Pi 的 Markdown 组件 paddingX 左右各加一次）。代码块、表格、工具输出是"数据"，不受度量限制（实现上按段分别给宽度，见 §4-F）。

**R2 · 层级（hierarchy）** — 终端没有字号，层级只能靠墨量（亮度对比）和字重。三级：回答正文（L1 `text`）＞ 工具调用（L2 `toolOutput`）＞ 思考与状态（L3 `muted`/`dim`）。越常见、信息越少的行越暗。
→ **bold 只留给需要扫读定位的词**；现在加粗的 `◆ Thought` 恰好违反了这条：最弱的信息拿了最强的字重。

**R3 · 网格（grid）** — 一条左轴：第 0 列轨道（运行动画/完成闪烁预留）、第 3 列标记（`◆ ∴ ◈ ❯`，两列宽）、第 5 列内容。思考、工具、正文共用；眼睛沿一条直线即可给信息分类。

**R4 · 节奏（rhythm / 亲密性）** — 间距即语义：**同组 0 空行**（连续工具调用连排；`∴` 行贴在它引出的动作上方）、**块间 1 空行**（正文 ↔ 工具组 ↔ 下一段）。**成功不占行**：常态折叠进调用行尾部的 `✓ 耗时`，失败才单独占一行红字。时间戳只属于回合边界（用户消息、`Worked for`），段落级时钟是噪音。
→ 推论：状态必须**内联在命令尾部**，而不是右对齐到终端边缘——宽终端下右对齐会让状态漂到 200 列开外，与所属行失去亲密性（HTML 稿第三节有 200 列对照）。

**R5 · 色彩纪律（color discipline）** — 全局只留一个强调色 + 语义色：琥珀 = `$` 提示符，绿 = 成功/新增，红 = 失败/删除，紫 = 交互强调。装饰性高饱和色降饱和到正文相邻色阶；结构字符（列表符号、代码围栏、语言标签）用 `muted`，不抢正文。
→ 唯一改色：`mdCode` `#3A95AB` → `#8fb3c0`（夜）/ `#4f6f7a`（日）；`mdListBullet` 亮蓝 → `muted`。HTML 稿第一节的色板是主题真值。

## 3. 改前 / 改后（从真实渲染誊录，116 列；完整对照见 HTML 稿）

改前（场景 A 开头）：

```text
 ◆ Thought                                                                           6:48 PM

   ◆ $ cd /Users/byronwayne/Projects/sides/epi && echo "local COLORTERM=$COLORTERM TERM=$TERM…
     exit 0

 ◆ Thought                                                                           6:51 PM
   It passes in both environments. Now the full suite again in the CI-like environment, followe…

   ◆ $ cd /Users/byronwayne/Projects/sides/epi && env -u COLORTERM -u TERM_PROGRAM -u PI_OFFLI…
     exit 0
```

改后：

```text
   ∴ 16.9s
   ◆ $ echo "local COLORTERM=$COLORTERM TERM=$TERM"; env -u COLORTERM -u TERM_PROGRAM …  ✓ 2m20s

   ∴ 10.3s
   It passes in both environments. Now the full suite again in the CI-like
   environment, followed by commit, merge, and push:

   ◆ $ env -u COLORTERM -u TERM_PROGRAM -u PI_OFFLINE TERM=xterm-256color sandbox-exec…  ✓ 2m21s
   ◆ $ git add test/startup-page.test.mjs && git commit -q -F - <<'EOF' · +8 lines    ✓ 11.6s
   ◆ $ gh run watch 39588065878 --exit-status --interval 20 > /tmp/epi-release-run.log…  ✓ 12m11s
```

回答里的 Markdown（改后）：围栏行删除、语言名 `text` 作暗色标签、代码按全宽不折行（正文仍按 76 列折行）、列表符号 `•`（muted）、行内代码 `#8fb3c0`。

## 4. 逐项方案

| # | 方案 | 改哪里 | 风险 |
|---|---|---|---|
| A | 折叠的思考画成 `∴ 2.1s`（`dim`，不加粗、无时钟）；正在思考仍是 `∴ Thinking…` + 流光轨道；展开、点击切换不变。**评审修订**：只合并相邻思考段（保持 `splitSegments` 现有行为，不跨正文硬合）；历史回放没有逐段计时，回退文案为暗色 `∴ thought`（不挂假时长） | `assistant-block.ts` | 低 |
| B | 时间只在用户消息和回合结束的 `Worked for` 行上出现，回复不再每条带时钟 | `assistant-block.ts`、`transcript.ts` | 低；依赖每条时间的话，展开态保留 |
| C | bash 调用：去掉与会话 cwd 相同的 `cd <cwd> &&`/`cd <cwd>;`；其他绝对路径里的 `$HOME` 折成 `~`；多行/heredoc 只显示首行，**截断后**再拼受保护的暗色后缀 `· +N lines`（长首行不能吃掉它）；`$` 用 `bashMode`，**命令用 `toolOutput`（L2，评审修正：§4 原写 `text`，与 R2 自相矛盾）** | `tools/mutating.ts`、`bash-block.ts` | 低；只改显示，悬浮窗和复制仍是原命令 |
| D | 成功状态内联到调用行尾部：`✓` 与耗时都用 **dim**（评审修正：成功是常态，亮绿 `✓` 在连续调用里形成新的噪点，完成瞬间已有 400ms 流光反馈）；耗时用 `durationMs`（<1s 显示毫秒）；失败单独一行红色 `exit N · stderr 末行摘要`。****评审发现的硬前提**：实时路径 `transcript.ts` `toolEnded` 只透传 `event.result`，把 `tool_execution_end.durationMs`（事件顶层字段，`pi-agent-core/types.d.ts:491`）丢了——需要先把 `durationMs` 打通（`transcript.ts` / `tools/group.ts` / `tools/types.ts`）；合并不去魔改容器，直接在 `renderCall` 尾部拼状态，成功且折叠时 `renderResult` 返回空 | `transcript.ts`、`tools/group.ts`、`tools/types.ts`、`tools/mutating.ts` | 中 |
| E | 节奏：连续工具调用（包括"只有工具调用的空消息"桥接的跨消息连排，复用 `group.ts` 的判定）0 空行；文字块与工具组之间 1 空行。**评审修正：改哪里不是 `transcript.ts`**——工具块之间的空行来自 Pi `ToolExecutionComponent.render` 硬塞的首行 `push("")`（`tool-execution.js:171`），且它的 `handleMouse` 写死 `y: event.y - 1` 跳过该行（:195）：要在 `ToolEntry.render` 里按前一个可见块裁掉首行空串，并在 `handleMouse` 里做 y 坐标补偿，否则点击展开失效；契约登记进 pi-internals.md + 回归测试 | `tools/group.ts`（`ToolEntry`） | 中 |
| F | 正文 measure 76 列：**按段给宽度**——用 marked lexer 的**顶层 token** 切分（只切顶层 `code`/`table`，嵌在列表/引用里的不切，否则序号重置、缩进块被误判），各段各用一个 Pi `Markdown` 实例，正文段 76 + 2×paddingX、代码段全宽。原型已验证路径，但原型的行正则切分 + 写死 ` ```text ` 只是 mock 手段（丢语法高亮），实现必须用 AST + 保留 `lang` | `assistant-block.ts` 给 Markdown 的宽度 + 一个分段包装组件 | 中 |
| G | 代码块围栏：`MarkdownTheme.codeBlockBorder` 覆盖（开围栏→暗色语言标签、闭围栏→空行），**返回文本必须短**——评审发现该行会被 `wrapTextWithAnsi` 折行，长哨兵/长标签在窄屏会泄漏残余字符到下一行；要删行则在分段包装组件里做，不用控制字符哨兵 | Epi 传给 `AssistantMessageComponent` 的 `MarkdownTheme` + 同上包装组件 | 中：依赖 Pi 用 `codeBlockBorder` 画围栏原文（`markdown.js:394,408`），登记进 pi-internals.md 并测试 |
| H | 列表符号 `-` → `•` 并改 `muted`；`mdCode` → `#8fb3c0`（夜）/ `#4f6f7a`（日） | 同一个 `MarkdownTheme` 的 `listBullet(marker)`（`markdown.js:607-616`）；主题色在 `theme.ts`、tui-theme.md | 低；`listBullet` 登记进 pi-internals.md |
| I | `formatTokens` 补上 M、B：`156M`、`1.2B` | `chrome.ts` | 无（缺陷修复，可独立先上） |
| J | 左边缘网格：两种方案待拍板（见 §5-6）。**gutter 式**（原型当前实现）：标记列 3、内容列 5；**单轴式**（评审推荐）：`∴ ◆ ◈ ❯`、正文、`Worked for` 全部从第 3 列起排，工具文字因 `◆ ` 自然落在第 5 列，改动更小、80 列下不浪费列宽（Pi 的 `Markdown` paddingX 左右对称扣除，paddingX=5 会吃掉 10 列）。两条路都需要处理 `test/tui-thinking-parity.test.mjs` 的逐字节契约 | `assistant-block.ts`、`tools/block.ts`、`tools/group.ts`、`bash-block.ts`、`chrome.ts`（`❯` 对齐） | 中 |

## 5. 决策记录

1. **思考行**：✅ 已定（用户）：单行 `∴ 2.1s`；回放无计时时 `∴ thought`（评审修订）。
2. **每条回复的时间**：建议彻底去掉（含展开态——展开加回时钟会让 `innerWidth` 变化、整篇重排跳动；评审 §3.2），只保留用户消息与 `Worked for`。待确认。
3. **正文行宽**：建议做成 `/settings` 项，默认 76，可选"不限"。待确认。
4. **连续的 bash 调用**：不合并成 `◈ Ran 3 commands`（命令内容本身是要扫读的，与只读工具不同）。待确认。
5. **颜色**：HTML 稿（v2）已按评审收敛：命令体 L2 `toolOutput`、`✓` 与耗时 dim、行内代码 `#8fb3c0`。待确认。
6. **左轴**（评审新增）：gutter 式（标记 3 / 内容 5，原型现状）还是单轴式（全部从第 3 列起排，改动小、窄屏不浪费）。待确认。
7. **用户消息行宽**（评审新增）：正文受 76 列度量限制，背景色条仍铺满整行保持回合分隔感。待确认。
8. **非 bash 工具规格**（评审新增，实现前定死）：`edit` 的 `+N −M` 内联到调用行；单条只读工具的 `(120 lines)` 内联；`!cmd`（`UserBashBlock`）折叠态保留输出预览、尾部状态格式同 bash。

## 6. 验证方式

- ✅ 离线原型：`scripts/probes/transcript-layout-prototype.mjs` 生成 `reports/transcript-layout-prototype.html`（现状 = dist 真实组件，提案 = §4 规则的可执行实现，数据源是同一段真实会话）；`--print=release-next` 等可在终端直接看任意一帧。
- 实现时：40/80/120/230 列下每行 `visibleWidth ≤ width`；`model-snapshot` 无差异；快照测试按新排版更新；Orca 真实终端、真实模型走一遍。

## 7. 评审记录

### 7.1 工程评审（2026-10-21 · gemini-4-argon，全文：[notes/review-transcript-layout-argon.md](notes/review-transcript-layout-argon.md)）

总体判断：问题抓得准、原型方法成立，但原稿不能直接进实现——6 个必须改项已全部核对属实并写回 §4：

1. `tool_execution_end.durationMs` 在实时路径被丢弃（`transcript.ts` 只透传 `event.result`）——D 的前置条件
2. 工具块前导空行来自 Pi `ToolExecutionComponent` 内部且 `handleMouse` 写死 `y-1`——E 的实现点改到 `ToolEntry` 并补偿坐标
3. 行正则切 markdown + 控制字符哨兵的 4 处结构破损（列表/引用上下文、表格被压进 76 列、窄屏哨兵折行泄漏、语法高亮丢失）——F/G 改用顶层 AST token
4. 命令体用 `text` 与 R2 自相矛盾、亮绿 `✓` 是新的噪点——C/D 已按评审修正（HTML 稿 v2）
5. 回放态没有逐段思考计时——A 增加回退文案
6. 左轴方案（gutter vs 单轴）与 `paddingX` 对称扣除的窄屏浪费——J 改为待拍板

进实现前的 pre-flight checklist（评审 §四）：左轴拍板 → 工具行/成功标记配色拍板 → 非 bash 工具与回放态规格 → 去空行的实现点与鼠标补偿 → Markdown 分段与围栏方案。

### 7.2 布局审美评审（2026-10-21 · gemini-4-argon 多模态看截图，全文：[notes/review-transcript-layout-aesthetics-argon.md](notes/review-transcript-layout-aesthetics-argon.md)）

总评：现状"野生 CLI（3/10）"→ 新设计"有克制的开发工具（6.5/10）"，离 Linear/Raycast 级还差三步。**已落地进原型 v3**（HTML 稿即是）：

1. **代码块容器感**：第 3 列加极暗竖轨 `│`（`borderMuted`），代码从第 5 列起；`text`/`txt`/`plain`/无语言**不印标签**（零信息量）；无高亮代码块从亮青 `#89ddff` 降为冷灰白 `#b8c0cc`（整块青色会在深底上糊成光斑）
2. **gutter 单图标**：bash 让琥珀色 `$` 直接占标记位（`◆ $` 四列内两个彩色符号太啰嗦）；`◆` 只留给文件类工具
3. **成功不邀功**：常态成功连 `✓` 都省掉，只留暗色耗时（与命令主体间 2 列空格）；失败才 `✗ exit N` 红字
4. **`∴` 只作正文眉题**：纯"思考+工具"的步骤不印 `∴` 行（耗时在 `Worked for` 汇总），避免一屏 7 个 `∴` 把叙事切碎
5. **`Worked for` 加收尾感**：`─ Worked for 3m7s`

**评审误读已核实排除**：嵌套列表悬挂缩进实际是齐的、`…` 本来就是暗色、write 的 `·` 本来就有。

**留给你拍板的审美分叉**：

- **宽终端版心**：正文限宽后，工具行仍冲到 110+ 列，右边缘"撕裂"。方案：宽屏（>120 列）时整个内容列（正文+工具+用户消息）统一收进 ~86 列版心并整体离开左墙（浮在画布中）；代价是长命令截断更狠。或者保持现状：工具行全宽、左对齐。
- **用户消息条**：灰底条宽度跟正文版心对齐（时间戳钉在 76 列右缘）vs 保持通栏；`❯` 提亮。
- **`∴` 字形**：`∴` vs 无符号的斜体暗字 `thought 11s`（`∴` 三个点重心偏下，与 `◆` 相邻时视觉重量差太大）。
- **加粗纪律**：列表项内的加粗词和段落小标题都是纯白粗体，贴在一起时糊成白斑——建议只有段落小标题用 Bold+纯白，列表内加粗降为普通字重亮白。

### 7.3 左缘结构语言（2026-10-21 · 用户反馈「都是矩形」→ 两个结构化变体，HTML 稿第四节）

用户反馈：左边缘一列相同的 ◆ 叠成"矩形串"，没有结构；提议用简约结构（T 字形）或基于内置 ascii-art 动效区分 thinking 与工具。两个变体均已实现进原型（真实渲染，见 HTML 稿第四节）：

- **V-S 回合脊柱（推荐）**：一个回合 = 一条贯穿的 `borderMuted` 脊柱；正文/思考在主干，工具是 `├─` 分支，失败红色分支，`╰─ Worked for` 收口。关键洞察：**M4 流光轨就是这条脊柱的活体形态**——回合进行中脊柱脉冲、完成后沉淀为静态结构，动效从装饰层升级为骨架的生命体征。
- **V-T T 字分型（轻量备选）**：不画连续脊柱，T 字朝向表义——思考 `┬`（向下展开）、工具 `├`（向右分支）、失败 `┤`（回流）、收尾 `┴`（闭合）。

动画分镜「一个回合的一生」：HTML 稿第四节的 85 帧循环动画，每一帧都是 `motion.ts`（railGlyph 脉冲 / breathe 呼吸）与 `flash.ts`（M6 衰减公式）的真实执行——思考呼吸 → 思考完成绿闪 → 正文落版 → 分支亮起 → 工具完成绿闪 + 耗时浮现 → 脊柱沉淀、`╰─` 收口。播放器是 HTML 里 20 行 `setInterval` 换帧，帧内容全部离线真实渲染。

待拍板：V-S 还是 V-T（或保持 v3 纯字形）。V-S 的实现注意：脊柱行属于回合级容器，要处理欢迎页/通知/错误等非回合行的排除，以及与 `group.ts` 只读工具合并行（`◈`）的衔接。
