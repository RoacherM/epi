# Pi TUI 架构调研：MMP 重构 Pi TUI 的可行路径

日期：2026-09-29。只读调研，未改 MMP 代码。

## 0. 来源与记号

| 记号 | 实际位置 |
|---|---|
| `[tui@0.83]` | `git clone --branch v0.83.0 https://github.com/earendil-works/pi` 的 `packages/tui/`（本地 `scratchpad/pi-083/packages/tui/`） |
| `[ca@0.83]` | 同一 tag 的 `packages/coding-agent/` |
| `[npm-ca]` | `npm pack @earendil-works/pi-coding-agent@0.83.0` 解包后的 `package/`（本地 `scratchpad/pi-src/earendil-works-pi-coding-agent-0.83.0/package/`） |
| `[main]` | 上游 main，commit `cb7969d`（2026-09-28），coding-agent 与 tui 都是 0.87.1（本地 `scratchpad/pi-repo/`） |
| `[MMP]` | `/Users/byronwayne/Desktop/Projects/sides/mmp` |

行数都用 `wc -l` 数的 TS 源码，含注释和空行。

名词：
- inline 渲染：程序不切换终端"备用屏幕"（alternate screen，全屏程序如 vim 用的那块独立画布），而是像普通命令输出一样往下写，旧内容进入终端的滚动历史（scrollback）。
- overlay：浮在已有内容上面的弹层，不替换底下的内容。
- focus：当前接收键盘输入的那个组件。

## 1. pi-tui 渲染模型（0.83）

### 1.1 Component 接口

```ts
interface Component {
  render(width: number): string[];   // 每行一个字符串，可带 ANSI 颜色；每行可见宽度不得超过 width
  handleInput?(data: string): void;  // 拿到 focus 时收到原始终端输入
  wantsKeyRelease?: boolean;         // Kitty 协议按键抬起事件，默认过滤
  invalidate(): void;                // 清缓存，主题变更时调用
}
interface Focusable { focused: boolean }   // 需要光标/IME 的组件实现，渲染时输出 CURSOR_MARKER
```
来源：`[tui@0.83] src/tui.ts` 的 `Component`、`Focusable`、`CURSOR_MARKER`（第 64–120 行）；`[tui@0.83] README.md` "Component Interface"。

要点：
- 组件只输出"字符串行"，没有盒模型、没有 flex 布局、没有高度概念。`Container.render()` 就是把子组件的行按顺序拼起来（`[tui@0.83] src/tui.ts` `Container.render`，第 280 行）。
- 行宽超了会报错；每行结尾 TUI 自动加 SGR reset，样式不跨行（README "Component Interface" 下方说明）。
- 0.83 没有横向布局原语，左右分栏得自己在字符串层面拼。MMP 启动页就是这么做的（`[MMP] src/startup-page.ts` `splitLine`）。

### 1.2 差分渲染

`TUI extends Container`，本身就是根容器。一帧的流程（`[tui@0.83] src/tui.ts` `doRender`，第 1258 行起）：

```
requestRender() ──(最短间隔 16ms 合批, MIN_RENDER_INTERVAL_MS)──▶ doRender()
  newLines = this.render(width)            // 整棵组件树重新 render 成行数组
  newLines = compositeOverlays(newLines)   // 把 overlay 按行/列覆盖进去
  提取 CURSOR_MARKER 位置 → 行尾加 reset
  和 previousLines 逐行比较，找 firstChanged / lastChanged
  ├─ 首帧：直接输出全部行，不清屏
  ├─ 宽度变了 / 高度变了（Termux 除外）：清屏+清 scrollback（\x1b[2J\x1b[H\x1b[3J）全量重画
  ├─ firstChanged 在当前视口上方：同样全量重画
  └─ 否则：光标移到 firstChanged，从那行往下重写
  整段输出包在同步输出 \x1b[?2026h … \x1b[?2026l 里，防闪烁
```
来源：`[tui@0.83] src/tui.ts` `doRender` 第 1341–1470 行各分支注释；`[tui@0.83] README.md` "Differential Rendering"。

含义：每帧都会重新调用所有组件的 `render()`，性能靠组件自己缓存（README "Caching"）。比较是整行字符串相等比较。

### 1.3 inline 还是全屏

0.83 只有 inline。`[tui@0.83] src/` 里搜不到 `1049`（备用屏幕的转义码）或 alternate screen 相关代码（`grep -n "1049\|alternate" *.ts components/*.ts` 只命中 keys.ts 里 Kitty 键盘协议的 "alternate keys"）。

后果：
- 整个界面是一条从上往下长的行列表：header → 聊天记录 → 编辑器 → footer。编辑器和 footer 看起来"固定在底部"，只是因为它们是最后几行。
- 聊天记录往上滚进终端 scrollback，由终端自己滚动，Pi 无法做应用内滚动、固定顶栏或侧栏。
- 如果改动发生在已滚出视口的行，就触发全量重画并清空 scrollback（上面第三个分支）。

上游 0.84.0 加了全屏模式（见第 5 节）。

### 1.4 Overlay

