# grok-build TUI 调研笔记

## 来源与读法

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/xai-org/grok-build （`git clone --depth 1`，本地 `scratchpad/grok-build`） |
| commit | `f0e3be1100ef5252488e3be8bb0e91cf68d8c305`，2026-09-23 16:52:41 +0000，"Synced from monorepo" |
| 上游 monorepo 版本 | `SOURCE_REV` = `036a5d8348cd744767cd0b08518ab17bf608fa7f` |
| TUI crate 版本 | `xai-grok-pager` 1.0.41（`crates/codegen/xai-grok-pager/Cargo.toml`） |
| 规模 | 光 `xai-grok-pager/src` 就有 649 个 `.rs`，共 53.6 万行 |
| 截图 | 仓库里没有截图或录屏。README 引用了一张官方截图 `https://media.x.ai/v1/website/universe-tui-screenshot-6f7a0837.png`（xAI 自家域名），已下载到 `scratchpad/grok-tui-screenshot.png`，用它核对界面布局 |
| 快照测试 | 全仓只有 11 个 `.snap`：9 个是 Edit diff，2 个是用量块。提示框、弹窗、欢迎页都没有快照，这部分只能靠源码字符串和测试断言还原 |

**路径缩写**（都相对仓库根）：
- `P/` = `crates/codegen/xai-grok-pager/`
- `R/` = `crates/codegen/xai-grok-pager-render/`
- `M/` = `crates/codegen/xai-grok-pager-minimal/`
- `S/` = `crates/codegen/xai-grok-shell/`

**读法说明**：源码量太大，我分了三个只读子代理，分别读消息流渲染、输入与交互、主题与外围栏位。核心架构、布局和渲染模型是我自己读的。子代理报告里的关键字符串我抽查过：`┃`、`Thinking…/Thought`、turn status 布局、`Build anything`、`(●)/(○)`、`No, reject (type to add feedback)`、`"  │  "`、`Press Ctrl+c to cancel the turn`，都与源码一致。

本文标记约定：
- **"未验证"**：没读到原文。
- **"截图"**：来自上面那张官方截图，未必对应当前版本。

---

## 1. 技术栈

| 维度 | 结论 | 来源 |
|---|---|---|
| 语言 | Rust | 仓库根 `Cargo.toml` |
| TUI 框架 | **ratatui 0.29 + crossterm 0.28**（开启 `event-stream` 和 `bracketed-paste`）。在此之上有两个自研 fork 或扩展：`xai-ratatui-inline`（inline 视口，外加 flush 返回"有没有改动"）和 `xai-ratatui-textarea`（输入框） | 根 `Cargo.toml` L151、L234、L375-376；`P/Cargo.toml` |
| 渲染原语 | ratatui 的 cell `Buffer`，逐帧双缓冲 diff。组件接口是 `trait Renderable { fn render(&self, area: Rect, buf: &mut Buffer); fn desired_height(&self, width: u16) -> u16; }` | `R/src/render/renderable.rs:10` |
| 屏幕模式 | 三种（见 1.1）：**Fullscreen**（alternate screen）、**Inline**（主屏上开一个整屏高的 inline 视口）、**Minimal**（实验性。已定稿的块写进终端原生 scrollback，底部只留一小块 live 区） | `P/src/app/mod.rs:347` `enum ScreenMode`；`init_terminal` L1466-1650 |
| 每帧绘制 | 不走 `Terminal::draw()`，自己按 `autoresize → get_frame → flush（cell diff）→ swap_buffers` 分步调用。光标命令做去重，目的是不打断光标闪烁。每帧包在 `BeginSynchronizedUpdate/EndSynchronizedUpdate`（DEC 2026）里；tmux 下不包 | `R/src/render/draw.rs` 文件头 L1-40 |
| 写终端 | 由独立的 writer 线程（`TermWriter`）执行，回传写入确认。如果终端长时间不读 pty，会上报诊断 | `R/src/render/draw.rs`；`P/src/app/event_loop.rs` 的 `writer_blocked_report` 分支 |
| 状态管理 | **Elm 风格**：输入产生 `Action`，`dispatch` 同步修改状态并返回 `Vec<Effect>`，事件循环异步执行 `Effect`，结果以 `TaskResult` 回到 `dispatch`。`dispatch` 不碰终端、网络和文件，可以脱离 tokio 单独测试 | `P/src/app/actions.rs` 文件头；`P/src/app/dispatch/mod.rs` 文件头；`router.rs:156 fn dispatch` |
| 状态树 | `AppView`（欢迎页、各会话、全局配置）→ 每个会话一个 `AgentView`（提示框、scrollback、各 pane、modal）。另有 `ScrollbackState`，存条目列表和布局缓存 | `P/README.md` "Key Concepts"；`P/src/app/app_view.rs`；`P/src/app/agent_view/mod.rs` |
| 事件循环 | 一个 `tokio::select! { biased; ... }`，分支按优先级排：连接断开 → 退出信号 → writer 回执 → writer 阻塞诊断 → ACP 消息（只在输入队列为空时读）→ 后台任务结果 → 进度 → 输入 → resize 去抖（16ms）→ 被节流的延迟绘制 → 滚动时钟（16ms）→ 动画 tick → 各种轮询 → 配置热加载 | `P/src/app/event_loop.rs` L2125 起；`RESIZE_DEBOUNCE` L29 |
| tick 策略 | `TickDemand::{None, Slow, Fast}`：没有动画时循环完全挂起（零唤醒）；欢迎页 logo 的流光用 Slow（83ms，约 12fps）；屏上有真动画时用 Fast，默认 `[animation] fps=30` | `P/src/app/app_view.rs:245-257` |
| 输入 | crossterm 事件流由独立 reader 线程读取。会协商 kitty keyboard protocol。有启动 type-ahead：加载期间敲的字会回放进输入框。另有 CSI/X10/XT 等终端噪声过滤 | `P/src/app/reader_thread.rs`；`mod.rs` L1540+；`event_loop.rs` 的 `capture_startup_typeahead`；`P/src/app/{csi_filter,x10_filter,xt_filter}.rs` |
| 与 agent 通信 | TUI 是 **ACP（Agent Client Protocol）客户端**，通过 leader IPC 或 stdio 与 agent 进程通信。协议是标准 `acp::SessionUpdate` 加上 xAI 扩展方法 `x.ai/session_notification`、`x.ai/session/update` | `P/src/acp/mod.rs`；`P/src/acp/leader_bridge.rs` |
| 其它依赖 | pulldown-cmark（markdown）、syntect + two-face（高亮）、similar（diff）、nucleo（模糊匹配）、textwrap、unicode-width | `P/Cargo.toml`；`crates/codegen/xai-grok-markdown*` |

### 1.1 三种屏幕模式

| 模式 | 如何进入 | 画面 | 历史存在哪 | 鼠标 |
|---|---|---|---|---|
| Fullscreen | 默认；alt-screen 策略为 auto/always 时 | `EnterAlternateScreen`，ratatui `Viewport::Fullscreen` | 应用自己维护的 scrollback pane（虚拟滚动、折叠、选择） | 捕获 |
| Inline | `--no-alt-screen`、`[terminal] alt_screen="never"`，或 Zellij、tmux control mode 自动降级 | 主屏上开 `Viewport::Inline(rows)`，**高度等于整屏**，UI 与 Fullscreen 相同 | 同上 | 捕获 |
| Minimal（实验性） | `--minimal`、`/minimal`、`[ui] screen_mode="minimal"`；终端会把鼠标上报漏成文本时（JediTerm、Windows）自动进入 | 底部 `Viewport::Inline(minimal_live_rows)`，限制在 3 到 rows-1 之间 | **终端原生 scrollback**：已定稿的块经 `insert_before_rows` 打印一次，之后不再改 | 不捕获 |

