# 大块文本悬浮查看器与内置 Vim 式 Buffer 组件设计

日期：2026-10-20 起草；状态：**Stage 1 已实现**，分支 `feat/tui-motion-buffer-overlay`，实现与本文的差异见 §6；**编辑功能（Stage 2/3）不做**（2026-10-21 用户确认，§7）。现有模块与组合方式以 [tui-buffer-components.md](tui-buffer-components.md) 为准（原型与离线 Probe：`scripts/probes/block-overlay-prototype.mjs`）。
依据：
- 用户真实使用痛点与长期演进方向（2026-10-20）：
  1. **当下痛点**：消息流里的工具块（`read`、`bash`、`grep`、`find`、`ls`、`write`）哪怕在展开态（`Ctrl+O` 或点击分组展开）下仍然做了二次硬截断（例如 `read-only.ts:171-180` 只显示前 5 行 + `… N more lines` + 后 3 行），导致无法在 TUI 内看到完整内容。需要支持点击弹出**悬浮窗口（Floating Overlay）**查看全文。
  2. **长期终局方向**：「不是像 VSCode 内置一个 Copilot，而是 **Agent（Copilot）内置了编辑器的核心能力**」。我们不把外部 Vim 进程塞进终端，而是设计一套**操作习惯对齐 Vim、组件可复用的内置编辑器与审查底座（`BufferView`）**，最终在 Epi TUI 内部闭环完成代码阅读、大块输出检查、Code Review 批注与轻量代码编辑。
- 既有设计关联：[tui-design.md](tui-design.md)、[preview-design.md](preview-design.md)、[review-design.md](review-design.md)。

---

## 1. 核心理念：Agent-First 内生编辑器 vs. IDE 插件

| 维度 | 传统 IDE + Copilot（Editor-First） | Epi TUI 内生编辑器（Agent-First） |
|---|---|---|
| **主视图中心** | 文件树 + 多 Tab 代码编辑器，Agent 挤在侧边栏 | **会话与执行流（Transcript）是中心**，编辑器/查看器按需从上下文块直接唤起 |
| **唤起路径** | 手动去文件树找文件打开 | 在 Agent 刚读完的 `read` 块、报错的 `bash` 块、刚改完的 `edit` Diff 上**一键/单击原地浮出** |
| **选区与联动** | 复制粘贴到聊天框 | 在悬浮窗用 Vim `VISUAL` 模式（`v`/`V`）选中行 → 一键带行号锚点塞回输入框，或记为本地 Review 批注 |
| **手动修改** | 在另一个窗口改文件 | 用户在悬浮窗按 `i` 微调代码并 `:w` 保存，不离开 Epi。当前不与 Agent 通信（§7）：Agent 下次 `read` 时自然读到新内容 |

---

## 2. 可复用组件架构（`src/tui/buffer/`）

> 2026-10-21 起以 [tui-buffer-components.md](tui-buffer-components.md) 为准。下面是起草时的设想，与实现的差别：没有 `TextBuffer`（不做编辑）；`VimKeymap` 拆成 `MotionKeys`（只管移动，列表页也用）和 `TextNavigation`（动作 + `/` `n` `N` + `:N`，任何只读文本视图都能接）；`CommandLineBar` 没有单独成模块（就是 `LinePrompt` 加宿主画的底栏）；新增 `scrollbar.ts`（四处共用）。

起草时的设想：为了避免「大块文本悬浮窗」、「`/preview` 文件查看器（`view.ts`）」、「`/review` 连续审查页（`review-page.ts`）」各自重复造一套滚动、搜索和按键逻辑，将底层收敛为可复用组件。

## 3. 三阶段演进规划

### Stage 1（本次落地目标）：大块文本悬浮查看器（`BlockInspectorOverlay` + `NORMAL` 导航）
解决消息流二次截断看不到全文的痛点，同时把 `BufferViewport` + `VimKeymap (NORMAL / COMMAND)` 底座立住。

