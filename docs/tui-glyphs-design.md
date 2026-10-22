# 统一图标与状态动画设计

状态：**已确认**（2026-10-22）：模型用 `◇`；运行时匀速旋转，结束时抖两下再定格（§3）；底部状态行也换成旋转的 x（§7）。

来源：用户 2026-10-22：
- "我在想chatui界面的图标是不是可以和trace页面统一呢"
- "可以基于ascii-art的动画结合，即图标可以做成动画，但是可以简约一点，我比较喜欢类似 旋转的x，表示不同的状态，略带卡顿的那种特效"
- "模型的图标换成和 ◆ 成对的 ◇；我喜欢旋转的特效；我觉得平时就匀速转动，等快结束了抖动两下？但是可能不是特别好判断"

动效基础见 [tui-motion-design.md](tui-motion-design.md)（M4 流光轨、M5 呼吸、M6 完成闪烁），版式见 [tui-one-column-design.md](tui-one-column-design.md)。

## 1. 现状（对照过代码）

| 含义 | 对话区 | `/trace` |
|---|---|---|
| 用户 | `❯`（`chrome.ts`） | `»`（`trace/page.ts` 的 `KIND_GLYPH`） |
| 模型 | 无标记；思考是 `∴`（`assistant-block.ts`） | **`◆`** |
| 工具 | **`◆`**，shell 是 `$`（`tools/block.ts`） | `⚙` |
| 合并的工具 | `◈`（`tools/group.ts`） | — |
| 事件 | — | `·` |
| 运行中 | 标记变成 accent 色；`◈` 和 `∴` 呼吸 | 无 |
| 失败 | 标记变红，下一行 `✗ …` | 结果栏写失败 |

两个问题：

1. **同一个图标两种意思**：`◆` 在对话区表示工具，在 `/trace` 表示模型。
2. **`⚙` 宽度不可靠**：一些终端会把 U+2699 当成彩色 emoji 画成两格，表格就对不齐了。

## 2. 统一的图标表

新建 `src/tui/glyphs.ts`，对话区、`/trace`、合并行都从这里取，不再各写各的：

| 图标 | 含义 | 对话区 | `/trace` |
|---|---|---|---|
| `❯` | 用户消息 | 用户消息条 | 用户步骤 |
| `◇` | 模型：思考、回复（和工具的实心 `◆` 成对） | 思考行 | 模型步骤 |
| `$` | shell 命令（模型的 bash、你的 `!cmd`） | 调用行 | bash 步骤 |
| `◆` | 其他工具（read、edit、MCP 等） | 调用行 | 工具步骤 |
| `◈` | 合并的只读工具 | 合并行 | — |
| `·` | 事件（换模型、改思考强度） | — | 事件步骤 |

全部是单格宽字符（`+`、`×` 也是），不用 emoji。颜色沿用现有语义：shell 琥珀色、运行中 accent、失败红色、其余 muted。`/trace` 小地图上按类型区分的颜色保留，只换图标。

## 3. 状态动画：旋转的 x

一个工具从发起到结束，标记列（第 3 列）的图标按状态变化：

| 状态 | 图标 | 颜色 | 动画 |
|---|---|---|---|
| 等待（参数还在流式输出，或排队未开始） | `+` | dim | 不动 |
| 运行中 | `+` 和 `×` 交替：十字转 45° 就是 x | accent | **匀速转**：每 4 拍（320ms）转一格 |
| 落地 | `×` `+` `×` `+` | accent（失败时 error） | **抖两下**：每 1 拍换一帧，共 4 拍（320ms） |
| 成功 | 定格成它的类型图标（`$`、`◆`） | 原色 | 落地时同时有 0.1.21 的完成闪烁（M6） |
| 失败 | 停在红色 `×` | error | 不动 |

1 拍 = 80ms，是 Epi 现有的动画节拍（`chrome.ts` 的 `MOTION_TICK_MS`）。当前帧由时钟和状态决定，同一时刻重画的结果一样，测试可以逐拍断言。