`tui.showOverlay(component, options) → OverlayHandle`。options 支持 width/minWidth/maxHeight（数字或百分比）、9 种 anchor、offsetX/Y、row/col（绝对或百分比）、margin、`visible(w,h)` 回调、`nonCapturing`。handle 有 `hide / setHidden / isHidden / focus / unfocus({target}) / isFocused`。
实现：overlay 在 `doRender` 里按行列直接覆盖到主内容的行数组上，然后参与同一次差分（`compositeOverlays`，第 1036 行）。为了让 overlay 有"屏幕相对"坐标，主内容会被补到至少终端高度。
来源：`[tui@0.83] src/tui.ts` `showOverlay`（第 495 行）、`OverlayOptions`（第 171 行）；README "Overlays"。

### 1.5 Focus 与输入路由

```
stdin ─▶ StdinBuffer 拆包 ─▶ TUI.handleInput(data)
   1. 吃掉终端回复（OSC 11 背景色、配色方案报告、cell size）
   2. inputListeners 依次过滤：可 consume 或改写 data     ← ctx.ui.onTerminalInput 挂在这里
   3. Shift+Ctrl+D → onDebug
   4. 若焦点在已隐藏的 overlay 上，转给最上层可见 overlay 或原焦点
   5. focusedComponent.handleInput(data) ，然后 requestRender()
```
只有一个焦点组件，没有冒泡。全局快捷键要么在 inputListener 里拦，要么由焦点组件（编辑器）自己分发。
来源：`[tui@0.83] src/tui.ts` `handleInput`（第 765 行）、`setFocus`（第 368 行）。

### 1.6 主题

pi-tui 本身没有主题系统，组件接收各自的 theme 接口（一组 `(s: string) => string` 函数），例如 `EditorTheme`、`MarkdownTheme`、`SelectListTheme`、`SettingsListTheme`、`ImageTheme`（`[tui@0.83] src/index.ts` 导出）。

token 化的主题在 coding-agent 里：`Theme` 类（`[ca@0.83] src/modes/interactive/theme/theme.ts` 第 330 行），方法 `fg(color, text) / bg(bg, text) / bold / italic / underline / inverse / strikethrough / getFgAnsi / getBgAnsi / getThinkingBorderColor / getBashModeBorderColor`。

| 类别 | token（`ThemeColor` / `ThemeBg`，theme.ts 第 109、157 行） |
|---|---|
| 核心 UI | accent, border, borderAccent, borderMuted, success, error, warning, muted, dim, text, thinkingText |
| 消息与工具 | userMessageText, customMessageText, customMessageLabel, toolTitle, toolOutput |
| Markdown | mdHeading, mdLink, mdLinkUrl, mdCode, mdCodeBlock, mdCodeBlockBorder, mdQuote, mdQuoteBorder, mdHr, mdListBullet |
| Diff | toolDiffAdded, toolDiffRemoved, toolDiffContext |
| 语法高亮 | syntaxComment, syntaxKeyword, syntaxFunction, syntaxVariable, syntaxString, syntaxNumber, syntaxType, syntaxOperator, syntaxPunctuation |
| thinking 边框 | thinkingOff … thinkingXhigh, thinkingMax |
| 其他 | bashMode |
| 背景 | selectedBg, userMessageBg, customMessageBg, toolPendingBg, toolSuccessBg, toolErrorBg |

主题文件是 JSON，schema 在 `theme/theme-schema.json`，内置 dark.json / light.json；文档 `[ca@0.83] docs/themes.md`。`getMarkdownTheme()/getSelectListTheme()/getEditorTheme()/getSettingsListTheme()` 把 Theme 转成 pi-tui 组件需要的 theme 接口（theme.ts 第 1230–1286 行）。

注意 MMP 启动时传了 `--no-themes`（`[MMP] src/host.ts` `BASE_PI_RESOURCE_ARGS`），只禁掉外部主题发现；扩展仍可以 `ctx.ui.setTheme(themeObject)` 或 `resources_discover` 返回 `themePaths`（`[ca@0.83] src/core/extensions/types.ts` `ResourcesDiscoverResult`）。后者在 `--no-themes` 下是否仍生效，未验证。

### 1.7 原语组件清单（pi-tui 0.83 导出）

| 组件 | 作用 | 源码行数 |
|---|---|---|
| `Container` | 纵向拼接子组件 | tui.ts 内 |
| `Box` | 带 padding 和背景色的容器 | 137 |
| `Text` / `TruncatedText` | 多行自动换行文本 / 单行截断 | 106 / 65 |
| `Spacer` | 空行 | 28 |
| `Input` | 单行输入 | 447 |
| `Editor` | 多行编辑器，含自动补全、大段粘贴折叠、kill ring、undo | 2351 |
| `Markdown` | Markdown 渲染（基于 marked），代码高亮函数由外部传入 | 858 |
| `Loader` / `CancellableLoader` | 转圈加载 / 可 Esc 取消 | 92 / 40 |
| `SelectList` | 带过滤的列表选择 | 229 |
| `SettingsList` | 设置开关列表 | 250 |
| `Image` | Kitty / iTerm2 内联图片 | 127 |
| 其他 | `CombinedAutocompleteProvider`、`fuzzyFilter`、`KeybindingsManager`、`matchesKey/Key`、`ProcessTerminal`、`visibleWidth/truncateToWidth/wrapTextWithAnsi/sliceByColumn` | |

来源：`[tui@0.83] src/index.ts`；行数 `wc -l [tui@0.83] src/**/*.ts`，pi-tui 合计 12,214 行，其中 `tui.ts` 1719、`keys.ts` 1401、`utils.ts` 1209。