#### 3.1 哪些块支持唤起悬浮窗？
| 消息流块类型 | 代码位置 | 现有截断行为 | 悬浮窗展示的完整内容 |
|---|---|---|---|
| **`read` 工具块** | `src/tui/tools/read-only.ts` | 展开后仍截断为前 5 行 + `… N more lines` + 后 3 行 | 本次 `read` 返回的完整语法高亮代码，行号 Gutter 从 `args.offset ?? 1` 真实起始行号开始编号 |
| **`grep / find / ls` 工具块** | `src/tui/tools/read-only.ts` | 展开后 `firstTen()` 只显示前 10 行 + `… N more` | 完整匹配列表 / 文件列表，支持在悬浮窗内按 `/` 二次过滤高亮 |
| **`bash` 工具块 & 用户 `!cmd` 块** | `src/tui/tools/mutating.ts`<br>`src/tui/bash-block.ts` | 展开后 `truncateOutputLines()` 只显示前 2 行 + `… +N lines` + 后 3 行 | 完整 stdout/stderr 输出 + 退出码状态头 |
| **`write / edit` 工具块** | `src/tui/tools/mutating.ts` | `write` 只显示前 10 行；长 Diff 上下文受限 | 完整写入内容或完整 Unified Diff |
| **折叠的用户长消息 / Thinking 块** | `src/tui/chrome.ts`<br>`src/tui/assistant-block.ts` | 用户长粘贴折叠为 3 行 + `…` | 完整消息正文或完整 Thinking 推理过程 |

#### 3.2 唤起与关闭交互
1. **鼠标触发**：
   - 在已展开工具块的 **`… N more lines` 提示行**（或工具块正文区）**左键单击**，立即通过 `tui.showOverlay()` 弹出居中悬浮窗（宽 `88%`、最大高 `82%`，锚点 `center`）。
   - 未展开的只读工具分组（`◈ Read 4 files`）保持既有逻辑：**第一次点击展开分组**，**点击具体工具块的 `… N more lines` 弹出悬浮窗**，互不冲突。
2. **键盘与命令触发**：
   - 悬浮窗打开时独占焦点（`OverlayHandle`），底部快捷键栏自动跟随切换提示。
   - 按 `Esc`、`q` 或鼠标点击右上角 `[× Esc]` 关闭悬浮窗，焦点恢复到输入框。

#### 3.3 悬浮窗内部布局与 Vim `NORMAL` 键位（Stage 1）
```text
╭─ read src/trust-prompt.ts:1-100 (129 lines · TypeScript) ────────────── [× Esc] ─╮
│   1 │ // First-run "trust this project?" prompt (DEVELOPMENT.md 8.2).            ┃
│   2 │ // project .epi/epi.json is found and nothing has decided its trust yet,   ┃
│  10 │ export interface ShouldAskProjectTrustOptions {                            │
│  11 │   interactive: boolean;                                                    │
│ ... │ ...                                                                        │
╰─ NORMAL · L1–24/129 (18%) ────── j/k/Wheel scroll · / search · :line · w wrap ───╯
```

| 键位 / 操作 | 行为（对齐 Vim `NORMAL` 模式） |
|---|---|
| `j` / `↓`、`k` / `↑` | 向下 / 向上移动 1 行（支持数字前缀，如 `10j`、`5k`） |
| `Ctrl+d` / `PageDown` / `Space` | 向下翻半屏 / 一屏 |
| `Ctrl+u` / `PageUp` | 向上翻半屏 / 一屏 |
| `gg` / `Home`、`G` / `End` | 跳到首行 / 跳到末行（`120G` 跳到第 120 行） |
| `/` | 底栏进入 `/pattern` 搜索输入（复用 `preview/search.ts` 的 `Finder`），`Enter` 确认，`n` / `N` 跳下/上一个匹配 |
| `:` | 底栏进入 `:行号` 跳转输入（复用 `LinePrompt`） |
| `w` | 切换长行折行（`wrap: on/off`） |
| `y` | 复制当前全文（或 Stage 2 选区）到系统剪贴板并闪出提示 |
| 鼠标滚轮 (`wheel`) | 每次滚动 3 行 |
| `Esc` / `q` | 若正在 `/` 或 `:` 输入则退回 `NORMAL`；若已在 `NORMAL` 则关闭悬浮窗 |

---

### Stage 2（不做，2026-10-21）：`VISUAL` 选区 + 引用回填与 Review 批注
在 `BufferViewport` 中启用光标行与 `v` / `V` 行级选区：
1. **精准引用到对话（Send Selection to Prompt）**：
   - 在悬浮窗里用 `V` + `j/k`（或鼠标拖选）选中第 42–58 行 → 按 `Enter` 或 `p`：
   - 悬浮窗关闭，自动往底部输入框插入 `@src/trust-prompt.ts:42-58 `（若是 `bash` 输出则作为文本 Chip 插入），无需手敲文件路径和行号。
