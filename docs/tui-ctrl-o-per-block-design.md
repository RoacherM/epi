# 设计稿：Ctrl+O 逐块展开（决策 2a）

日期：2026-10-29。状态：§2a 已认可；§9 按原型 v3 改写，**待用户认可**，`src/` 零改动。实现交给 `devin/claude-opus-5-5`。

上位文档：[tui-density-ux-design.md](tui-density-ux-design.md)（四步计划，本文是第 2 步的施工图）。

## 1. 目标

把 `Ctrl+O` 从「整条对话全展开」改成「只展开/收起最近一个工具块」。

一句话验收：**一轮 5 条 bash，屏幕上一行一个动作；按一次 Ctrl+O，只有最后那块长出输出。**

不变量（每条都要有测试守着）：

1. 纯渲染层：模型收到的内容零变化，`test/model-snapshot.test.mjs` 无差异。
2. **扩展 API 不变**：`pi.ui.setToolsExpanded(boolean)` 仍是"全展开/全收起"，`getToolsExpanded()` 仍代表"所有块都展开"。理由见 §3。
3. 宽度安全：40/80/120/230 列下每行 `visibleWidth ≤ width`。
4. 鼠标契约不回归：点击工具块展开/inspector 的坐标与行为不变。

## 2. 现状（代码事实）

| 位置 | 现在做什么 |
|---|---|
| `src/tui/app.ts:121` | `let toolsExpanded = false` — 一个全局布尔 |
| `src/tui/app.ts:390` | `getToolsExpanded: () => toolsExpanded` |
| `src/tui/app.ts:391-393` | `setToolsExpanded(expanded)` → 改全局布尔 + `transcript.setToolsExpanded(expanded)` |
| `src/tui/app.ts:445` | `toggleToolsExpanded: () => surface.setToolsExpanded(!toolsExpanded)` ← **Ctrl+O 走这里** |
| `src/tui/transcript.ts:56` | `private toolsExpanded = false` |
| `src/tui/transcript.ts:173-179` | `setToolsExpanded()` → 存布尔 + `groupedMessages.setToolsExpanded()` |
| `src/tui/transcript.ts:403` | 渲染工具块时 `block.setExpanded(this.toolsExpanded)` |
| `src/tui/transcript.ts:463` | 渲染用户消息块时 `component.setExpanded(this.toolsExpanded)` ← 同一个布尔 |
| `src/tui/tools/group.ts` | 只读工具已归组；`expanded` 决定是否摊开成员 |

关键：一个布尔同时驱动**所有工具块**和**所有用户消息块**。

## 3. 为什么保留全展开 API

`setToolsExpanded` 是 Pi 的扩展接口之一（`docs/tui-design.md` 的 28+1 个 UI 方法）。改它的语义会让现有扩展静默失效——它们调 `setToolsExpanded(true)` 是想"全摊开看日志"。

所以：

- **`setToolsExpanded` / `getToolsExpanded` 语义不动**（全展开，扩展可用）。
- **Ctrl+O 不再调 `toggleToolsExpanded`**，改调新的逐块方法。

这样改动面最小，且不需要新增 Pi 接口（内部方法即可）。

## 4. 新语义

### 4.1 数据结构

`transcript.ts` 增加一个**已展开块的集合**，按消息 id 记：

```ts
/** 逐块展开的消息 id。Ctrl+O 只增删最近一个；全展开（扩展 API）仍是独立开关。 */
private expandedBlocks = new Set<string>();
```

渲染时每块的有效展开态：

```ts
const expanded = this.toolsExpanded || this.expandedBlocks.has(message.id);
```

（`this.toolsExpanded` 是扩展的全展开；两者取或。）

### 4.2 Ctrl+O 的行为

```
toggleLastToolBlock():
  1. 找到"最近一个工具块"
  2. 没有 → 返回 false（调用方闪一句提示，见 §4.5）
  3. 有 → 若它已在 expandedBlocks 里则删掉，否则加入；返回 true
```

「最近一个工具块」的判定，按优先级：

1. 最后一个 **toolResult / toolCall 消息**所在的块
2. 如果它属于一个只读工具组（`◈ Read 3 files`），目标是**整个组**——组在屏上只占一行，只展开其中一个成员没有意义
3. 用户消息块不在 Ctrl+O 的范围内（它的折叠改由第 3 步之外的单独入口处理；本期不动它，保持现状——受 `toolsExpanded` 影响）

### 4.3 状态生命周期

