# 对话区密度：从「两态」到「三态」

日期：2026-10-29。状态：**决策已定（2a）**，未改 `src/`。

起因：用户在 230 列终端里看一轮 5 条 bash 的会话，判断「特别的乱，除了没有颜色区分以外，这种大段的片段感觉有问题」。前一轮色彩提案（[notes/research-tui-visual-style.md](notes/research-tui-visual-style.md)）和三个排版提案（A 限宽 / B 归组 / C 摘要）都被否掉——理由是**它们都在优化"展开之后"的形态**。

## 1. 真正的病因：Epi 只有两态

`Ctrl+O` 是全局开关（`app.ts:391-393` → `transcript.setToolsExpanded`），一按下去**整条对话**所有工具调用同时展开（`transcript.ts:403,463`）。所以：

- 全折叠：看不到任何输出
- 全展开：一屏 25 行灰墙（实测：230 列、5 条 bash、丢 104 列字符、`common.ts:87` 还会把输出掐成「前 2 + `… +N` + 后 3」）

**全展开是一个没有设计的中间态**：既不是默认阅读视图，也不是"我要细看这一块"的详情视图。

## 2. 参照实现（repo 已有调研）

`notes/research-grok-build-tui.md` §4.4：grok 用 `DisplayMode::{Collapsed, Truncated, Expanded}` 三态，**按工具类型定默认**，并且**逐块**手动折叠的状态会被记住。

| 工具 | grok 默认 | 结束态 |
|---|---|---|
| agent 执行的 bash | 折叠（只显示标题） | 保持折叠 |
| 用户 `!` bash | Truncated：前 2 + `… +N` + 后 3 | 展开 |
| Read | — | 折叠 |
| Web / MCP | 最多 10 行 | — |

所以 grok 里「5 条 bash」= **5 行**，要看输出就点开**那一个块**。

## 3. 四步落地（按顺序，每步独立可验证）

### 第 1 步 · 默认态钉死

一轮 5 条命令 = 5 行。成功态 bash 已经不画输出行（`mutating.ts`），要保证的是**别让全展开污染它**——即第 2 步先落地。

不变量：`test/model-snapshot.test.mjs` 无差异（纯渲染层）。

### 第 2 步 · Ctrl+O 不再一刀切（**待用户选**）

三个变体：

| 变体 | 行为 | 代价 |
|---|---|---|
| **2a 只展开最近一块** | Ctrl+O 切最后一个工具块的展开态；其他块不变 | 想把 3 块前的内容摊开要点 3 次；但这是逐块语义，和 grok 一致 |
| **2b 只展开光标/鼠标选中的块** | 需要块级选中状态，键盘要加导航 | 最接近 grok，但改动最大（新增选中态 + 焦点 + 鼠标契约） |
| **2c 保留全展开，另加逐块** | Ctrl+O 仍是全开；新增 Enter/点击逐块 | 最保守，不改现有行为；但"乱"的输入路径没关掉，只是多了一条出路 |

Epi 已经有逐块查看能力：点击/Enter 打开 inspector（`block.ts:60` 的 `InspectTarget`）。2b 本质上是把这个能力提到 Ctrl+O。

**已选 2a**（用户确认 2026-10-29）：改动最小（只动 expand 的目标集合，不动选中/焦点），语义和 grok 一致，一步就把"一屏灰墙"关掉。

2a 的落地要点：`transcript.setToolsExpanded(boolean)` 目前把布尔值发给所有块（`transcript.ts:403,463`）。改成"只让最后一个工具块接收展开态"，其余块保持当前值。需要处理：① 块是流式追加的，"最后一块"要在每帧重新计算；② 全展开还有第二条入口（用户消息块的折叠，`transcript.ts:463` 同一处），要确认不误伤；③ `getToolsExpanded()`（`app.ts:390`）的返回值语义要重新定义——不再代表"所有块"，footer 的 `Ctrl+o:expand` 标签也要跟着改。

### 第 3 步 · 正文限宽

`measure.ts` 恢复有限值只对 `DEFAULT_MEASURE`（正文与叙述性工具输出），**`TURN_COLUMNS` 保持 `Infinity`**——它管的是用户消息色块和状态行，是 chrome 不是散文。

注意：`tools/common.ts:54,147` 用的是 `truncateToWidth`（**截**），不是折行。只改常量会让工具输出在 110 列处被切、右边留空 120 列，可能更难看。所以这一步必须同时把这两处改成折行，否则不要动。

代码块、表格、diff 不受限（折行会破坏对齐）。

### 第 4 步 · 颜色分色

`notes/research-tui-visual-style.md` 的 P1/P2。放最后：前三步做完，灰墙已经不存在，分色只是锦上添花。

## 4. 为什么不做 A/B/C

三个提案都在回答"展开后怎么排得好看"。实测数据（`reports/layout-density-probe.html`）：

| 方案 | 行数（230 列） | 丢失列 |
|---|---|---|
| 现状（展开态） | 25 | 104 |
| A 限宽 | 43 | 0 |
| B 限宽 + 归组 | 22 | 0 |
| C B + 摘要 | 8 | 0 |

A 用行数换不丢字（比现状更占屏）；C 的摘要是**按工具名启发式编的**（`2 endpoints · 200`），换一个命令就编错，等于对用户撒谎。都不用。

B 的思路（归组）保留，但落到第 1 步的默认态里，而不是靠外面再包一层。

## 5. 未验证

- 三个 Ctrl+O 变体都还没实测，用户选定后要先做交互探针。
- 第 3 步的折行改动会不会影响 inspector 的行号映射，未查。
- 恢复限宽会不会让已有的 `visibleWidth ≤ width` 测试（40/80/120/230 列）失效，未跑。

## 6. 现有证据

- `scripts/probes/layout-density-probe.mjs` → `reports/layout-density-probe.html`（现状帧由 dist 真实组件渲染；A/B/C 三档可 `--print=` 直看）
- `scripts/probes/theme-color-probe.mjs` → `reports/theme-color-probe.html`（色彩 P1/P2/P3）
- `scripts/probes/double-chin-probe.mjs`（底部 chrome 重复，已开 issue #9，与本设计无关）