## 2. InteractiveMode 结构（0.83）

### 2.1 屏幕从上到下

`InteractiveMode.init()` 按顺序把容器挂到 TUI 根上（`[ca@0.83] src/modes/interactive/interactive-mode.ts` 第 709–719 行）：

```
┌ TUI (根，inline，整体随内容向下增长) ───────────────────────────┐
│ headerContainer          内置 logo+快捷键提示；ctx.ui.setHeader 替换其中的 header   │
│ loadedResourcesContainer 启动时列出已加载的 context/skills/extensions/诊断         │
│ chatContainer            聊天记录：User/Assistant/ToolExecution/Bash/Custom...     │
│ pendingMessagesContainer 排队中的 steer / follow-up 消息                            │
│ statusContainer          工作中 spinner（WorkingStatusIndicator）、压缩/重试状态   │
│ widgetContainerAbove     ctx.ui.setWidget(..., aboveEditor)                        │
│ editorContainer          默认 CustomEditor；select/confirm/input/custom() 临时替换它│
│ widgetContainerBelow     ctx.ui.setWidget(..., belowEditor)                        │
│ footer                   FooterComponent：cwd、git 分支、token/成本、上下文%、模型；│
│                          ctx.ui.setFooter 整个替换                                 │
└─────────────────────────────────────────────────────────────────────────────┘
  + overlay 栈（ctx.ui.custom(..., {overlay:true})、内置选择器等）
```
容器字段声明在第 324–432 行；创建在构造函数第 459–480 行。TUI 在构造函数里直接 `new TUI(new ProcessTerminal(), ...)`（第 459 行），外部无法注入。

### 2.2 agent 事件 → 组件

`subscribeToAgent()` 订阅 `session.subscribe`，`handleEvent()` 是一个大 switch（第 2855 行起）：

| 事件 | UI 动作 |
|---|---|
| `agent_start` | 清 pendingTools，statusContainer 显示 WorkingStatusIndicator |
| `message_start` user/custom | `addMessageToChat` → `UserMessageComponent` / `CustomMessageComponent`（或扩展的 MessageRenderer） |
| `message_start` assistant | new `AssistantMessageComponent` 挂到 chatContainer，作为 streamingComponent |
| `message_update` | `streamingComponent.updateContent()`；遇到新 toolCall 立即建 `ToolExecutionComponent`（参数流式更新 `updateArgs`） |
| `message_end` | 定稿；aborted/error 时把所有 pending 工具标错；否则 `setArgsComplete()`（edit 工具此时才算 diff） |
| `tool_execution_start/update/end` | 找到对应 ToolExecutionComponent：`markExecutionStarted` / `updateResult(partial)` / `updateResult(final)` |
| `queue_update` | 刷新 pendingMessagesContainer |
| `compaction_*`、`auto_retry_*`、`summarization_retry_*` | statusContainer 换成对应指示器，结束时往 chat 里加摘要组件或错误 |
| `thinking_level_changed` | 刷新 footer 和编辑器边框色 |
| `agent_end` | 清 working 指示器 |

`ToolExecutionComponent` 决定用哪个渲染器：扩展注册的工具定义优先，逐槽位（renderCall / renderResult）回落到内置工具定义；内置 7 个工具的渲染器写在 `[ca@0.83] src/core/tools/{bash,edit,find,grep,ls,read,write}.ts` 的工具定义里，不在 UI 目录。来源：`components/tool-execution.ts` 第 1–112 行；`docs/extensions.md` "Overriding Built-in Tools" 的 Rendering 段。

### 2.3 关键文件（0.83 行数）

| 文件 | 行数 | 说明 |
|---|---|---|
| `modes/interactive/interactive-mode.ts` | 6058 | `InteractiveMode` 单类：布局、事件映射、约 29 个内置斜杠命令（/settings /model /resume /tree /login /reload /compact …，在 `setupEditorSubmitHandler` 里 if 链分发）、扩展 UI 上下文实现、信号处理 |
| `components/*.ts` | 约 9,300 | 40 个组件，大头是 tree-selector 1427、session-selector 1031、config-selector 942、settings-selector 838、tool-execution 377、model-selector 364、footer 245、assistant-message 180 |
| `theme/theme.ts` + `theme-controller.ts` | 1294 + 126 | 主题加载、热更新、Markdown/代码高亮 |
| `main.ts` | 916 | 参数解析、session 选择、`createAgentSessionRuntime`、选择 Interactive/Print/RPC 模式 |
| interactive 目录合计 | 16,753 | `find src/modes/interactive -name '*.ts' \| xargs wc -l` |

## 3. 扩展可定制的 UI 面（0.83）

定义在 `[ca@0.83] src/core/extensions/types.ts` `ExtensionUIContext`（第 131–279 行）；InteractiveMode 的实现是 `createExtensionUIContext()`（interactive-mode.ts 第 2156 行）。

### 3.1 ctx.ui.* 全部方法