2. **原地写 Code Review 批注**：
   - 在悬浮窗或 `/review` 中选中行按 `c` → 弹出内联批注输入，直接写入 `ReviewNoteStore`（见 [review-design.md](review-design.md) §4）。

---

### Stage 3（不做，2026-10-21）：`INSERT` 编辑态 + Undo/Redo + `:w` 落盘
将文件类 `TextBuffer` 升级为可读写 Buffer：
1. **模态编辑原语**：
   - `i` / `a` / `o` / `O` 进入 `INSERT` 模式；`Esc` 退回 `NORMAL` 模式。
   - `NORMAL` 模式下支持高频修改操作符：`x`、`dd`、`yy`、`p`、`cw`、`u`（Undo）、`Ctrl+r`（Redo）。
2. **`:w` 落盘**：
   - 用户执行 `:w`（或 `:wq`）时，校验磁盘文件自打开以来是否被外部或后台任务并发修改（比对读入时的 SHA-256 摘要，防止静默覆盖）。
   - 不写 `ChangeLedger`、不通知 Agent（§7，2026-10-21 用户确认）。

---

## 4. Stage 1 状态清单（`dev-workflow.md §3` 要求）

| 状态 | 归属模块 | 新增/改动 | 读写与重置时机（启动 / 换会话 / `/new` / `/resume` / `/reload` / 退出） |
|---|---|---|---|
| `activeInspectorOverlay` | `src/tui/app.ts`（或 `transcript.ts`） | 新增：当前打开的悬浮窗 `OverlayHandle`（同一时刻最多 1 个） | 点击工具块或按快捷键时创建并 `showOverlay`；再点另一块时先 `.hide()` 旧实例再开新实例；`session_invalidate`（`/new`、`/resume`、`/reload`）及 `shutdown` 时强制 `.hide()` 清理 |
| `BufferViewportState` (`scrollTop`, `cursorRow`, `wrap`, `pendingCount`, `finder`, `prompt`) | `src/tui/buffer/viewport.ts` | 新增：每个悬浮窗实例私有状态 | 随每次打开悬浮窗新建实例（遵守 pi-tui `docs/tui.md` “每个交互新建组件实例”的规则），关闭即销毁，不跨次残留 |
| `ToolEntry` 完整结果引用 | `src/tui/tools/group.ts` & `block.ts` | 改动：保留工具结果的完整格式化行（供点击 `… N more lines` 时传给 `BlockInspectorOverlay`），消息流内 `render()` 仍只输出截断后的行 | 随 `Transcript.tools` 生命周期管理；`Transcript.reset()` 时一并清空 |

---

## 5. Stage 1 测试计划与实现拆分

### 5.1 测试要求
1. **`BufferViewport` 与 `VimKeymap` 单元测试（`test/tui-buffer-viewport.test.mjs`）**：
   - 覆盖 `40 / 80 / 120` 列宽下每行 `visibleWidth(line) <= width`；
   - 覆盖 `j/k`、`10j`、`gg`、`G`、`Ctrl+d/u`、鼠标 `wheel` 滚动边界（0 到 `maxScroll`）；
   - 覆盖 `/` 搜索过滤、`n/N` 跳转、`:行号` 跳转、`w` 折行切换；
   - 覆盖在 `/` 搜索输入态按 `Esc` 只退出搜索态、在 `NORMAL` 态按 `Esc` 才关闭悬浮窗的两级退出语义。
2. **Transcript 点击唤起集成测试（`test/tui-block-inspector.test.mjs`）**：
   - 对超过 8 行的 `read` 块、超过 5 行的 `bash` 块、超过 10 行的 `grep` 块，验证点击 `… N more lines` 弹出悬浮窗，且悬浮窗内能滚动读到被消息流省略的中间行；
   - 验证 `/new`、`/resume` 切换会话时自动关闭已打开的悬浮窗。
3. **模型可见内容零改动验证**：
   - `node scripts/model-snapshot.mjs --diff` 必须无差异。

### 5.2 任务拆分
- **Task 2A（`src/tui/buffer/` 可复用底座）**：抽离 `BufferViewport`、`VimKeymap (NORMAL + / + :)`，与 `src/extensions/preview/search.ts` 的 `Finder`/`LinePrompt` 对齐。
- **Task 2B（`BlockInspectorOverlay` 挂载与工具块点击打通）**：在 `src/tui/tools/read-only.ts`、`mutating.ts`、`block.ts`、`bash-block.ts` 中为截断行挂载点击回调，接入 `app.ts` 的 `tui.showOverlay`。