来源：`P/src/app/mod.rs:1578-1650`、`screen_mode_relaunch.rs:304 resolve_screen_mode`、`P/docs/user-guide/05-configuration.md:185-191`、`21-terminal-support.md:174-179`、`M/src/lib.rs` 文件头。

**与 Pi 最相关的是 Minimal 模式**。它的模型是"已定稿块进原生 scrollback，底部 live 区做差分重绘"，这正是 pi-tui 的路子。实现要点（`M/src/commit.rs`、`M/src/live.rs`）：

- **committed frontier**：从头数，连续的、已定稿且不在等用户输入的条目，一律提交进 scrollback。流式中的消息、运行中的工具、等权限的块留在 live tail 里。见 `is_committable`。
- **等待用户输入的块永不提交**。原因：它的样子在用户回答后还会变，印死在 scrollback 里就错了。
- 块间距 `MINIMAL_BLOCK_GAP = 0`。live 区和提交后必须使用同一个高度，否则每次提交提示框都会跳。
- live 区从上到下：live tail（未提交段的底部）· todos · `/btw` · 状态行 · 提示框（无边框）· overlay/info · status_line。见 `M/src/live.rs` 文件头。
- resize 后按新宽度重印全部历史（`M/src/reprint.rs`）。单个提交块上限 2000 行（`minimal_max_commit_rows`；脚注文字未验证）。
- 已知取舍：`/find /jump /timeline /theme /tutorial /dashboard` 只在全屏可用，`/expand` 只在 minimal 可用。原因是 minimal 下 terminal 拥有历史，不能再折叠或选择。见 `P/docs/user-guide/04-slash-commands.md:156-160`。

---

## 2. 屏幕布局

### 2.1 Agent 主界面（Fullscreen/Inline），从上到下

行栈由 `AgentViewLayout::compute` 算出（`P/src/views/agent.rs:174-407`）。外边距默认上下 1、左右 2，来自 `R/src/appearance/config.rs:181` `LayoutConfig::default`。可选行高度为 0 时连同上方的 1 行间隔一起消失。

| # | 区域 | 显示什么 | 何时出现 | 来源 |
|---|---|---|---|---|
| 1 | Header 状态栏（1 行） | 左：会话标题 │ 分支（Nerd Font 下用 `` 图标，否则 `⎇`）· `worktree` 徽章 · `sandbox:{profile}` · cwd。右：后台任务 `◆ N` │ `plan` │ goal │ MCP 初始化 │ 上下文 `9.5K / 500K`（悬停时显示 `█████ 42.0%`）│ `‹ 2/3 ›` 会话切换 │ `[Dashboard]` | 总是 | `P/src/views/status_bar.rs`、`agent_status.rs`、`context_bar.rs`；`render.rs:1225-1480`；截图 |
| 2 | Tasks pane | 分组 `Workflows/Subagents/Tasks/Watchers`（`▸/▾` 折叠），行首是点状 spinner 或 `✓`/`✗`，右侧是耗时、`(2.0k+)` 行数、`[✗][↗]` | `Ctrl+G` 切换；高度取 min(条目数, 8, 视图高 15%)；视图 <12 行时隐藏 | `P/src/views/tasks_pane.rs` |
| 3 | Todo pane | `□` 待办、`▶` 进行中、`✓` 完成、`✗` 取消。数据来自 ACP `Plan` | `Ctrl+T`；最多 10 行或 15% 高 | `P/src/views/todo_pane.rs`；`acp_handler/mod.rs:217` |
| 4 | **Scrollback** | 消息流，见第 3 节。右侧是滚动条，或 2 列宽的 timeline rail | 总是，最少 5 行（唯一的 `Min` 约束） | `agent.rs:89 SCROLLBACK_MIN_ROWS` |
| 5 | /btw 面板 | 旁路提问的回答 | 有 /btw 时 | `P/src/views/btw_overlay.rs` |
| 6 | Queue pane | `#1 首行 (+N lines)`，右侧 `[Send now][edit][cancel]` | turn 运行中有排队消息；最多 3 行 | `P/src/views/queue_pane.rs` |
| 7 | **Turn status**（1 行） | `⠧ Responding… 15s ⋯⋯ 17s ⇣9.45k [stop]` | 仅 turn 运行时；空闲时高度为 0 | `P/src/views/turn_status.rs` 文件头；截图 |
| 8 | Banner / tip | 模式切换横幅、一次性提示 | 按需 | `P/src/tips/` |
| 9 | Plugin CTA | 插件推荐 | 按需；≤16 行时强制隐藏 | `agent.rs:185-195` |
| 10 | Follow-ups | 追问建议 chips | 同上 | `agent.rs:462 render_follow_ups` |
| 11 | Dock | 汇总的 Subagents/Tasks/Watchers/Queued 面板 | 远程开关 `dock_enabled`，默认关 | `P/src/views/dock/` |
| 12 | 录音指示 | `◉ Recording` | 语音输入中 | `agent.rs:150` |
| 13 | **Prompt**（或"阻塞卡片"） | 圆角输入框。权限、提问、MCP elicitation、rewind、取消确认这些卡片**直接占用这个区域** | 总是；最高为屏高的 1/2 | `render.rs:2330-2750`；`render.rs:800` |
| 14 | Status line | 用户可配置的底部状态行 | 默认关 | `P/src/views/status_line/` |
| 15 | **Shortcuts bar**（1 行） | `Key:label  │  Key:label`，随焦点和上下文变化 | 总是 | `P/src/views/shortcuts_bar.rs:263` |

**浮在最上层**的有：命令面板、设置、会话选择器等 `ModalWindow`，以及 `@`、`/` 下拉。下拉在全屏模式下画在**提示框上方**，在 minimal 模式下画在**下方**（`P/src/app/agent_view/mod.rs:1696 render_dropdown_chrome`）。

**高度自适应规则**（`P/src/views/agent.rs:86-99`）：
- ≤16 行：去掉底部边距、CTA 和 follow-ups。
- ≤20 行：自动进入 compact 模式（外边距变 0 或 1）。这个状态不写回配置，窗口放大后自动恢复。

### 2.2 ASCII 还原：Agent 主界面

依据：官方截图 + 布局代码 + 各组件字符串。颜色用 `[token]` 标注。

```
  ~/Documents                                                     9.5K / 500K     ← header：cwd[text_secondary]，右侧上下文
                                                                                  ← status_gap（1 行）
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ ▲
  ░ ❯ explain the universe                                     8:19 AM    ░ █  ← 用户消息：没有边框，整块铺 bg_light(#242424) 底色（░ 表示），
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ █     上下各留 1 行内边距；❯[accent_user]。滚动时会吸顶
                                                                            █
     ◆ Thought for 2.0s                                                     █  ← thinking 完成后折叠；◆[gray]，"Thought"粗体 muted
                                                                            ░
     The Universe, briefly                                      8:19 AM     ░  ← agent 消息：markdown，无 rail、无标题行；
                                                                            ░     H1[md_h1 #1abc9c]、H2[md_h2 #7aa2f7]
     The **universe** is everything that exists ...                         ░
     ───                                                                    ░  ← `---` 渲染成 ───
     • Vast — about 93 billion light-years ...                              ░  ← `- ` 渲染成 •（截图里是 ·）
  ┃  ◆ Run cargo test                                                       ░  ← 运行中的工具：┃ rail[accent_running #bb9af7] 带波浪动画
  ┃    $ cargo test -p foo                                                  ░
  ┃    … +120 lines                                                         ░
     ◆ Read 2 files, Searched 1 pattern                                     ░  ← 连续的只读工具折叠成一行（verb group）
                                  ▼                                         ░  ← 跟随指示：下方还有新内容
  ⠧ Responding… 15s                                   17s ⇣9.45k [stop]        ← turn status（仅运行时）
                                                                               ← prompt_gap
  ╭──────────────────────────────────────────────────────────── Stashed ─╮    ← 圆角框[prompt_border_active #505058]；
  │ ❯ █                                                                   │       顶边可嵌标题或 Stashed
  ╰─────────────────────────────────── Grok 4.5 (high) · always-approve ─╯    ← 底边嵌 模型(effort) · 权限模式；右侧可放 multiline
  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+.:shortcuts                        ← shortcuts bar：键粗体，label muted
```