| 事件 | 行为 |
|---|---|
| 新工具块到达 | 新块默认收起；`expandedBlocks` 里旧项**保留**（不自动收） |
| 切换会话 `/new`、`/resume`、`/fork`、`/reload` | `expandedBlocks.clear()`（和 `toolsExpanded` 的既有清理一致） |
| 扩展调 `setToolsExpanded(true)` | 所有块展开；`expandedBlocks` 不清空（退出全展开后逐块状态还在） |
| 扩展调 `setToolsExpanded(false)` | 只有 `expandedBlocks` 里的块还展开 |

### 4.4 边界情况

| 情况 | 期望 |
|---|---|
| 会话里没有任何工具块 | Ctrl+O 无动作，flash 一句 `No tool output to expand`（唯一的提示文案） |
| 最后一块是失败的 bash | 照常展开（失败块本来就有结果行） |
| 最后一块是 `bash` 且成功、输出为空 | 照常展开，视觉上无变化（可选：flash `Nothing to show`） |
| 连续按两次 | 第二次收起同一块 |
| 最后一块属于只读组 | 展开整个组（`group.ts` 的 `unfolded`/`revealed`），收起时回到 `◈ Read 3 files` 一行 |
| 展开后又有新工具到达，再按一次 | 目标是**新的最后一块**，不是刚才那块 |

### 4.5 footer 文案（**需用户确认**）

现状是 `Ctrl+o:expand`。改成逐块后有两种写法：

| 选项 | 文案 | 说明 |
|---|---|---|
| **A** | `Ctrl+o:last` | 明确是"最后一个"，但 `last` 单看含义不清 |
| **B** | `Ctrl+o:expand` 不变 | 最小改动，靠一次 flash 教会用户 |

**已定 B（2026-10-29）**：footer 保持 `Ctrl+o:expand` 不变。语义就是"展开最近一次的输出"；会话里没有工具块时 flash `No tool output to expand`（§4.4）。

## 5. 施工清单（给实现者）

1. `src/tui/transcript.ts`
   - 加 `expandedBlocks: Set<string>`
   - 加 `toggleLastToolBlock(): boolean`
   - `:403` / `:463` 的有效展开态改成 `this.toolsExpanded || this.expandedBlocks.has(id)`
   - 清理路径（`clear`/会话切换）加 `expandedBlocks.clear()`
2. `src/tui/app.ts`
   - `:445` 的 `toggleToolsExpanded` 改成调 `transcript.toggleLastToolBlock()`；返回 false 时 flash
   - `:232-233` footer 文案
3. 不动 `setToolsExpanded` / `getToolsExpanded`。

## 6. 测试

| # | 场景 | 断言 |
|---|---|---|
| 1 | 一轮 5 条 bash，默认 | 屏幕只有 5 行命令，无输出行 |
| 2 | 按一次 Ctrl+O | 只有最后一块出现输出行；前 4 块行数不变 |
| 3 | 连按两次 | 回到第 1 条的形态 |
| 4 | 无工具块时按 Ctrl+O | flash 提示；屏幕不变 |
| 5 | 最后一块在只读组里 | 组摊开成成员行；再按收回归组 |
| 6 | 扩展调 `setToolsExpanded(true)` | 全部展开（回归，证明 API 未破） |
| 7 | 展开后新工具到达，再按 Ctrl+O | 目标是新块；旧块保持展开 |
| 8 | `model-snapshot` | 无差异 |
| 9 | 40/80/120/230 列 | 每行 `visibleWidth ≤ width` |

测试文件：`test/tui-keys.test.mjs`（交互）+ `test/tui-transcript-layout` 相关（渲染）。用 harness 的 `["screen", name]` 看当前屏幕，不要用输出流（`docs/dev-workflow.md` D13）。

## 7. 不在本期范围

- 正文限宽（四步计划的第 3 步）——必须连折行改造一起做。
- 颜色分色（第 4 步）。
- 用户消息块的逐块展开（`transcript.ts:463` 那处继续保持跟 `toolsExpanded` 走）。
- 用 ↑↓ 在块间导航后按 Ctrl+O（那属于变体 2b）。

## 8. 待用户认可的两个点

1. ~~§4.5 footer 文案~~ **已定 B**：保持 `Ctrl+o:expand`。
2. ~~§4.3 新块到达时旧块不收~~ **已确认（2026-10-29）**：不自动收。用户主动展开的东西不被悄悄关掉。

## 9. 追加需求（2026-10-29 用户新提，同批实现）

同一次判断里用户还提了两件视觉问题，和 2a 一起交付。两项都**不在** 2a 的原有范围，但都属于"让一个回合读起来安静"。

唯一准绳：原型 `scripts/probes/ctrl-o-carriage-prototype.html`（v3）。动画和四个关键帧由同一个渲染函数画出；本节和原型冲突时以原型为准。