---

## 6. 实现记录（Stage 1，主控定）

| 项 | 实现 | 与上文的差异及理由 |
|---|---|---|
| `src/tui/buffer/` | Stage 1 交付时是 `search.ts`（由 `src/extensions/preview/search.ts` 移入）、`keymap.ts`（`VimKeymap`）、`viewport.ts`、`inspector.ts`；2026-10-21 拆分后的模块见 [tui-buffer-components.md](tui-buffer-components.md)（`keymap.ts` 已拆为 `motion-keys.ts` + `navigation.ts`，新增 `scrollbar.ts`） | `CommandLineBar` 没有单独成组件：底栏就是 `LinePrompt` + 宿主画的状态 |
| 可点击的行 | 展开后的 `read`（`… N more lines`）、`grep`/`find`/`ls`（`… N more`）、模型 `bash` 与用户 `!cmd`（`… +N lines`）、`write`（新增 `… N more lines` 行，原来静默截在 10 行）、`edit`（每个 `… N unchanged lines` 行，打开 Pi 返回的完整 diff，不加行号槽） | 只有这些行唤起悬浮窗；块内其他位置仍是 Pi 原有的点击展开/收起。折叠的用户长消息与 Thinking 没做（它们已有 Ctrl+O / Ctrl+T 展开全文） |
| 读取上限 | 悬浮窗显示的是这一次工具调用返回的内容。Pi 的 `read` 每次最多返回 2000 行或 50KB，超出时结果末尾带 `[Showing lines A-B of N … Use offset=… to continue.]`：这行不再作为带行号的"文件行"显示，而是变成标题里的 `lines 1–955 of 1098 · 50.0KB limit` | 不改模型可见的读取上限，也不从磁盘重读整个文件（文件可能已被改过，悬浮窗应和模型看到的一致）。剩下的部分在模型的下一次 `read`（`offset=…`）块里打开 |
| 键位 | 移动用共享动作键（§7.5）：`j/k/↑↓`（含计数）、`Ctrl+d/u`、`Space/PageDown/Ctrl+f`、`b/PageUp/Ctrl+b`、`gg/Home`、`G/End`、`NG`/`Ngg`；悬浮窗自己的：`/` + `n/N`（带 `[i/n]`）、`:N`、`w`、`y`（复制全文，失败显示原因）、`q`/`Esc` 关闭，滚轮 3 行，右上角 `[× Esc]` 点击关闭 | Esc 三级：先清未完成的计数/`g`，再退出 `/`、`:` 输入，最后关闭。`Enter` 不关闭（留给 Stage 2 发送选区），`h` 不绑定（留给 Stage 3 光标） |
| 状态 | `Transcript.inspector`（同一时刻最多 1 个，新开先关旧）；`reset()`（`/new`、`/resume`、`/reload`、`/tree`）与 `stopTui()` 关闭 | 归属放在 `transcript.ts` 而不是 `app.ts`：`reset()` 是所有换会话路径的汇合点 |
| 尺寸 | 宽 88%（最小 24 列）、居中；高度按内容收缩，最多终端高度的 82% | 由组件自己限制高度（不用 `maxHeight` 截断），保证底栏不被裁掉 |
| 测试 | `test/tui-buffer-viewport.test.mjs`、`test/tui-block-inspector.test.mjs`（含真实 app + SGR 点击的 e2e；harness 新增 `clickText` 步骤） | 无 |

---

## 7. Stage 2/3 开发计划（2026-10-21 主控提出；同日用户决定**不做编辑**，改为先拆分模块，见 [tui-buffer-components.md](tui-buffer-components.md)。7.1–7.4 留作记录，7.5 已实现）

### 7.1 已定
- **不与 Agent 通信**：用户在编辑器里的手改不进模型上下文，也不写 `ChangeLedger`（它只记 Agent 的 `edit`/`write`）。批注照旧存进 `ReviewNoteStore`，只有用户在 `/review` 里主动发送时才交给 Agent，与现在相同。Agent 下次 `read` 时读到的就是磁盘上的新内容。模型可见内容零改动，不需要重跑 model-snapshot/benchmark。
- Stage 2 的「选区插入输入框」（`@path:L42-58`）是用户自己发出的消息，不算 Agent 通信，保留。
- 不复用 pi-tui 的 `Editor`：它为输入框设计，整段渲染、无行号槽、无视口裁剪，undo/kill ring 是私有的。文件编辑沿用 `BufferViewport` 的「只渲染可见行」模型。