说明：
- 截图里用户消息块的时间戳 `8:19 AM` 在右侧，对应 `ToggleTimestamps` 设置。
- 截图里底边信息靠右（`Grok 4.5 (high) · always-approve ─╯`）。子代理的源码描述是"左侧 model · flags，右侧 multiline"。两者可能是版本差异，**确切对齐方式未验证**。
- 截图里 bullet 显示为 `·`，源码 `parse.rs:1040` 写的是 `•`。**差异原因未验证**。

### 2.3 ASCII 还原：阻塞卡片占用提示框位置（权限确认）

依据：`P/src/views/permission_view.rs:423,1436-1532`、`P/src/app/acp_handler/permissions.rs:226-265`、`crates/codegen/xai-grok-workspace/src/permission/prompter.rs`。

```
  ⠧ Waiting for response…                             42s ⇣3.1k [stop]
  ┃ Allow `cargo`?                                                         ← 粗体标题；整卡 bg_light 底色
  ┃   cargo test -p xai-grok-pager                                         ← bash 高亮；过长时显示 "... Ctrl-F to expand"
  ┃ ← → narrow scope  ·  e edit pattern
  ┃
  ┃ 1 (●) Yes, proceed                                                     ← 光标行：(●) 加粗
  ┃ 2 (○) Always allow: cargo test *
  ┃ 3 (○) Yes, and don't ask again for anything (always-approve mode)
  ┃ 4 (○) No, reject (type to add feedback)                                ← 在这一行直接打字，会变成内联 ❯ 输入框
  1-N select · Tab next option · ←→ scope · e edit pattern · Ctrl+F expand · Ctrl+O always-approve · Ctrl+C cancel
```

- 多个卡片同时存在时，优先级是：权限 > 取消确认 > 提问 > elicitation（`render.rs:810-960`；`P/src/app/agent_view/key_owner.rs` 的 `BlockingCard`）。
- Esc 在卡片上是逐级后退：先清掉卡片里暂存的内容，再把焦点让给 scrollback；`Tab` 或 `Space` 回到卡片。它**不会**拒绝请求（`key_owner.rs` 的 `EscStep`；`P/docs/user-guide/03-keyboard-shortcuts.md:115,143,209`）。

### 2.4 ASCII 还原：欢迎页

依据：`P/src/views/welcome/`、`P/assets/logo/logo07.txt`、`hero_box.rs:14`、`mod.rs:1772`。

```
    main  ~/proj                                                  ← top bar
   ╭──────────────────────────────────────────────────────────────╮
   │  ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄     Grok Build  1.0.41  │  Tier: …             │   ← 宽度 ≥90 列时 logo 与菜单左右并排、外加圆角框；
   │  ⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀     Thanks for trying Grok Build, give ...  │      logo 有 12fps 斜向流光（gray → text_primary）
   │  ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀     New worktree ............... ctrl+w     │
   │  ⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀     Resume session ............. ctrl+r     │
   │  ⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀     Changelog                               │
   │  ⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀     Quit ....................... ctrl+q     │
   │  ⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀                                            │
   ╰──────────────────────────────────────────────────────────────╯
        Tip: …      （更新提示 > 隐私横幅 > "Coming from {tool}? …" > 随机 tip）
   ╭──────────────────────────────────────────────────────────────╮
   │ ❯ Type a message...                                           │
   ╰──────────────────────────────────────────────────────────────╯
```

- 高度 ≥26 行用 7 行 logo，22 到 25 行用 5 行版，<22 行不显示 logo。
- 菜单里点号引导线的具体字符**未验证**。

### 2.5 Dashboard（多会话总览，官方文档原样）

来源：`P/docs/user-guide/23-dashboard.md:30-43`。

```
  main ~/xai [Choose Ctrl+l]                    ◆ 2 awaiting │ ⋮ 1 working │ ◇ 1 idle

  + New Agent                                Open Previous /resume │ Worktree Ctrl+w

▌● reviewer · audit token flow    Awaiting your input            2m
 ● implementer · fix login bug    Running: cargo test           12m
 ⋅ refactor · feat/login          Responding…                   24m
 ○ housekeeping                   idle                           1h
╭─────────────────────────────────────────────────────────────────╮
│ ❯ Dispatch a new agent                                          │
╰─ dispatch ──────────────────────────────────────────────────────╯
 ↑/↓ select (peek) · Enter open · Ctrl+R rename · Ctrl+T pin · Ctrl+X stop · ? help · Esc new
```

---

## 3. 视觉语言

### 3.1 主题 token（默认 groknight 暗色 / grokday 亮色）

来源：`R/src/theme/groknight.rs`、`grokday.rs`；槽位表见 `P/docs/user-guide/06-theming.md`。

| 语义槽 | 暗 | 亮 | 用途 |
|---|---|---|---|
| bg_base | #141414 | #eeeeee | 整屏底色（显式涂满，`agent.rs:442 fill_background`） |
| bg_light | #242424 | #dedede | 用户消息块、权限卡片底色 |
| bg_dark / md_code_bg | #1c1c1c | #e4e4e4 | 工具输出面板、代码块 |
| bg_visual | #363636 | #c6c6c6 | 下拉选中行 |
| text_primary | #e1e1e1 | #262626 | 正文 |
| text_secondary / accent_user | #c8c8c8 | #444444 | 次要文字、`❯` 与光标色 |
| accent_assistant / thinking / running | #bb9af7 | #7D4BC6 | 运行中 rail 与 spinner |
| accent_tool | #787878 | #626262 | 完成的工具 |
| accent_system / fuzzy_accent / md_h2 | #7aa2f7 | #2F64D2 | 系统、模糊匹配高亮、auto 模式标签 |
| accent_error / diff_delete_fg | #f7768e | #CD3048 | 失败 |
| accent_success / diff_insert_fg | #9ece6a | #378E23 | 成功、完成闪烁 |
| accent_plan | #FFDB8D | #A8780A | plan 模式（提示框边框按 40% 混入此色） |
| accent_model / md_h1 | #1abc9c | #0A8E70 | 标题 |
| gray / gray_dim | #6c6c6c / #585858 | #767676 / #a5a5a5 | muted / dim |
| path / command / running | #ff9e64 / #e0af68 / #7dcfff | — | 路径、命令、运行态 |
| prompt_border / active | #323237 / #505058 | #C8C8CD / #A5A5AF | 提示框边框 |
| diff_insert_bg / diff_delete_bg | #063806 / #420e14 | #DAF2DC / #F5DADE | diff 行底色 |

**内置主题**：groknight（默认）、grokday、tokyonight、rosepine-moon、oscura-midnight。后三个要求 truecolor。另有 `terminal`（纯 ANSI，不涂背景，需灰度开关打开）和 `auto`（跟随系统，每 5s 轮询）。见 `R/src/theme/mod.rs` 的 `ThemeKind`。