**为什么在落地时抖，而不是「快结束时」抖**：一个工具什么时候结束，事先无法知道。用同一工具的历史耗时去估，误差很大：同一条 `npm test` 可以几秒，也可以几分钟，估错了就会在半路乱抖，反而误导。所以「抖两下」放在结束的那一刻：结果一到，先抖 320ms 再定格。看起来就是「转着转着，咔哒两下落定」，而且每次都准。

失败的样子就是「抖完停在红色 `×`」，形状本身就说明出错了，不只靠颜色。下一行 `✗ exit 1 · …` 不变。

**思考和合并行用同一套**：思考时标记列是旋转的 x，后面写 `Thinking…`；结束后抖两下，定格成 `◇ 1.2s`。合并行有成员运行时转，全部结束后抖两下，定格成 `◈`。整个界面只有一种「运行中」的样子。

同一回合里几个工具同时运行时，各自的相位错开 2 拍（按调用顺序），不会齐刷刷地同步跳。

原型：`scripts/probes/glyph-animation-prototype.mjs` 生成一段 6 秒的演示（思考、几个工具、一个失败），录屏在 `reports/glyph-prototype/glyphs.mp4`（GIF 同目录），生成命令见 §6。

### 3.2 约束

- **只在末端 8 行内动**：旋转的 x 和耗时条一样随时钟变化，同样受脊柱的末端限制（spine.ts 的 ClockGated）。它读的是同一个 `displayNow()`（`src/tui/clock.ts`），所以末端以外的调用行图标会自动停住，不需要另做处理。
- **只在运行时和落地的 320ms 里动**：之后没有任何动画，也就没有额外的重绘。落地抖动和完成闪烁一样，只在最新回合的末端里播放。
- **不改行数、不改宽度**：只换第 3 列的一个字符，点击和对齐都不受影响。
- **回放**（`/resume`）：没有运行中的工具，直接显示定格后的图标。
- **底部状态行**：盲文 spinner（`⠋⠙⠹…`）换成同一个旋转的 x（§7）。扩展用 `setWorkingIndicator` 给的帧照旧原样画。

## 4. `/trace` 的变化

```text
   3 —       ❯ user           Format token counts above 1M as M/B
   4 792ms   ◇ offline-demo   tool-only response · 1 call
   5 4ms     ◆ read           src/tui/chrome.ts
   9 698ms   $ bash           node test/run.mjs
  10 —       · model change   offline-demo
```

正在运行的步骤（实时打开 `/trace` 时）用同样的旋转 x；失败的步骤用红色 `×`。

## 5. 改动点与测试

| 文件 | 内容 |
|---|---|
| `src/tui/glyphs.ts`（新） | 图标表、旋转与落地的帧序列、`statusGlyph(kind, state, now, phase)` |
| `src/tui/tools/block.ts`、`tools/group.ts`、`bash-block.ts` | 标记列改用 `statusGlyph` |
| `src/tui/assistant-block.ts` | 思考行：运行时旋转的 x，结束后 `◇` |
| `src/extensions/trace/page.ts` | `KIND_GLYPH` 改用图标表；运行中、失败的步骤 |
| 测试 | 每个状态的图标与颜色；旋转在各拍上的帧；落地的 4 帧与之后定格（成功、失败）；多个工具的相位错开；末端外的调用行图标不随时钟变化；回放定格；`/trace` 的图标与对话区一致；`⚙` 不再出现；40/80/120 列宽度 |

模型看到的内容不变（`model-snapshot` 无差异）。

## 6. 原型的生成命令

```bash
node scripts/probes/glyph-animation-prototype.mjs reports/glyph-prototype/frames.json
python3 scripts/docs/render-terminal.py reports/glyph-prototype/png < reports/glyph-prototype/frames.json
ffmpeg -framerate 25 -i reports/glyph-prototype/png/frame-%04d.png -vf "scale=1200:-2,format=yuv420p" reports/glyph-prototype/glyphs.mp4
```

（渲染需要的字体和 Python 环境同 [assets/README.md](assets/README.md)。）

## 7. 底部状态行

换成旋转的 x：`+` 和 `×` 每 4 拍交替，accent 色，和调用行的运行中一样。用户 2026-10-22 说"我喜欢旋转的特效"，主控理解为同意建议，整个界面只有一种「运行中」的样子。理解有误可以改回。