### 7.2 顺序（每步可独立合并）
| 步 | 内容 | 主要文件 | 风险 |
|---|---|---|---|
| **0 共享动作键** | 已完成（§7.5）。原计划把 `/preview` 文件视图等迁到 `BufferViewport`，读代码后改为只共享动作键：五个页面里只有文件视图和 diff 是滚动文本，其余是移动光标的列表；文件视图还带 Markdown/hex/滚动条拖动/记住位置，迁移成本远大于收益（顾问 gemini-4-argon 同意） | `src/tui/buffer/motion-keys.ts`，各页 `handleInput` | 已完成 |
| **1 Stage 2 选区** | `v`/`V` + 移动扩选，鼠标拖选；`Enter`/`p` 插入 `@path:L42-58`（无文件来源的块插文本 chip）；`c` 调 `ReviewNoteStore.add()` 写批注；`y` 复制选区 | `src/tui/buffer/`、`src/tui/transcript.ts`（插入回调）、`src/extensions/preview/notes.ts`（只调用） | 低：只读 |
| **2 Stage 3a 编辑原语** | `TextBuffer`：行数组、按字形簇（`Intl.Segmenter`）计光标列、undo/redo、`i a o O x dd yy p cw u Ctrl+r`；保留原文件的换行符（LF/CRLF）和末尾换行 | `src/tui/buffer/text-buffer.ts`（不依赖终端）、`keymap.ts`（INSERT 模式） | 中：宽字符/emoji/CRLF，靠单元测试与性质测试压实 |
| **3 Stage 3b 落盘** | 从 `read`/`edit`/`write` 块或 `@file` 打开文件 Buffer；`:w` `:q` `:wq` `:q!`；有未保存修改时 `:q`/Esc 拒绝关闭并提示 | `src/tui/buffer/file-buffer.ts`、`inspector.ts` | 低到中：规则见 7.3 |

### 7.3 `:w` 规则
- 打开时记录文件的 SHA-256；保存前重算，不一致就拒绝写入，底栏报 `File changed on disk since opened`，提供 `:e!`（丢弃修改重新载入）。不静默覆盖。
- Agent 回合进行中拒绝 `:w`（底栏提示等回合结束）：同一文件可能正被 `edit` 改写。主控默认，用户未另行指定。
- 只写当前 cwd 下、已存在的文本文件；大于 4MB（`/preview` 的 `MAX_TEXT_BYTES`）或非 UTF-8 的文件只读打开。
- 写入失败（权限、磁盘满）原样显示错误，Buffer 保持未保存状态。

### 7.4 性能
- 语法高亮按行缓存，编辑后只重算改动行附近（`highlightCode` 的状态以块注释/模板字符串为界向后传播，至多重算到下一处状态一致的行）。整文件重算只在打开时做一次。

### 7.5 共享动作键（step 0，2026-10-21 已实现）
用户在咨询 gemini-4-argon 后选定：全部页面统一为 Vim 的 `gg`，并获得数字计数。
- **范围**：`src/tui/buffer/motion-keys.ts` 只管移动——计数、`j/k/↑↓`、`Ctrl+d/u`、`Space/PageDown/Ctrl+f`、`b/PageUp/Ctrl+b`、`gg/Home`、`G/End`、`NG`/`Ngg`。`/`、`:`、`n/N` 各页自理（文件列表里 `/` 是实时过滤，`/review` 的输入是写批注，`/trace` 的 `/` 会切到详情）。
- **用到的页面**：悬浮窗、`/preview` 文件视图与文件列表、改动列表与单文件 diff、`/review`、`/trace` 的步骤列表与详情。
- **行为变化**：单个 `g` 不再到顶，要按 `gg`；`NG` 在文件视图和 diff 里与 `:N` 相同，在列表里是第 N 项，在 `/review` 里是第 N 行（会先载入全部文件）；之前缺 `Ctrl+f/b`、`b` 的页面补齐了；悬浮窗的 `Enter` 不再关闭。
- **例外**：`/trace` 详情里 `1-5` 切换分区，不接受计数（`gg`/`G` 照常）；`/preview` 文件列表里 `Space` 是标记文件，不翻页；视频播放器自己的 `g`/`0`（跳到开头）不变。
- **`g` 前缀**：`g` 后面跟的不是 `g` 时丢弃这个 `g`，下一个键照常处理，给将来的 `gj`/`gk`/`gd` 留位置。