**终端适配**：
- 背景明暗探测顺序：OS API → `GROK_APPEARANCE` → `COLORFGBG` → OSC 11 查询（500ms；tmux 下再用 DCS 包装查一次，80ms）。见 `R/src/theme/osc11.rs`。
- 色深分 TrueColor、256、16 三级。认得出终端品牌时，256 自动升级为 truecolor（tmux、SSH 会吞掉 `COLORTERM`）。`Theme::quantized()` 把每个槽映射到调色板里最近的颜色。支持 `NO_COLOR`。见 `R/src/theme/color_support.rs`。
- 用 OSC 12 把光标色设成 `accent_user`。

### 3.2 边框、分隔符与图标

| 元素 | 字符 | 来源 |
|---|---|---|
| 提示框 | 圆角 `╭─╮ │ ╰─╯`，底边嵌信息 | `P/src/views/prompt_widget/mod.rs` 约 L3040-3372 |
| ModalWindow | 直角 `Borders::ALL`[gray_dim]，标题写成 `─ Title ─`，右上角 `[✗]` | `P/src/views/modal_window.rs:406` |
| 下拉 | 上下各一条整宽 `─`，计数靠右放在上横线上，无竖边 | `agent_view/mod.rs:1696` |
| 块 accent rail | `┃`（U+2503），仅块展开时画 | `R/src/glyphs.rs:175 accent_bar` |
| 折叠 accent | `❙` | `glyphs.rs collapsed_accent` |
| 工具 bullet | `◆`（可配成 `· • ● ▸ ▶`）；截断组用 `◈`；空闲用 `◇` | `P/src/scrollback/block.rs prepend_bullet`；`glyphs.rs` |
| 选中块 | `┌ ┐ └ ┘ │`，被裁掉的边用 `┆`；按钮 `⧉` 复制、`↗` 放大；可折叠行用 `›`/`⌄` 代替 bullet | `P/src/scrollback/selection.rs`；`scrollback_pane.rs:1140` |
| 分隔符 | shortcuts bar 用 `"  │  "`；header 和 status line 用 `" │ "`；信息行用 `" · "` | `shortcuts_bar.rs:263`；`agent_status.rs`；`status_line` 的 `SEGMENT_SEPARATOR` |
| 状态图标 | `✓` `✗` `□` `▶` `▸/▾` `⇣`（token 数）`◉/◎`（录音、monitor 脉冲）`⚠` | `R/src/glyphs.rs` |
| 旧 Windows ConHost 回退 | 每个 glyph 都有 ASCII 或 CP437 替身（`❯` 变 `>`，`┃` 变 `│`，`◆` 变 `♦`……），宽度保持一致 | `R/src/glyphs.rs` 文件头 |

### 3.3 Spinner 与动画

| 名称 | 帧 | 节奏 | 用处 |
|---|---|---|---|
| braille | `⠋⠙⠹⠸⠼⠴⠦⠧` | 每 4 tick 一帧，约 133ms（约 7.5fps） | turn status；终端 tab 标题里每 8 tick 一帧，约 264ms，因为 Ghostty 对标题更新做了去抖 |
| dot | `⋅ : ⸬ ⁙` | — | tasks pane、dock 行 |
| monitor | `○ ◎ ◉ ◎` | 每 8 tick 一帧 | 空闲时"仍有后台在跑"的提示 |
| rail 波浪 | 亮度沿 rail 纵向流动（`wave_rows=32`） | 30fps | 运行中的块 |
| 完成闪烁 | rail 闪 `accent_success` | 400ms | 工具或 thinking 结束时 |
| logo 流光 | 斜向亮带 | 12fps，4s 一轮 | 欢迎页 |

来源：`R/src/glyphs.rs`、`P/src/views/turn_status.rs`、`P/src/notifications/title.rs`、`P/src/scrollback/state/types.rs:75 FINISH_FLASH_DURATION_MS`、`P/src/scrollback/wrappers/entry_renderer.rs` 约 L689。

终端集成：
- tab 标题显示 `spinner + 活动 + 会话名`；有待审批时闪 `⚠ Action Required`，终端未聚焦时才闪。
- 在 Ghostty、WezTerm、iTerm2 3.6+ 上发 OSC 9;4 不确定进度条。截图里 tab 下那条蓝线就是它。
- 来源：`P/src/notifications/title.rs`、`progress.rs`。

### 3.4 Markdown 渲染

来源：`crates/codegen/xai-grok-markdown*`、`R/src/theme/md_style.rs`。

- 解析器是 pulldown-cmark。"pretty" 模式下 `#`、`**`、反引号、代码围栏标记都隐藏，只保留样式（`render.rs:640-675`）。
- 转换规则：`- ` 变 `•`，`>` 变 `│`，`---` 变 `───`，链接后缀 ` (url)`（`parse.rs:924,1040`）。
- 标题 H1 到 H6 分别是 teal、blue、purple、#787878、#6c6c6c（都加粗），最后一级不加粗。行内代码用 `md_code` #3A95AB 加粗。代码块铺 `md_code_bg` 底色。
- 表格用 BOX 字符 `─│┌┐└┘┬┴├┤┼`，表头加粗，行与行之间有分隔线。宽度不够时按"最长的不可断词"收缩列宽，剩余宽度按比例分配。表格从不软换行（`parse.rs:1588-1850`）。
- 代码高亮用 syntect + two-face 语法包，自带 `grok-night`、`grok-day`、`tokyo-night` 三个 `.tmTheme`（`R/src/syntax.rs:119-132`；`R/assets/`）。
- Mermaid 围栏在进程外渲染成图（`xai-grok-mermaid`，由 `appearance.render_mermaid` 开关控制）。

### 3.5 Diff 渲染

来源：`P/src/scrollback/blocks/tool/edit.rs`、`crates/codegen/xai-grok-pager-diff/src/lib.rs`；快照在 `P/src/scrollback/blocks/tool/snapshots/`。

- 只有 unified 格式，基于 `similar`，上下文 3 行。
- **没有 `+`/`-` 符号列**：增删只靠行底色（`#063806` / `#420e14`）和行号颜色（绿/红）区分。
- 可选双行号（`dual_line_numbers`）。hunk 之间显示 `… N unchanged lines`。
- 高亮分两步：先只高亮 hunk；文件 ≤2MiB 且 ≤5 万行时，后台再升级为整文件高亮。
- **没有**词级高亮。

快照原样（`...edit__tests__diff_merged_hunks_gap_markers.snap`、`diff_basic_dual.snap`）：

```
  3  fn one() {                     10 10  let x = 1;
  4  old_one();                     11     let y = 2;
  4  new_one();                        11  let y = 3;
  … 7 unchanged lines               12 12  let z = 4;
  12  ctx_two();
```

### 3.6 宽度自适应

| 规则 | 值 | 来源 |
|---|---|---|
| 左右外边距 | 2（compact 模式为 1） | `R/src/appearance/config.rs` |
| 块内布局 | 1 列 rail + 2 列 pad + 内容 + 2 列 pad | `P/src/scrollback/layout.rs HorizontalLayout` |
| timeline rail | ≥60 列且 ≥2 个 turn 时替换滚动条 | `P/src/views/timeline.rs:20` |
| turn status 的阶段计时 | <60 列隐藏 | `turn_status.rs:40` |
| 欢迎页并排布局 | ≥90 列 | `welcome/hero_box.rs:14` |
| 斜杠菜单 label 列宽 | min(40, 60% 宽度) | `P/src/views/slash_dropdown.rs` |
| 命令面板 | 宽 50%，最大 80 列、最小 44 列 | `P/src/app/modals.rs:1766` |
| ModalWindow 默认 | 宽 90%，60 到 140 列 | `modal_window.rs` |
| resize | 16ms 去抖后只画一次；每条目的 `cached_line_widths` 在 resize 后保留 | `event_loop.rs:29`；`P/src/scrollback/entry.rs:61-102` |

