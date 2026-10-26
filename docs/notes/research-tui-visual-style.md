# TUI 视觉风格调研与「双下巴」排查

日期：2026-10-29。只读调研 + 新增两个探针，未改任何产品代码（`src/` 零改动）。

用户报了两件事：
1. 对话区「没颜色的区分」——整屏灰，不优雅。
2. 底部状态栏画了两行（「双下巴」）。

本文记录两项调查的证据、结论、以及未验证的部分。两个可执行探针：

```sh
node scripts/probes/theme-color-probe.mjs        # → reports/theme-color-probe.html
node scripts/probes/double-chin-probe.mjs        # 场景矩阵 + 真实抓包回放
```

## 0. 术语

| 词 | 意思 |
|---|---|
| 墨量 | 一行字符的视觉重量，终端里只能靠亮度对比和字重调节（没有字号） |
| 色相 | 颜色的种类（红/蓝/紫…），与明暗无关。灰阶没有色相 |
| chrome 行 | 常驻界面的框架行：顶栏、回合状态行、输入框、快捷键条。（chrome 原指浏览器界面里除网页内容外的部分） |
| spine | 一个回合左侧那条贯穿的竖线，`src/tui/spine.ts` 画 |
| token | Pi 主题里的一个颜色槽位名，如 `toolOutput` |
| 抓包 | 用 `PI_TUI_WRITE_LOG` 把程序写向终端的原始字节存成文件 |

## 1. 现状：颜色从哪来

所有颜色来自 `src/tui/theme.ts` 的两张表（`NIGHT_FG`/`NIGHT_BG`、`DAY_FG`/`DAY_BG`），它们是把 grok-build 的调色板映射到 Pi 的 51 个主题 token 上；映射依据见 [tui-theme.md](../tui-theme.md)。

读整个 `NIGHT_FG`，前景色全部落在 `#323237`–`#e1e1e1` 这一条灰带上：

| token | 值 | 用途 |
|---|---|---|
| `text` | `#e1e1e1` | 正文、`toolTitle` |
| `toolOutput` | `#c8c8c8` | **所有**工具调用的命令和输出 |
| `muted` | `#6c6c6c` | 次要信息、标记、边框标签 |
| `dim` | `#585858` | 最弱信息、耗时 |
| `borderMuted` | `#323237` | spine、代码块竖轨 |

色相只出现在四处：`accent #bb9af7`（紫，运行动画）、`bashMode #e0af68`（琥珀，`$` 标记）、`success #9ece6a`（绿，只给 diff 新增）、`error #f7768e`（红，只给失败）。

所以一个**只有成功的 bash/read/grep、没有 diff、没有失败**的回合，屏幕上没有一个有色相的像素。用户截图正是这种回合。

## 2. 诊断：为什么读起来是灰墙

四条，按影响排序：

**① 工具类型不区分颜色。** `theme.ts:26` 的 `toolOutput` 一个灰色同时喂给 bash 命令、`edit`/`write` 路径、`grep` 结果、`read` 内容。加上标记符几乎都是 `◆`（`tools/block.ts` 的 `paintMarker`），连续十几条调用在左列叠成一串同样的菱形，眼睛无法按类型扫读。

**② 成功不留痕。** `tools/mutating.ts:347-349` 明确写着成功不占行（设计文档 [tui-transcript-layout-design.md](../tui-transcript-layout-design.md) R4 的决定）。结果是成功的 bash 调用只有一行命令 + 一个 4 格暗色耗时条；失败才是红色的 `✗`。视觉上成功与「什么都没发生」无法区分。

**③ spine 太暗。** `spine.ts:159` 用 `borderMuted #323237` 画贯穿回合的竖线。在 `#1c1c1c` 附近的深背景上，这条线本该标出回合边界，实际几乎看不见，结构感丢失。

**④ 用户消息块与背景太近。** `chrome.ts` 的 `UserMessageBlock` 用 `userMessageBg #242424` 铺满整行。它和终端的深背景只差约 8 个亮度单位，在长对话里很难一眼定位自己说过什么。

## 3. 可改动空间