### 9.1 运行中的一片与字车

**用户判断**：要「上下移动的感觉」。不换行就停在原行；一换行、输出一大片，就往下走；默认折叠，所以结束后又回来。

**规则**：

| 元素 | 规格 |
|---|---|
| 运行中的一片 | 工具运行时，输出实时摊开在调用行下面，最多 **5 行**；超过时窗口内上滚，只留最新 5 行。工具结束，这一片**立刻折叠**回一行（失败的留一行 `✗`）。调用行 + 5 行 ≤ `TIP_ROWS = 8`，整片都在动画区内 |
| 字车 `┃` | 画在 spine 列（第 2 列），`accent` 色的粗竖线 `┃`；落在调用行时用 `┝`（保留分支的 `─`）。和上下的 `│` 同一列、同一中线，连成细长的一条，不用实心方块 `█`（用户：太粗）。停在**正在写的那一行**：模型流式输出时在当前正文行；工具运行时在这一片的最后一行，还没有输出时在调用行 |
| 移动 | 不换行就不动；每换一行下移一行；窗口满 5 行后停在底行，内容在它上方滚动（纸在走，字车不动）；这一片折叠后，字车跳回上方的下一个写入位置。离散跳，不做插值 |
| spine | 只用结构色 `borderMuted`。删掉 `railBlend` 光带（`spine.ts:159`）和思考行的 `breathe` 呼吸。全屏只有字车和运行中工具的 `+/×` 在动 |

**现状差量**：bash 运行时显示最后 3 行、成功后不占行，这个机制已经有了（`tools/mutating.ts:341`，`bash-block.ts:146`）。要做的只有：3 行改 5 行；其他会产出输出的工具接入同一机制（实现者先列出哪些工具有部分结果）；用字车替换光带。

**不变量**：
- 字车永远在 spine 尖端（最后 `TIP_ROWS` 行）里，所以不会改到滚出屏幕的行，不触发整屏重绘。
- 只在可见/活跃时 tick（`clearInterval` + `unref()`，`docs/tui-motion-design.md`）。
- 关掉动效（非 TTY、`NO_COLOR`）时，字车静止画在写入位置，不消失，行宽不跳。

### 9.2 右侧时间：折叠是进度条，展开是数字

| 规则 | 内容 |
|---|---|
| 折叠 | 只画 **4 格对数进度条**，不画数字。沿用现有 `durationBar`（`common.ts:120`：每格一个数量级，10ms→100s，细到 1/8 格）。运行中实时增长 |
| 展开（Ctrl+O） | 同一位置换成数字（`formatToolDuration`），右对齐，不再画进度条 |
| 位置 | **贴终端右边缘**，随窗口宽度动态变化，和顶栏、底栏的右缘是同一条线。现状已经如此（`DEFAULT_MEASURE = ∞`，`fitCallRow` 把条放在 `width − 4`，`common.ts:147`），不改 |
| 要删的 | 折叠时 ≥100s 在条后追加的数字（`common.ts:127`）；展开时「条 + 数字」并排（`common.ts:202`）。改为二选一 |
| 颜色 | 进度条保持 `dim` 填充 + `borderMuted` 空格。不按单位分色，不用 `warning` |
| 窄终端 | 整行宽度 < `MIN_COLUMN_FOR_BAR`（16）时沿用现有回退：时间作为数字跟在正文后 |

**为什么是对数条，不是 v2 的「按单位分色方块」**：v2 的格数和颜色用同一组阈值，两个通道表达同一件事；而且 2m34s 和 13m19s 画出来一样。对数条每格一个数量级，细到 1/8 格，同样 4 列宽，信息更多。

**测试补充**（接 §6）：
| # | 场景 | 断言 |
|---|---|---|
| 10 | bash 运行中输出 12 行 | 调用行下最多 5 行，是最新 5 行；字车在第 5 行 |
| 11 | 该 bash 成功结束 | 只剩调用行；字车离开该块 |
| 12 | 折叠的调用行 | 右侧只有 4 格条，无数字；条的末格在第 `width` 列 |
| 13 | Ctrl+O 展开后 | 右侧只有数字，末位在第 `width` 列 |
| 14 | 窗口 80 → 120 列 | 条跟着右缘移动 |
| 15 | spine 渲染 | 运行中最多一格 accent `┃`/`┝`（字车）；无 `railBlend` 渐变色；结束后无 `┃` |

### 9.3 交付顺序

1. 2a（Ctrl+O 逐块）
2. 9.1（运行中的一片 + 字车）
3. 9.2（右侧时间）
4. 正文限宽 + 颜色分色（原四步计划的第 3、4 步）

每步独立可验证，不合并提交。