| 方法 | 签名要点 | 能做什么 | 边界 |
|---|---|---|---|
| `select` | `(title, options: string[], opts?) → Promise<string\|undefined>` | 选项列表 | 渲染在 editorContainer 位置（替换编辑器），样式固定 |
| `confirm` | `(title, message, opts?) → Promise<boolean>` | 是/否 | 同上 |
| `input` | `(title, placeholder?, opts?) → Promise<string\|undefined>` | 单行输入 | 同上 |
| `editor` | `(title, prefill?) → Promise<string\|undefined>` | 多行编辑 | 同上 |
| `notify` | `(msg, "info"\|"warning"\|"error")` | 在 chat 里插一条提示 | 样式固定 |
| `onTerminalInput` | `(handler) → unsubscribe` | 原始输入过滤，可吞掉或改写 | 挂在 TUI inputListeners，所有组件之前 |
| `setStatus` | `(key, text\|undefined)` | 在内置 footer 里加一段状态文字 | 自定义 footer 需自己从 `footerData` 读 |
| `setWorkingMessage / setWorkingVisible / setWorkingIndicator` | 文案、显隐、帧动画 | 改 streaming 时的 spinner 行 | 位置固定在 statusContainer |
| `setHiddenThinkingLabel` | `(label?)` | 隐藏 thinking 时的占位文字 | |
| `setWidget` | `(key, string[] \| (tui, theme)=>Component, {placement})` | 编辑器上方或下方插组件 | 字符串数组最多 10 行（`MAX_WIDGET_LINES`，第 2008 行）；组件工厂不限 |
| `setFooter` | `((tui, theme, footerData)=>Component) \| undefined` | 整个替换 footer | 仍在最底行的位置 |
| `setHeader` | `((tui, theme)=>Component) \| undefined` | 替换 headerContainer 里的 header | 在最顶部，随聊天滚进 scrollback；不影响下面的 loadedResources 列表 |
| `setTitle` | `(title)` | 终端标题 | |
| `custom<T>` | `(factory(tui, theme, keybindings, done), {overlay?, overlayOptions?, onHandle?}) → Promise<T>` | 任意组件，拿键盘焦点；非 overlay 时替换编辑器位置，overlay 时浮层 | 调用 `done` 关闭；overlay 被文档标为 Experimental |
| `pasteToEditor / setEditorText / getEditorText` | | 操作主编辑器文本 | |
| `addAutocompleteProvider` | `(current => provider)` | 叠加补全 | |
| `setEditorComponent / getEditorComponent` | `(tui, theme, keybindings) => EditorComponent` | 替换主编辑器（vim 模式等） | 想保留应用快捷键需继承 `CustomEditor` 并调用 `super.handleInput` |
| `theme / getAllThemes / getTheme / setTheme` | `setTheme(name \| Theme)` | 读取、切换、传入自建 Theme 对象 | token 集合固定（1.6 节） |
| `getToolsExpanded / setToolsExpanded` | | 工具输出折叠状态 | |

ExtensionAPI 上与 UI 相关的注册方法（types.ts 第 1238–1300 行）：

| 方法 | 作用 | 边界 |
|---|---|---|
| `registerTool({... renderCall, renderResult, renderShell})` | 自定义工具卡片；同名覆盖内置工具时，缺省的槽位沿用内置渲染器 | `renderShell: "self"` 可去掉默认的彩色外框（types.ts 第 465 行） |
| `registerMessageRenderer(customType, (msg, {expanded, outputPad}, theme) => Component)` | 渲染 `pi.sendMessage` 发的自定义消息（进 LLM 上下文） | 只管 custom 消息 |
| `registerEntryRenderer(customType, ...)` | 渲染 `pi.appendEntry` 的条目（不进上下文） | 同上 |
| `registerShortcut(keyId, {handler})` | 快捷键 | 只在主编辑器（默认或 setEditorComponent 换上的）有焦点时生效，弹层或 custom() 组件拿焦点时不触发（`defaultEditor.onExtensionShortcut` 第 1834 行，自定义编辑器转发见第 2430 行）；与 `restrictOverride: true` 的内置键冲突时被跳过（`[ca@0.83] src/core/extensions/runner.ts` `getShortcuts` 第 493 行） |
| `registerCommand(name, {handler, getArgumentCompletions})` | 斜杠命令 | 内置命令在 InteractiveMode 里先匹配，同名冲突有诊断（`getBuiltInCommandConflictDiagnostics`） |

### 3.2 扩展 API 改不了的东西

以下没有对应的 API，只能改 Pi 源码或绕过（依据：`ExtensionUIContext` 全部方法如上，InteractiveMode 字段均为 private）：

| 改不了 | 原因 |
|---|---|
| 布局顺序与结构（比如把 footer 放顶部、加侧栏、左右分栏） | 容器在构造函数里写死（第 709–719 行） |
| 用户消息、助手消息、thinking 块的渲染 | `UserMessageComponent`、`AssistantMessageComponent` 由 InteractiveMode 直接 new（第 2920、3326 行），没有渲染钩子；只有 `setHiddenThinkingLabel` |
| loadedResources 启动清单、What's New、各种系统提示样式 | InteractiveMode 私有方法 |
| 内置选择器（/model /resume /tree /settings /login）的外观 | 私有方法里 new 组件 |
| 渲染模型（inline → 全屏、应用内滚动） | pi-tui 0.83 不支持 |
| 主题 token 集合 | `ThemeColor` 是封闭联合类型 |

### 3.3 绕过口子（非公开契约）