全部是**渲染层**改动，模型收到的内容一个字节都不变（`model-snapshot` 测试应无差异）。三个提案，改动量递增：

| 提案 | 内容 | 改动位置 | 估计 |
|---|---|---|---|
| P1 标记分色 | 只把标记符按工具类型上色：shell 琥珀 `$`、file 蓝 `◆`、read/search 青 `◇`、task 紫 `◈` | `tools/block.ts` 的选色 | ~20 行 |
| P2 标记 + 动词分色 | P1 加上动词名同色（`read`/`edit`/`grep` 字样本身着色） | 加 `tools/common.ts` 的 `CallLine` | ~40 行 |
| P3 完整 | P2 + spine 分支按类型着色 + 成功行 `✓` + 提亮 `borderMuted` + `╰─ Worked for` 收尾 | `spine.ts`、`tools/mutating.ts`、`theme.ts` | ~100 行 |

用到的都是**现有 token**（`bashMode`/`syntaxFunction`/`mdLink`/`accent`/`success`），不需要改 Pi 的主题 schema，也不需要新增 token。

**为什么不直接改主题值而改渲染选色**：主题 token 是全局的，改 `toolOutput` 会让所有工具输出一起变色，仍然不区分类型；按类型选色必须发生在渲染层，因为只有那里知道工具名。

### 3.1 探针

`scripts/probes/theme-color-probe.mjs` 渲染四帧同一个真实会话（`scripts/probes/fixtures/transcript-layout-session.json`，0.1.21 发布当天的 session 切片）：

- **现状**：由 `dist/` 里的真实组件（`AssistantBlock`/`UserMessageBlock`/`toolBlock` + 内置渲染器）渲染，不是手绘。
- **P1/P2/P3**：文件内自带的渲染器，同一份数据。

另有一节「工具行孤立对比」：11 种典型调用（bash 长/短命令、heredoc、read、edit、write、grep、find、task、失败 bash）在现状和提案下的单行对比。

产出 `reports/theme-color-probe.html`，ANSI → HTML 转换成网页，颜色是主题真值。**未做真人审美验收**：提案是否真的更好看，需要你看页面判断，本文只能证明「区分度提升了」。

## 4. 双下巴：排查结果

**结论：本地 7 个场景全部无法复现。** 下面是排除过程，以及给你在自己终端抓现场的工具。

### 4.1 排除的嫌疑

| 嫌疑 | 结论 | 证据 |
|---|---|---|
| `editorSlot` 里有两个 `PromptFrame` | 排除 | `app.ts:332-341` 的 `takeEditorSlot` 先 `clear()` 再 `addChild()`；`Container.clear()` 是 `children = []`（pi-tui `tui.js:108`），重复添加只会剩一个 |
| 布局里 footer 有两个 | 排除 | `app.ts:250-265` 的 VStack 只有一处 `footerSlot`；`shortcutsBar` 返回单行（`chrome.ts` 的 `line()` 包装） |
| `PromptFrame.render` 画了两条下边框 | 排除 | 该函数只 `push` 一次带标签下边框；`lines.slice(bottom+1)` 追加的是编辑器 autocomplete 行，不带标签 |
| 渲染器漏清行 | 排除 | pi-tui `tui-alt-screen.js` 的 `doRender()` 写每行前发 `\x1b[2K`；宽度/高度变化走 `fullRedraw` → `\x1b[2J` |
| 布局溢出把内容挤到 footer 下面 | 排除 | 同文件的 `if (screen.length > height) screen = screen.slice(screen.length - height)` 是裁掉**顶部**，不是留下尾部 |
| 编辑器内容跑到框外 | 排除 | `chrome.ts:488-489`，`maxContentRows` 为 `undefined` 时内容就是 `lines.slice(top+1, bottom)`，不产生额外行 |

### 4.2 环境证据

用户截图里两行状态栏的 token 数**不同**（`↑58.7m` vs `↑59.1m`），两行回合状态的耗时也不同（`1m40s` vs `2m9s`）。同一帧不可能画出两个不同时刻的值 → 这是**两帧的残留同时可见**，不是一次渲染画了两次。