---

## 4. 交互

### 4.1 输入框（`P/src/views/prompt_widget/mod.rs`）

| 功能 | 行为 | 来源 |
|---|---|---|
| 前缀 | 普通是 `❯ `；历史搜索时 `? `；bash 模式 `! `[command]；记忆模式 `# `[accent_remember]；评论 plan 时 `● ` | mod.rs 约 L3084；`agent_view/mod.rs:362-368` |
| 占位符 | `Build anything`（聚焦时隐藏）；欢迎页是 `Type a message...` | mod.rs:3316 |
| 多行 | `Shift/Alt/Super+Enter` 换行。`Ctrl+M` 切到 multiline 模式后，Enter 换行、Shift+Enter 发送，底边显示 `multiline` | mod.rs 约 L1814 |
| 高度 | 随内容增长，最高为屏高的 1/2 | `render.rs:800` |
| 历史 | 空提示框上按 `↑` 进入浏览（边浏览边填充）；如果有排队消息，`↑` 先去 queue。`/history` 打开模糊搜索面板（nucleo 后台线程，面板在提示框上方，最多 8 行）。**`Ctrl+R` 是会话选择器，不是历史搜索** | `P/src/views/history_search.rs:393` |
| 粘贴 | ≥4 行（compact 模式 ≥2 行）折叠成原子 chip `[Pasted: N lines]`；>10KB 显示 `[Pasted: 12 KB]`；`Ctrl+Shift+V` 原样内联粘贴 | mod.rs:2309、3790 |
| 图片 | `[Image #N]` chip；支持粘贴和拖拽 | mod.rs:2349 |
| 暂存 | `Ctrl+S`/`Alt+S` 暂存或弹出草稿，此时顶边显示 `Stashed`。双击 Esc 清空时也会自动暂存 | `P/src/app/agent_view/prompt_stash.rs:49` |
| `@` 文件 | 下拉 8 行，nucleo 后台 daemon（top-K 1000），匹配字符用 `fuzzy_accent` 着色 | `P/src/views/file_search/` |
| `/` 命令 | 下拉 8 行，列为 `❯ label [tag]  描述`。MRU 排序：半衰期 7 天，存在 `$GROK_HOME/slash-mru.json` | `slash_dropdown.rs`；`P/src/slash/mru.rs`；`P/src/slash/mod.rs:39` |
| 命令面板 | `Ctrl+P` 或 `?` 打开浮动 ModalWindow "Commands"，分组 Session/Context/Model & Input/Tools/Other，行右侧显示快捷键 | `P/src/views/modal.rs:385-542` |
| 外部编辑器 | `/edit-prompt`、命令面板；minimal 模式下是 `Ctrl+G` | `03-keyboard-shortcuts.md:259,273` |
| 语音 | `Ctrl+Space`/`F8` | `actions/defaults.rs` |

### 4.2 快捷键（摘要）

来源：`P/src/actions/defaults.rs`、`P/docs/user-guide/03-keyboard-shortcuts.md`。

| 键 | 上下文 | 动作 |
|---|---|---|
| Enter | 提示框 | 发送；turn 运行中则**排队**；空框上按 Enter 立即发送队首 |
| Ctrl+Enter（各终端有别名） | 提示框 | 插话（interject）：取消当前 turn 并立刻发送 |
| Ctrl+C | 任意 | 草稿非空时先清空；草稿为空时取消 turn |
| Esc | turn 运行中 | **不会**取消，只弹 toast "Press Ctrl+c to cancel the turn"（03 文档 L227；`app_view_tests.rs:3837`）。注意：`P/README.md` 的快捷键表写着"Esc 取消"，与 user-guide 和测试**矛盾**，以后两者为准 |
| Esc Esc（800ms 内） | 空闲 | 草稿非空：清空并暂存。草稿为空：打开 rewind 选择器 |
| Shift+Tab | 提示框 | 循环切换 Normal → Plan → Auto → Always-approve |
| Ctrl+O | agent | 切换 always-approve |
| Ctrl+M（提示框外） | agent | 模型选择器 |
| Ctrl+P / ? | agent | 命令面板 |
| Ctrl+R | agent | 会话选择器 |
| Ctrl+N / Ctrl+Q | 全局 | 新会话 / 退出（都要按两次确认） |
| Ctrl+\ | 全局 | Dashboard |
| Ctrl+T / Ctrl+G / Ctrl+; | agent | todo / tasks / queue pane |
| Ctrl+B | agent | 把前台命令送到后台 |
| Tab | 提示框 ↔ scrollback | 切换焦点 |
| ↑↓、Shift+←→、←→、Enter | scrollback | 选条目、跳 turn、折叠/展开、全屏查看（vim 模式下对应 j/k、H/L、h/l） |
| Ctrl+E | scrollback | 展开或折叠所有 thinking |
| y / Y | scrollback | 复制块内容 / 复制命令 |
| Ctrl+. | agent | 快捷键速查 |
| F2 | agent | 设置 |

### 4.3 审批、提问与计划

- **权限**：卡片占用提示框位置，见 2.3。
  - 选项来自 ACP `PermissionOption`，TUI 按 kind 重新写 label。
  - `←→` 调整放行范围（命令前缀词粒度）；`e` 编辑匹配 pattern，实时显示 `✓ matches this command` / `✗ won't match` / `⚠ very broad`。
  - 来源：`permission_view.rs`、`acp_handler/permissions.rs`。
- **提问**（agent 发起的多选题）：同样的 rail 卡片。
  - 单选 `(●)/(○)`，多选 `[x]/[ ]`；`1-9`、`a-f` 直接选，`z` 自由输入。
  - `←→` 在多个问题之间切换，`Shift+X` 放弃回答。
  - 来源：`P/src/views/question_view.rs:1534`。
- **Plan 审批**：全高 plan 预览，按钮条 `a approve` / `s request changes` / `c comment`（带 ` N ●` 计数）/ `y copy plan` / `q quit plan`。可以针对行范围写评论，底边标签显示 `commenting L3-5`。来源：`P/src/views/file_search/line_viewer.rs:1655-1700`、`plan_approval_view.rs`。
- **Rewind**：先选 turn（`Rewind to which turn?`），再确认 `y Yes / a Yes, and don't ask again`。来源：`P/src/views/rewind.rs`。

### 4.4 工具调用的展开与折叠

- 三态 `DisplayMode::{Collapsed, Truncated, Expanded}`（`P/src/scrollback/types.rs`）。
- 每类工具有自己的默认态、结束态和截断规则：

| 工具 | 默认 | 截断 | 结束后 |
|---|---|---|---|
| agent 执行的 bash | 折叠（只显示标题） | — | 保持折叠 |
| 用户 `!` bash | Truncated：前 2 行 + `… +N lines` + 后 3 行 | 同左 | 展开 |
| Read | — | 前 5 行 + `…` + 后 3 行 | 折叠 |
| Web / MCP 工具 | — | 最多 10 行，之后 `... (N more lines, press Enter to view)` | — |
| Thinking | 运行中显示最后 3 行 | — | 折叠成 `Thought for 2.0s` |

  来源：`P/src/scrollback/blocks/tool/*.rs`、`blocks/thinking.rs`。
- **动词分组**：连续折叠的只读工具合并成一行，例如 `Read 2 files, Searched 1 pattern, Listed 1 dir`；运行中显示 `Reading … , N completed · M failed`。组内超过 10 项时显示 `◈ N more`（`P/src/scrollback/state/verb_group.rs`；`entry_renderer.rs:203-290`）。可以用 `SetGroupToolVerbs` 关闭。
- 手动折叠会被记住（`SetRespectManualFolds`）。Edit 块默认折叠还是展开可在设置里配（`SetCollapsedEditBlocks`）。