`setHeader / setFooter / setWidget / custom` 的工厂都会拿到 `tui` 实例本身（interactive-mode.ts 第 1954、2065、2096、2506 行），而 `Container.children` 是 public 数组（`[tui@0.83] src/tui.ts` 第 257 行）。所以扩展技术上可以直接改 `tui.children`，重排甚至替换整个根布局。这不是文档化的 API，InteractiveMode 内部还持有这些容器的引用并会继续往里加东西，升级时随时会坏。

另一个口子是 prototype patch：`AssistantMessageComponent`、`UserMessageComponent`、`ToolExecutionComponent`、`InteractiveMode` 都从包入口导出（4.1 节），扩展可以改它们的 `prototype.render / updateContent`。社区里改消息区样式的扩展都靠这个（第 6 节）。同样不是公开契约。

## 4. 下沉路径与规模

### 4.1 Pi 公开了什么

`[npm-ca] package.json` 的 `exports` 只有 `"."` 和 `"./rpc-entry"`，所以只能用 `dist/index.d.ts` 里导出的符号，深路径 import（如 `@earendil-works/pi-coding-agent/dist/core/...`）会被 Node 拒绝（`ERR_PACKAGE_PATH_NOT_EXPORTED`，Node 行为，本次未实际运行验证）。

`[npm-ca] dist/index.d.ts` 与 UI 相关的导出：

| 类别 | 导出 |
|---|---|
| 运行时 | `createAgentSessionRuntime`、`AgentSessionRuntime`、`createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSession`、`SessionManager`、`SettingsManager`、`main` |
| 模式 | `InteractiveMode`（+`InteractiveModeOptions`）、`runPrintMode`、`runRpcMode`、`RpcClient` |
| 组件 | `AssistantMessageComponent`、`UserMessageComponent`、`ToolExecutionComponent`、`BashExecutionComponent`、`CustomMessageComponent`、`CompactionSummaryMessageComponent`、`BranchSummaryMessageComponent`、`SkillInvocationMessageComponent`、`CustomEditor`、`FooterComponent`、`DynamicBorder`、`BorderedLoader`、`ExtensionEditorComponent/InputComponent/SelectorComponent`、`ModelSelectorComponent`、`SessionSelectorComponent`、`TreeSelectorComponent`、`SettingsSelectorComponent`、`ThemeSelectorComponent`、`ThinkingSelectorComponent`、`OAuthSelectorComponent`、`LoginDialogComponent`、`UserMessageSelectorComponent`、`ShowImagesSelectorComponent`、`renderDiff`、`keyHint/keyText/rawKeyHint`、`truncateToVisualLines` |
| 主题 | `Theme`、`ThemeColor`、`initTheme`、`getMarkdownTheme`、`getSelectListTheme`、`getSettingsListTheme`、`highlightCode`、`getLanguageFromPath` |
| 扩展 | `ExtensionRunner`、`ExtensionUIContext` 等类型、`ReadonlyFooterDataProvider`（仅类型） |

没导出的：`StatusIndicator` 系列、`FooterDataProvider` 实现、`InteractiveThemeController`、`getEditorTheme`、`theme` 单例、`CustomEntryComponent`、`TrustSelectorComponent`、`ScopedModelsSelectorComponent`、`BUILTIN_SLASH_COMMANDS`、`cache-stats`、`model-resolver`、`trust-manager`、`usage-totals` 等。`interactive-mode.ts` 的 import 里有约 25 个这种内部模块（见该文件头部 import 列表）。

### 4.2 三条路径

```
路径 A  扩展 API          MMP ──main(args,{extensionFactories})──▶ Pi main ─▶ InteractiveMode(Pi 的)
                                         └─ 扩展里 setHeader/setFooter/setWidget/custom/renderers
路径 B  自建宿主+复制 IM   MMP ──createAgentSessionRuntime──▶ runtime ─▶ MmpInteractiveMode(复制改造)
路径 C  自研 TUI          MMP ──createAgentSessionRuntime──▶ runtime ─▶ session.subscribe ─▶ MMP 自己的 UI
                                                                    └─ 必须自己实现 ExtensionUIContext
路径 D  外部前端(RPC)     MMP 前端进程 ──spawn── pi --mode rpc（JSONL）  ← 列出供对照
```