这指向「某一帧变矮了，但腾出的行没清掉」。但 `doRender()` 在高度变化时会整屏清，所以还缺一个能触发它的条件。

另外：截图是窗口的**裁剪**（顶部残留 `Pasted Graphic 1.png` 标题，内容在图像底边被切断），所以「`for pat in` 在 footer 下面」不能当作证据——它可能只是裁剪边界。

### 4.3 多模型并行排查（第 2 轮）

用 4 个不同模型 + 4 个不同攻击角度跑同一份证据包（`.dev/chin/BRIEF.md`）：

| 模型 | 任务形态 | 结果 |
|---|---|---|
| `devin/swe-2-high-lightning` | 封闭机械：「枚举所有能改变渲染行数/行位置的路径」 | 有产出（见下） |
| `grok/grok-4.7` | 开放：「攻击这 6 条排除」 | 超时，58 轮、39 段推理无结论 |

**结论：任务形态比模型选择更决定结果。** 封闭、可核对的题一次就出活；开放的「找漏洞」题烧掉 15 分钟和 $2.42 后仍在探索。

`devin/swe-2-high-lightning` 给出的、我事后自己核对过的机制：

1. **`fullRedraw` 只由宽度/高度变化或前屏为空触发**（`tui-alt-screen.js:1373`），行数变化本身不触发，只做逐行 diff。
2. `layout.js` 的 `paintBox` 做 clip，`screen` 恒为 `safeHeight` 行。
3. `allocateStackSizes` → `distribute` 在 `candidates.length === 0` 时提前返回（`components/stack.js:66-67`），此时 sizes 总和可超过 contentSize，底部槽位落到 clip 之外被截断。
4. **`turnGap` 与 `turnStatus` 的可见条件不对称**：`turnGap` 只看 `turn === undefined`（`app.ts:243`），`turnStatus` 看 `turn === undefined || !workingVisible`（`app.ts:213`）。所以扩展调 `setWorking({visible:false})` 只减 1 行，不是 2 行。

第 3 条的可达版本已实测（100×17/18/20/24，同时有排队消息 + 多行草稿 + 流式）：**不复现**。

### 4.4 根因（已复现）：扩展文本带换行进单行组件

`app.ts:362-365` 的 `setStatus` 和 `app.ts:371-372` 的 `setWorking` 把扩展给的文本**原样存下**，过滤控制字符一个字都没有。而消费它们的地方都是单行组件：`shortcutsBar` 的右侧是 `[...statuses.values()].join(" · ")`，`TurnStatus` 的左侧是 `activity`，`PromptFrame` 的下边框标签是扩展可替换的 `statusLineFormatter` 的返回值。

一个 `\n` 进了行字符串，终端就把它当换行执行，该行剩下的部分画到下一行。Epi 进 alt screen 时发了 `\x1b[?7l` 关掉自动换行，所以这**不是**宽度溢出的换行，只可能来自字符串里的显式换行。

两种表现都实测复现了（夹具 `test/fixtures/faux-multiline-status.mjs`，命令 `/setmultiline`、`/setmultilinestatusline`）：

**① footer 右侧的 status 带换行** → footer 下面多出一行：

```
17 |  ╰────────────────────────────── nl-model (off) · ⇡0 ⇣0 ─╯
18 |  Shift+Tab:effort  │  …  /:comm… minilfs s-a92dd73a2f-24
19 |                                              locs/0            ← 凭空多出的一行
```

**② 输入框下边框的 statusLine 带换行** → 下边框被劈成两半，尾巴写进 footer 行，两个组件在同一行重叠：

```
17 |  ╰───────────── model-x (high) · ↑8.1m ⇣410k          ← 有头无尾
18 |  Shift+Tab:effort  │  …  /:commands      cache 86% ─╯  ← 尾巴压在快捷键上
```

第 ② 种正是用户第二张截图里 `Ctrl:o` 和 `expand` 叠在一起、以及第一张截图里出现两条带标签下边框的形状。

同文本的**单行** status 不触发（`/setstatusone` 场景通过），确认变量就是那个换行。