### 4.5 流式、中断、排队

- **流式**：markdown 用 checkpoint 冻结，只重渲 tail，并缓存换行结果（详见 5.3）。
- **中断**：只有 `Ctrl+C`，或点击 turn status 上的 `[stop]`。取消中再按 `Ctrl+C` 会升级为退出。
- **排队**：turn 运行中按 Enter 会进入 queue pane，turn status 显示 ` · N queued, Enter to send now`。队列里的项可以编辑、排序、删除，也可以"立即发送"（interject）。来源：`P/src/views/queue_pane.rs`、`P/src/app/dispatch/queue.rs`、`interject.rs`。
- **后台**：`Ctrl+B` 把前台命令转到后台；也可以点 turn status 上的 `[send to bg]`。

### 4.6 模式、模型与会话切换

- **权限模式**：`Shift+Tab` 循环切换，结果显示在提示框底边（`always-approve`，或蓝色的 `auto`）；plan 模式时提示框边框变金色。
- **模型**：`Ctrl+M`（提示框外）或 `/model` 打开选择器。如果目标模型需要不同的 harness，会提示新开会话（`SwitchModelError::IncompatibleAgent`，`P/src/app/actions.rs:17`）。
- **会话**：
  - `Ctrl+R` 会话选择器。
  - header 右侧的 `‹ 2/3 ›` 在同一进程的会话之间切换。
  - `Ctrl+\` 打开 Dashboard（见 2.5）。
  - 支持 fork 和重命名。
  - 能发现并恢复 Claude 等其它工具的会话（`xai-grok-foreign-sessions`；欢迎页 tip 会显示 "Coming from {tool}?"）。

### 4.7 子代理与后台任务

- **scrollback 里**是一行 `Subagent running: "描述" · 活动 · meta`，结束后变成 `completed in Xs: "…"` / `failed in …` / `cancelled in …`（`P/src/scrollback/blocks/subagent.rs`）。
- **tasks pane 或 dock 里**是实时行，例如 `⋅ Explore find dashboard render path — reading render.rs    grok-4.5 2m14s [↗][stop]`（`P/src/views/dock/mod.rs` 测试约 L545-558）。
- **全屏接管**：可以进入子代理的独立视图（`draw_subagent_fullscreen`，`render.rs:659`）。框标题含 spinner 或 `✓/✗`、模型、`resumed/forked` 徽章，以及 `activity · elapsed`；按 `q`/Esc 返回。
- **空闲提示**：agent 空闲但仍有后台任务时，turn status 位置显示 `◎ 1 command · 2 monitors still running`。

---

## 5. 组件架构

### 5.1 模块清单

| 层 | 模块 | 职责 | 依赖 |
|---|---|---|---|
| **通用原语**（`R/`，已独立成 crate） | `render/draw.rs` | 帧绘制、光标去重、同步输出、writer 线程 | ratatui、crossterm、xai-ratatui-inline |
| | `render/renderable.rs` | `Renderable` trait | ratatui |
| | `render/{wrapping,line_utils,safe_buf,scrollbar,osc8,bidi}.rs` | 换行、截断、安全写 buffer、滚动条、超链接、双向文本 | textwrap、unicode-width |
| | `render/{image_overlay,video_overlay}.rs` | 终端图片协议 | — |
| | `theme/` | 主题 token、各主题、色深量化、OSC 11 探测 | — |
| | `glyphs.rs` | 所有 chrome glyph 及其回退 | terminal 探测 |
| | `syntax.rs` | syntect 高亮 | syntect、two-face |
| | `terminal/`、`input/key.rs` | 终端品牌识别、能力探测、按键抽象 | crossterm |
| | `modal_window_state.rs`、`search/`、`clipboard/` | 弹窗状态、搜索、剪贴板（OSC 52 等） | — |
| **inline 终端** | `crates/codegen/xai-ratatui-inline` | inline 视口、`insert_before`、resize 清理后重画、flush 返回 dirty | ratatui |
| **文本编辑** | `crates/codegen/xai-ratatui-textarea` | 输入框底层编辑器 | ratatui |
| **Markdown** | `xai-grok-markdown(-core)` | 流式 markdown 转 styled lines，带 checkpoint | pulldown-cmark |
| **Diff** | `xai-grok-pager-diff` | hunk 构建 | similar |
| **业务：外壳** | `P/src/app/event_loop.rs` | 纯 IO 的 select 循环 | tokio |
| | `P/src/app/actions.rs` | `Action`（约 300 个变体）、`Effect`（约 150 个）、`TaskResult` | — |
| | `P/src/app/dispatch/*` | Action 转成状态修改加 Effect，按领域拆成约 25 个子模块 | — |
| | `P/src/app/effects/` | 执行异步 Effect（ACP 调用、文件 IO） | acp |
| | `P/src/app/acp_handler/*` | ACP 通知转成状态修改：会话更新、权限、子代理、队列、hook | acp、tracker |
| | `P/src/acp/tracker.rs` | **`AcpUpdateTracker`**：有状态的流式机器，把 SessionUpdate 转成 scrollback 条目的增改，同时维护 `TurnActivity` | scrollback |
| | `P/src/app/app_view.rs`、`agent_view/*` | 顶层与会话级状态，以及 input、render、panes、modals 等 impl | 下面各 view |
| **业务：消息流** | `P/src/scrollback/state/`（layout、groups、verb_group、nav、selection） | 条目列表、布局缓存、分组、导航 | — |
| | `scrollback/block.rs`、`blocks/*`、`blocks/tool/*` | 每类块的内容与渲染（`RenderBlock`、`ToolCallBlock`） | markdown、diff、theme |
| | `scrollback/wrappers/entry_renderer.rs` | 统一画 rail、bullet、选中框、动画 | — |
| | `scrollback/scrollback_pane.rs`、`sticky.rs`、`search.rs`、`text_selection.rs` | 视口、吸顶、搜索、选择 | — |
| **业务：视图** | `P/src/views/agent.rs` | 纯函数布局 `AgentViewLayout`、hit-test、`build_hints` | — |
| | `views/prompt_widget/` | 输入框 | textarea |
| | `views/{slash_dropdown,completion_dropdown,file_search,history_search}` | 补全与搜索 | nucleo |
| | `views/{permission_view,question_view,plan_approval_view,elicitation_view,rewind}` | 阻塞卡片 | — |
| | `views/{status_bar,agent_status,context_bar,turn_status,shortcuts_bar,status_line}` | 各状态栏位 | — |
| | `views/{tasks_pane,todo_pane,queue_pane,dock,timeline,btw_overlay}` | 各 pane | — |
| | `views/{modal_window,modal,picker,overlay,overlay_list}` | 通用弹窗与列表（业务 crate 里的半通用原语） | — |
| | `views/{welcome,dashboard,settings_modal,session_picker,…}` | 各整屏或弹窗页面 | — |
| **快捷键** | `P/src/actions/`（`ActionRegistry`） | **单一事实源**：同一张表同时驱动按键分发、shortcuts bar 提示和命令面板 | — |
| **Minimal 模式** | `M/`（commit、live、overlay、reprint……） | 通过函数指针 hook 注入（`P/src/minimal_hook`），避免循环依赖 | pager |

### 5.2 事件怎么流到 UI

```
agent 进程（xai-grok-shell）
   │  JSON-RPC over leader IPC / stdio
   ▼
LeaderBridge（P/src/acp/leader_bridge.rs）──► acp_rx channel
   │
event_loop select!（ACP 分支只在 input_rx 为空时读，避免流式输出把按键饿死）
   │
acp_handler::handle(...)  ──►  AcpUpdateTracker.handle_update()   ──► ScrollbackState 增改条目
   │                              （流式指针：当前 agent 消息、thinking、pending tool calls）   │
   │                                                                                       ▼
   ├──► AgentView 字段（todo、permission_queue、models、context、bg_tasks……）      dirty_heights 标记
   ▼
AppView::draw() → AgentView::draw() → 各 widget.render(area, buf) → draw_frame（cell diff + 同步输出）
```

用户输入方向：`crossterm Event → AppView::handle_input → key_owner 决定谁接收 → ActionRegistry.lookup(key, context) → Action → dispatch → Vec<Effect> → effects::run（spawn）→ TaskResult → dispatch`。

**ACP 标准 SessionUpdate**（pager 里按引用次数排序）：`ToolCall`、`ToolCallUpdate`、`AgentMessageChunk`、`UserMessageChunk`、`CurrentModeUpdate`、`AvailableCommandsUpdate`、`Plan`（进 todo pane）、`AgentThoughtChunk`、`UsageUpdate`。

**xAI 扩展 SessionUpdate**（`S/src/extensions/notification.rs:501`），按主题分组：

| 主题 | 变体 |
|---|---|
| turn 生命周期 | `ResponseStarted`、`ReasoningCompleted`、`ResponseCompleted`、`TurnCompleted`、`RetryState`、`AutoRecoveryStarted/Exhausted`、`ToolCallDeltaChunk` |
| 上下文 | `AutoCompactStarted/Completed/Failed/Cancelled`、`CompactionCheckpoint`、`RewindMarker` |
| 子代理与任务 | `SubagentSpawned/Progress/Finished`、`TaskCompleted`、`TaskBackgrounded`、`BackgroundTasks`、`ScheduledTaskCreated/Fired/Deleted`、`MonitorEvent`、`WorkflowUpdated`、`GoalUpdated` |
| 交互 | `PendingInteraction`、`InteractionResolved`、`PlanKept/Cleared/Executing`、`DiffReview`、`FeedbackRequest` |
| 模型 | `ModelAutoSwitched`、`ModelChanged` |
| 记忆 | `MemoryFlush*`、`MemoryCaptureActivity`、`MemoryDream*`、`MemorySessionSaved`、`MemoryFiles` |
| 扩展 | `HookAnnotation`、`HookRunStarted`、`HookExecution`、`HooksChanged`、`PluginsChanged`、`PluginUpdatesInstalled` |
| 会话 | `SessionStatus`、`SessionSummaryGenerated`、`SessionRecap(Unavailable)`、`LastTurnSummary`、`RelaySyncStatus`、`AutoContinueCompleted` |
| 媒体 | `ImageCompressed`、`ImageDropped` |

**`TurnActivity`**（驱动 turn status 和 tab 标题）：`Thinking`、`Responding`、`ToolRunning{title, description}`、`AutoCompacting`、`Retrying{attempt, max_retries, reason}`……（`P/src/acp/tracker.rs:222`）。

### 5.3 消息流的渲染与缓存

来源：`P/src/scrollback/state/layout.rs`、`entry.rs`、`blocks/markdown_content.rs`、`xai-grok-markdown/src/streaming.rs`。

1. **两阶段测量**：第一遍对所有条目用廉价的 `estimate_height`（不渲染 markdown）。然后只对视口内和附近的条目精确测量（`settle_visible_measurements`、`warm_measure_pages_above`），测完重新锚定滚动位置。
2. **前缀和定位**：`virtual_y` 存每个条目的纵向起点。`compute_paint_window` 用 `partition_point` 二分查找，**只绘制可见条目**。
3. **增量更新**：`dirty_heights` 只重测改过的条目，再用 `patch_virtual_y_for_dirty` 修补定位。
4. **流式 markdown**：在顶层 checkpoint（标题、段落加空行、代码块、列表、表格）处冻结，之前的部分只换行一次，每个 chunk 只重渲 tail。未闭合的代码块会续用 syntect 的逐行状态。
5. **缓存**：每个条目有 `cached_output`（key 是宽度、模式、选中状态、cwd）和 `cached_line_widths`。离视口远的条目用 `evict_wrap_cache` 释放。
6. **吸顶**：只有用户消息会吸顶，效果类似 iOS 列表头，被下一条推走（`MIN_PINNED_HEIGHT = 4`）。吸顶头下方有 `▲` 跳转指示，scrollback 底部有 `▼` 表示下方还有内容（`P/src/scrollback/sticky.rs`）。

---

## 6. 好看好用在哪里，哪些能搬到 pi-tui

前提：pi-tui 的组件接口是 `render(width): string[]`，inline 差分渲染。以下关于 pi-tui 的判断**只基于这个前提**，pi-tui 的具体实现我没读过。

### 6.1 具体设计点

| # | 设计点 | 为什么好 | 源码依据 | 移植到 pi-tui |
|---|---|---|---|---|
| 1 | **按行栈布局，可选行不出现就连同间隔一起消失**。scrollback 是唯一的弹性区，最少 5 行；矮屏按阈值逐级砍掉装饰 | 屏幕永远整齐，矮终端也不挤 | `P/src/views/agent.rs:174-407`、`L86-99` | **易**。live 区按固定顺序拼接行数组即可 |
| 2 | **提示框的元信息写在边框上**：底边放 `模型(effort) · 权限模式 · multiline`，顶边放标题或 `Stashed`，plan 模式边框变金色 | 不多占一行，一眼看清当前模式 | `prompt_widget/mod.rs` 约 L3040-3372；`render.rs:713` | **易**。边框行本来就是字符串，拼进去即可 |
| 3 | **Turn status 只在运行时出现**：`spinner 活动… 阶段时长 ⋯ 总时长 ⇣tokens [stop]`，活动文字来自 `TurnActivity`（`Run <cmd>`、`Search <q>`、`Waiting on subagent…`） | 用户随时知道 agent 在干什么、干了多久 | `P/src/views/turn_status.rs`；`P/src/acp/tracker.rs:222` | **易**。`[stop]` 可点需要鼠标，pi-tui 可以不要 |
| 4 | **阻塞卡片占用提示框位置**，而不是弹窗或插进消息流。`┃` rail 加底色；数字键直选；拒绝那一行可以直接打字当反馈；Esc 不拒绝，只让出焦点 | 视线不用跳；误按 Esc 不会误拒；拒绝附带理由很顺手 | `render.rs:2330-2750`；`permission_view.rs:1436-1532`；`key_owner.rs` | **易**，最值得抄。pi-tui 里就是"卡片组件代替输入框组件" |
| 5 | **工具块三态折叠加按类型定默认值**：agent 的 bash 默认折叠，用户 bash 结束后展开，Read 显示头 5 尾 3，thinking 结束后折叠成 `Thought for 2.0s` | 消息流干净，重要的才展开 | `P/src/scrollback/blocks/tool/*.rs`；`blocks/thinking.rs` | **中**。截断规则容易搬。但 inline 模式下已进 scrollback 的块改不了，"事后展开"只能靠 grok minimal 的办法：`/expand` 重新打印一份 |
| 6 | **动词分组**：连续只读工具合并成 `Read 2 files, Searched 1 pattern`，超过 10 项显示 `◈ N more` | 大量探索性调用只占一行 | `P/src/scrollback/state/verb_group.rs` | **易到中**。在"块还没提交"的阶段合并即可；一旦提交就不能再合并 |
| 7 | **状态由 rail 和 bullet 的颜色表达**：运行中是紫色波浪，完成闪 400ms 绿色，失败红色，折叠时变暗 | 不用读文字就能扫出状态 | `entry_renderer.rs` 约 L689、840-890；`state/types.rs:75` | **静态颜色易**。波浪和闪烁只能在 live 区做，提交后就不动了 |
| 8 | **markdown 去标记**：隐藏 `#`、`**`、代码围栏，只保留颜色、粗体和底色；`-`→`•`、`>`→`│`、`---`→`───` | 看起来像排版过的文档，不像源码 | `xai-grok-markdown/src/render.rs:640-675`、`parse.rs` | **易** |
| 9 | **流式 markdown checkpoint 冻结**加换行缓存 | 长回答流式输出时 CPU 不会随长度增长 | `xai-grok-markdown/src/streaming.rs`、`checkpoint.rs`；`markdown_content.rs` | **易**，思路与语言无关。对 `render(width)` 模式尤其有用：冻结部分的 `string[]` 直接缓存 |
| 10 | **diff 不用 +/- 列，只用行底色和彩色行号**，hunk 间显示 `… N unchanged lines` | 视觉上更轻，复制代码不会带上符号 | `tool/edit.rs`；diff 快照 | **易**。需要 truecolor 底色；16 色终端要退化 |
| 11 | **单一 ActionRegistry**：一张表同时驱动按键、shortcuts bar 提示（按上下文过滤、按优先级排序、窄屏时裁剪但保留 pinned 项）和命令面板 | 提示永远与实际按键一致，改键不会漏改 | `P/src/actions/mod.rs` 文件头；`agent.rs:671 build_hints` | **易**，而且是架构层面的收益 |
| 12 | **语义主题 token + 色深量化 + glyph 回退**：所有颜色走语义槽，自动降到 256 或 16 色；所有 glyph 都有等宽的 ASCII 替身 | 各种终端下都不出豆腐块、不串色 | `R/src/theme/*`；`R/src/glyphs.rs` | **易** |
| 13 | **绘制卫生**：同步输出包帧、光标命令去重（保住闪烁）、无动画时零唤醒、resize 去抖 16ms、ACP 读取让位给输入 | 不闪、不卡、省电 | `R/src/render/draw.rs`；`app_view.rs:245`；`event_loop.rs` | **易到中**。同步输出和去抖可以直接搬；"无动画零唤醒"要看 pi-tui 的 tick 模型（未验证） |
| 14 | **排队与插话**：运行中按 Enter 进队列，队列可编辑、排序、立即发送；turn status 提示 `N queued, Enter to send now` | 不用等 agent 跑完就能继续下指令 | `queue_pane.rs`；`dispatch/queue.rs`、`interject.rs` | **易**（前提是 Pi SDK 支持排队或打断，属于 Pi 那侧的问题） |
| 15 | **Minimal 模式的 committed frontier**：连续的已定稿前缀才提交，等用户输入的块永不提交，两侧块间距一致防止跳动，resize 后重印 | 原生 scrollback 与 live 区之间不会错位 | `M/src/commit.rs is_committable`；`M/src/live.rs` | **高度相关**，几乎就是 pi-tui 需要的规则 |
| 16 | **终端集成**：tab 标题带 spinner 和 `⚠ Action Required`；OSC 9;4 进度条；OSC 52 复制并备份到文件 | 切到别的窗口也知道 agent 的状态 | `P/src/notifications/title.rs`、`progress.rs` | **易**，都是转义序列 |
| 17 | **提示框细节**：`[Pasted: N lines]` 原子 chip、草稿暂存、双击 Esc 清空（带暂存可撤销）、`!` bash 和 `#` 记忆模式切前缀、启动 type-ahead 回放 | 输入手感好，误操作可撤销 | `prompt_widget/mod.rs`；`prompt_stash.rs`；`event_loop.rs` | **易到中** |

### 6.2 依赖它自身技术栈、不易移植的部分

| 能力 | 为什么难 | 依据 |
|---|---|---|
| **应用自管的全屏 scrollback**：虚拟滚动、逐块选中和折叠、事后展开或收起任意历史块、吸顶用户消息、timeline rail、`▲/▼` 跳转 | 前提是 alt screen 加 cell buffer 能重画任意位置。inline 模型下历史归终端所有，印出去就改不了。grok 自己在 minimal 模式里也放弃了这些（`/find /jump /timeline` 只在全屏可用） | `P/src/scrollback/*`；`04-slash-commands.md:160` |
| **浮在内容上的弹窗和下拉**（ModalWindow 90% 宽、`Clear` 背景、点外面关闭） | ratatui 可以在同一个 buffer 上后画覆盖、按 Rect 定位。`render(width): string[]` 是按行往下排，覆盖需要合成层。grok minimal 的做法是 live 视口临时变高，把下拉放在提示框**下方**（`M/src/overlay.rs`）。pi-tui 有没有 overlay 能力**未验证** | `modal_window.rs`；`agent_view/mod.rs:1696` |
| **鼠标交互**：点击 `[stop]`、`[✗]`、`[↗]`、`⧉`，悬停高亮，拖选，hit-test | 需要 mouse capture；inline 模式开了 capture 就会破坏终端原生选择和滚动，grok minimal 也是关掉的 | `P/src/views/agent.rs:49-80 PaneAreas`；`P/src/app/mod.rs` 的 `MOUSE_CAPTURE_ENABLED` |
| **已提交块上的动画**（rail 波浪、完成闪烁） | 只能在 live 区里动 | `entry_renderer.rs` |
| **图片、视频、Mermaid 覆盖层** | 依赖终端图片协议，并要在 flush 后、同步帧内画（`PostFlush`） | `R/src/render/image_overlay*`；`draw.rs:500` |
| **Dashboard、子代理全屏接管、设置页等整屏页面** | 本质上是另一个全屏视图。inline 下只能用"清屏后重画"或 alt screen 临时进入来模拟 | `P/src/views/dashboard/`；`render.rs:659` |
| **规模** | 光 pager 就 53.6 万行 Rust，大量代码在处理各终端的怪癖（kitty 协议协商、tmux、Zellij、ConHost、VS Code 快捷键冲突） | `P/src/terminal*`、`P/src/app/*_filter.rs` |

**一句话**：grok 的"好看"大多是**排版和状态表达的规则**（第 1 到 12 条），与 ratatui 无关，可以原样搬到 `render(width): string[]`。"好用"里跟全屏 scrollback 绑定的那部分（选中、折叠历史、吸顶、鼠标、浮层）搬不过去。可以参照的范本是 grok 自己的 **minimal 模式**，它就是 xAI 在 inline 约束下的取舍，见 `M/`。

---

## 未验证与存疑

- 提示框底边信息靠左还是靠右：截图是靠右，源码描述是左侧 model、右侧 multiline，**未验证**，可能是版本差异。
- 列表 bullet：截图是 `·`，源码是 `•`，差异原因**未验证**。
- `P/README.md` 的 "Esc 取消 turn" 与 user-guide 和测试矛盾，本文以后两者为准。
- elicitation 卡片布局、取消确认面板的具体文案、编辑类权限卡片里是否内嵌 diff：**未验证**。
- Minimal 模式单块 2000 行截断的脚注文字：**未验证**。
- 欢迎页菜单的引导线字符、header 在运行时的完整排布（credits 项在何处加入）：**未验证**。
- 所有关于 pi-tui 能力的判断（overlay、tick 模型）：**未验证**，交给调研 Pi 的 agent 核对。
  - 核对结果（见 research-pi-tui.md 1.4、5）：pi-tui 0.83 有 overlay（`tui.showOverlay`，按行列合成进主帧）；0.84 起有全屏模式 `TuiAltScreen` 与 `ScrollView`、`MouseRegion`。