| | A 扩展 API | B 复制 InteractiveMode | C 自研（仍用 pi-tui） | C' 自研（换 Ink 等） | D RPC 外部前端 |
|---|---|---|---|---|---|
| 能改什么 | header、footer、编辑器上下方 widget、编辑器本身、工具卡片、自定义消息、弹层、主题配色 | 全部布局与内置组件 | 全部 | 全部，含布局引擎 | 全部（另起进程） |
| 改不了 | 布局顺序、用户/助手消息、内置选择器、inline 模型 | pi-tui 渲染模型（0.83 仍 inline） | —— | —— | `custom()` 返回 undefined，`setHeader/setFooter/setEditorComponent/setWorkingMessage` 等为 no-op（`[ca@0.83] docs/rpc.md` 第 1154–1156 行） |
| 需要复制/接管 | 无 | `interactive-mode.ts` 6058 行 + 未导出的内部依赖（约 25 个模块，数千行，未逐一计数）；或者用绝对路径绕过 exports 直接 import dist 内部文件 | `main.ts` 中的启动逻辑（参数、session 选择、模型解析，916 行里的相当部分）+ 事件映射 + 29 个内置命令里想保留的那些 + 一份 `ExtensionUIContext` 实现 | 同左，且 pi-tui 组件（Editor 2351、Markdown 858）和 Pi 导出的消息/工具组件都不能直接用 | 前端全部自写；Pi 进程逻辑不动 |
| 对第三方扩展的兼容 | 完全兼容 | 兼容（需保留 `createExtensionUIContext`） | 要自己实现 `ctx.ui.custom` 等并返回 pi-tui 组件，才能兼容 | 扩展的 `custom()`、`renderCall/renderResult`、`setWidget` 返回的都是 pi-tui `Component`，Ink 里无法直接挂 → 大面积不兼容 | 同左，TUI 类方法降级 |
| 升级成本 | 低（ExtensionUIContext 0.83→0.87.1 未变，见第 5 节） | 高：每次升级要把上游 6000+ 行的改动合进来；0.87.1 已是 6888 行 | 中：跟着 `AgentSessionEvent` 和 `ExtensionUIContext` 走；0.84 起 `TUI` 从类变成接口，要改构造 | 中：只跟事件与扩展接口 | 低到中：跟 RPC 协议 |
| MMP 新增代码粗估 | 几百到一两千行 | 起步即 6000+ 行（复制），加改动 | 3,000–6,000 行（我的估算：事件映射约 400、布局与状态 500–1000、ExtensionUIContext 约 500、启动与 session 选择约 500、再加想保留的命令和选择器；选择器可复用 Pi 导出组件） | 5,000–10,000 行（我的估算：编辑器、Markdown、差分都得换成 Ink 生态，并放弃扩展 UI 兼容） | 与 C' 相近，另加进程管理 |

依据：InteractiveMode 构造函数自建 TUI 且字段全 private（interactive-mode.ts 第 323–480 行）；`bindCurrentSessionExtensions()` 显示自建宿主必须传入 `uiContext`、`commandContextActions`（newSession/fork/navigateTree/switchSession/reload）、`shutdownHandler`、`onError`（第 1637–1712 行）；`docs/sdk.md` "createAgentSessionRuntime() and AgentSessionRuntime" 说明 session 替换后要重新 subscribe 和 `bindExtensions`。

MMP 现有依赖里，内嵌的 `pi-mcp-adapter@2.17.0` 用了 `ui.custom(` 3 处（mcp-panel.ts、mcp-setup-panel.ts）、`ui.select(` 9 处、`ui.setStatus(` 10 处，并有 `tool-result-renderer.ts`（`npm pack pi-mcp-adapter@2.17.0` 后 grep）。所以 C' 和 D 会直接让 MCP 面板失效。

### 4.3 我的判断（推断，非来源结论）

- 想做的改动如果主要是"启动页 + 底部状态栏 + 编辑器外框 + 工具卡片 + 配色 + 若干弹层"，路径 A 就够，且风险最低。社区的 Grok 风格扩展 pi-grok-tui 就是纯路径 A（第 6 节）。
- 用户/助手消息的样式如果也要改，社区做法是"路径 A + prototype patch"（3.3 节）。能做，但每次升级 Pi 都要回归，且 0.84 起内部改成惰性 Proxy 引用后，部分 patch 写法会无限递归（第 6 节 pi-cc-extensions 的注释）。
- 想做的改动如果涉及"固定顶栏/侧栏、应用内滚动、重排消息样式"（全屏式 TUI 通常如此），0.83 的 A、B、C 都受 inline 渲染限制；更现实的顺序是先升到 0.84+ 用上游全屏模式和新布局原语（VStack/HStack/ScrollView），再看 A 是否够用，不够再走 C（仍用 pi-tui，保住扩展兼容）。
- B（复制 6000 行 InteractiveMode）维护成本最高，不建议。
- C'（换 Ink）会丢掉整个 Pi 扩展 UI 生态的兼容性，除非 MMP 愿意只支持自己的扩展。

## 5. 版本风险：0.83.0 → 0.87.1

（本节由并行子任务对比两版源码与 CHANGELOG 得出，关键点已抽查：`[main] packages/tui/src/tui.ts` 第 453 行 `export interface TUI`、`tui-main-screen.ts` 第 124 行 `class TuiMainScreen`、`tui-alt-screen.ts` 第 197 行 `class TuiAltScreen`；`[main] interactive-mode.ts` 第 585–600 行 `createInteractiveTui` 和 `documentContainer`；`[main] docs/settings.md` 第 78 行 `tuiMode`。）