已开 issue：[RoacherM/epi#9](https://github.com/RoacherM/epi/issues/9)。

修法方向：在边界处剥掉控制字符——`setStatus`/`setWorking` 收进来时，或 `fit`/`spread` 这类只服务单行的辅助里统一做。两条都做最稳（外部扩展不可控）。

### 4.5 不能用「多模型投票」代替证据

没有模型能凭空造出复现。多模型给的是**假设的多样性**，不是真值。所以正确的分工是：模型产出「可证伪的假设 + 一个能跑的探针」，由机器判定哪个探针真跑出了重复行；而不是问 5 个模型然后相信多数票。

`scripts/probes/double-chin-probe.mjs`，两个模式。

### 4.6 探针

**模式 1 · 场景矩阵**（默认）。把真实 app 跑在 in-memory 终端里（复用 `test/fixtures/tui-harness.mjs` 的 `["screen", name]` 能力，它把 app 写的一切喂给 headless xterm，所以拿到的是**屏幕快照**而不是输出流——这一点关键，见 dogfood D13）。逐帧把底部行分类：

- `promptBottom`：带标签的下边框 `╰──── model · ⇡ ⇣ ────╯`
- `turnStatus`：`+ Running bash… 0.0s … [stop]`
- `footer`：`Esc:stop │ Ctrl+c:cancel │ …`
- `previewBottom` / `frameTop`：粘贴预览盒（合法地是第二个盒子，不参与重复判定）
- `contentBelowFooter`：footer 之后还有可见内容

断言前三种在同一帧最多出现一次。覆盖场景：空闲 120×30、17 行临界、流式中、多行草稿、长草稿压布局、排队消息、60 列窄屏。**当前全部通过。**

**模式 2 · 回放真实抓包**：

```sh
PI_TUI_WRITE_LOG=/tmp/epi-cap epi            # 复现问题后退出；值为目录时自动命名 tui-<时间>-<pid>.log
node scripts/probes/double-chin-probe.mjs --capture /tmp/epi-cap/tui-*.log --rows <你的行数>
```

按**字节**切 synchronized-output 帧（`\x1b[?2026h` … `\x1b[?2026l`），顺序喂给 headless xterm，逐帧跑同一套分类，报出第一帧出问题的帧序号和行号。

按字节切而不是按字符串：框线字符是多字节 UTF-8，用 latin1 解码会拆散字符、让 xterm 的列计数错位（第一版踩过，合成抓包显示乱码）。

有效性用一个植入重复的合成抓包验证过：能准确报出 `promptBottom @ rows 29,30`。抓包里没有可分析的帧时退出码 2，不当作「通过」。

## 5. 顺带发现的一个真 bug

终端 ≤12 行时（`chrome.ts:489` 的 `maxContentRows` 生效），`cropToCursor` 只保留**光标所在行**。以换行结尾的草稿（`…\ndone\n`）光标停在最后的空行，于是编辑器只显示一个空框，三四行内容一行都看不见。

复现：12 行终端里粘贴 `for pat in a b\n do echo $pat\ndone\n`，屏幕上只有 `│ ❯ … │`。

这是裁剪策略选错了锚点（该保证「有内容可见」而不是「光标行可见」），与双下巴无关，已记为 dogfood D92。

## 6. 未验证

- 双下巴的真实根因：**未找到**。需要 §4.3 模式 2 的抓包才能定位。
- 新终端（resize）路径：探针没有 resize 步骤，未覆盖。
- 真人在真实终端里的审美验收：颜色提案只证明了区分度，没证明好看。
- §4.4 的第二种表现（statusLine 带换行）是否就是用户第一张截图「两条带标签下边框」的完整解释：形状吻合，但截图里两条的 token 数不同（`↑58.7m` vs `↑59.1m`），说明还叠加了跨帧残留，未拆清。
- §4.3 里 devin 的 `distribute` 提前返回路径：只测了可达的一种输入组合，未证明不可达。
- 亮色主题（`epi-grok-day`）：`theme-color-probe.mjs` 只渲染了暗色。亮色下 `toolOutput #444444` 与背景 `#f0f0f0` 的对比度是 9:1，墨量阶梯的绝对值和暗色不同，提案需要单独调。