| # | 变化 | 对 MMP 的影响 | 来源 |
|---|---|---|---|
| 1 | `ExtensionUIContext` 两版一致（只差一行注释）；`ToolDefinition`、`ToolRenderContext`、`MessageRenderer`、`ExtensionContext` 逐字相同 | 路径 A 迁移无成本 | 两版 `core/extensions/types.ts` diff |
| 2 | ExtensionAPI 只增不减：`registerMarkdownTransformer()`（0.84.0）、`ui_prompt_start/end` 事件、`registerVirtualModel`；`pi.on()` 返回取消订阅函数（0.86.0） | 新能力 | types.ts diff；coding-agent CHANGELOG 0.84.0 / 0.86.0 |
| 3 | pi-tui 0.84.0：`TUI` 从类变成 `interface TUI extends Component`，实现拆成 `TuiMainScreen`（常规）与 `TuiAltScreen`（全屏，实现 `ViewportTUI`）。`new TUI(...)` 不再可用。CHANGELOG 未标为 Breaking | 只用 ctx.ui 不受影响；路径 B/C 在 0.83 写的代码升级要改 | `[main] tui/src/tui.ts:453`、`tui-main-screen.ts:124`、`tui-alt-screen.ts:197`；tui CHANGELOG 0.84.0 |
| 4 | pi-tui 0.84.0 新增 `VStack`、`HStack`、`ScrollView`、`MouseRegion`、颜色工具、`renderLatex` 等；删除导出 `parseOsc11BackgroundColor`。pi-tui 源码从 12,214 行涨到 19,025 行 | 全屏布局有了现成积木 | 两版 `tui/src/index.ts`（114→185 行）；`wc -l` |
| 5 | pi-tui 0.85.0 Breaking：去掉 pi-tui 读取 coding-agent 环境变量的默认值（硬件光标、clear-on-shrink 改为构造参数），`PI_DEBUG_REDRAW` 改名 `PI_TUI_DEBUG_REDRAW` | 只影响自己构造渲染器的一方 | tui CHANGELOG 0.85.0 |
| 6 | 0.84.0 新增全屏模式：`--tui-mode fullscreen` 或 settings `tuiMode`。全屏时聊天记录在 ScrollView 里滚动，底部固定 pending、status、widgets、editor、footer。header 放在 `documentContainer` 里，会随聊天滚走，不固定 | MMP 启动页在全屏模式下的表现需实测 | `[main] interactive-mode.ts:596-603`；`modes/interactive/chat-viewport.ts`；`docs/usage.md:86` |
| 7 | 0.85.0 起 working 指示器移进默认编辑器边框；0.86.0 起压缩/重试 spinner 也移进去。自定义编辑器要设 `CustomEditorOptions.embedWorkingStatus` | 替换编辑器时要知道 | CHANGELOG 0.85.0 / 0.86.0；`[main] components/custom-editor.ts` |
| 8 | `InteractiveMode` 构造签名不变；options 新增 `tuiMode`、`initialThemeSetting`、`terminal`、`startupDiagnostics`。interactive-mode.ts 6058→6888 行，未拆分 | 路径 B 的维护负担在变大 | 两版 `InteractiveModeOptions` diff |
| 9 | coding-agent `index.ts` 导出只增不删（新增 `CustomEditorOptions`、`ThemeToken/ThemeBg/ThemeStyle/ThemeAppearance`）；主题新增可选 token `scrollbarThumb`、`scrollbarTrack` 等 | 稳定 | 两版 index.ts diff；CHANGELOG 0.84.0 / 0.84.4 |
| 10 | main 新增 client/protocol/server 等包，正式 InteractiveMode 不引用它们；只用在 `src/experimental/`（client-tui、mini、micro），0.85.1 起不进 npm 包 | 目前不影响；将来可能出现"TUI 通过 socket 连 server"的架构 | interactive-mode.ts import；coding-agent package.json `files`；CHANGELOG 0.85.1 |
| 11 | 与 UI 无关但自建宿主会碰到：0.87.0 `SessionEntry` 多 `context_edit`、`ExtensionEvent` 多 `agent_before_settle`；0.84.0 JSON/RPC 的 `message_update` 只发增量；0.86.0 `user_bash` 出错即中止 | 路径 C/D 的事件 switch 要补分支 | coding-agent CHANGELOG 0.84.0 / 0.86.0 / 0.87.0 |

结论：扩展 UI API 在 0.83→0.87.1 之间稳定；底层 pi-tui 渲染类在 0.84 有未标注的破坏性变化，并新增了全屏模式。docs/pi-community-extensions.md 已指出社区扩展普遍要求 ^0.84.0，这是又一个升级理由。

## 6. 社区已有的 Pi TUI 重做

方法：并行子任务查 pi.dev/packages、npm（关键词 pi-package）、GitHub、BubblePtr/awesome-pi，克隆了主要项目读源码（本地 `scratchpad/comm/`、`scratchpad/cc-ext/`）。星标与最后推送时间是 2026-09-29 用 `gh api repos/<owner>/<repo>` 查的。我抽查了 pi-grok-tui 的 README 原文和 pi-cc-extensions 里的 prototype patch 测试文件。

结论：没找到"以扩展形式完整重做 Pi 终端界面"的项目，也没找到用 Ink/React 或基于 RPC 在终端里重写 Pi 前端的项目。做法分四类：

- A：只用公开的 ctx.ui 插槽换外框（header、footer、editor、widget）。数量最多。
- B：A 之外再 patch Pi 内部组件的 prototype，这是改消息区和工具卡的唯一办法。
- C：用 SDK 的 `createAgentSessionRuntime` 做 Web / 桌面前端，不走终端。
- D：整体 fork Pi。

| 项目 | 星 / 最后推送 | 类 | 用到的 API / 做法 | 要求 Pi |
|---|---|---|---|---|
| [lawrencewzen/pi-grok-tui](https://github.com/lawrencewzen/pi-grok-tui) | 0 / 08-17 | A | Grok 风格。setHeader、setFooter、setEditorComponent(继承 CustomEditor)、setWorkingIndicator、setWorkingMessage、setStatus。README 第 30 行："nothing forked, nothing patched. What that API doesn't reach stays pi's: the message stream, the tool boxes, the syntax highlighting." 约 1,173 行 | ≥0.84 |
| [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui) | 104 / 09-25 | A | setHeader、setFooter、setEditorComponent、custom、setHiddenThinkingLabel；源码无 prototype | ≥0.85 |
| [nicobailon/pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) | 449 / 09-27 | A | setWidget(20 处)、setHeader、setFooter、setEditorComponent、onTerminalInput、setTitle | ≥0.81 |
| @narumitw/pi-statusline（[narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) 628★ / 09-26） | — | A | 只换 footer：setFooter、setStatus、custom | 0.87.1 |
| [tomsej/pi-ext](https://github.com/tomsej/pi-ext) | 78 / 09-03 | A | custom(7 处，浮层)、setWidget、setFooter、registerShortcut、onTerminalInput | ^0.82 |
| [minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) | 109 / 09-29 | A+B | 插槽之外 patch `ToolExecutionComponent`、`AssistantMessageComponent`、`Container`、`InteractiveMode.prototype.handleBashCommand`、`TuiMainScreen.prototype.applyLineResets`；用 `Symbol.for("pi.ccstyle.prototype-original")` 记录原方法，有 `tests/runtime-patch-isolation.test.ts`、`tests/lazy-proxy-regression.test.ts` | ^0.84.0 |
| [lmilojevicc/pi-zentui](https://github.com/lmilojevicc/pi-zentui) | 98 / 09-28 | A+B | setEditorComponent、setFooter；自建 prototype-patch-registry，patch `UserMessageComponent`、`AssistantMessageComponent` 的 render / updateContent | ≥0.80.5 |
| [danielcherubini/pi-archimedes](https://github.com/danielcherubini/pi-archimedes) | 134 / 09-28 | A+B | custom(9)、setWidget、setHeader、setFooter；patch `AssistantMessageComponent.prototype.updateContent` | 未验证 |
| [timvdhoorn/cc-my-pi](https://github.com/timvdhoorn/cc-my-pi) | 3 / 08-10 | A+B | patch ToolExecutionComponent、AssistantMessageComponent、`Container.prototype` | ^0.84 |
| [MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display) | 293 / 07-03 | A+B | registerTool 同名覆盖 7 个内置工具只换渲染；patch UserMessageComponent | ^0.80.3 |
| [agegr/pi-web](https://github.com/agegr/pi-web) | 6,913 / 09-23 | C | Web 前端，createAgentSessionRuntime + SessionManager | 0.87.1 |
| [minghinmatthewlam/pi-gui](https://github.com/minghinmatthewlam/pi-gui) | 1,045 / 09-29 | C | Electron，自写 `packages/pi-sdk-driver` 走 SDK | ^0.87 |
| [jmfederico/pi-web](https://github.com/jmfederico/pi-web) | 828 / 09-28 | C | Web；接入方式未验证 | 未验证 |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | 33,672 / 09-29 | D | README 自称 "Fork of Pi"，自带 TUI | 已分叉 |
| [XMoon/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui) | 19 / 09-29 | 其他 | 把 pi-tui 复制进自己仓库改，给别的 harness 用，不是 Pi 的界面 | — |

只看了包名和描述、未读源码（未验证）：npm 上的 pi-pretty-tui、pi-beautiful-tui、@runecraft/pi-tui、pi-sidebar-tui、pi-claude-code-tui；桌面前端 Jaxton07/percho(377★)、FaqFirebase/pi-desktop(259★)、DLYZZT/pi-desktop(242★)。benvinegar/opentui-island(7★) 是把 OpenTUI 组件嵌进 Ink 和 pi-tui 的桥，不是重写。

要点：

1. 公开 API 只能改外框：header、footer、editor、widget、working 行、状态栏、浮层。消息流、工具卡外框（除 registerTool 覆盖）、thinking 显示都要 patch prototype。这和第 3.2 节从源码得出的结论一致。
2. setHeader、setFooter、setEditorComponent 各只有一个槽位，最后加载的扩展生效（pi-grok-tui README 第 46 行）。MMP 若自带外框扩展，会和用户装的同类扩展互相覆盖；MMP 的 manifest 可以在装配时检测并报错。
3. 全屏是 Pi 0.84 自带功能（`TuiAltScreen`），不是 pi-cc-extensions 做的；后者在全屏上加了点击展开、hover，并 patch `TuiMainScreen` 修普通模式下 scrollback 被反复清空的问题。它的注释提到 0.84+ 的 tui 引用改成惰性 Proxy（`createInteractiveTuiReference`），"先捕获方法再包一层"的 patch 会无限递归。
4. 与用户喜欢的 Grok 风格最接近的是 pi-grok-tui：只用公开 API、约 1,200 行、要求 Pi ≥0.84。MMP 在 0.83 上不能直接装，但写法可照搬。
5. 所有外框类扩展都要求 Pi ≥0.84 或 ≥0.85，和 docs/pi-community-extensions.md 第 5 节"0.84.0 成了分水岭"的判断一致。

## 7. 未验证 / 没做的

- `--no-themes` 下扩展通过 `resources_discover.themePaths` 注册主题是否生效。
- 深路径 import 被 `exports` 拦截：按 Node 规则推断，没实际运行。
- 路径 B 需要复制的内部模块总行数没有逐一计数；路径 C / C' 的行数是我的估算，不是测量。
- 0.84+ 全屏模式下 MMP 启动页（setHeader）的实际表现，没有运行。
- 社区表中标"未验证"的项目。
