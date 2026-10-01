# Pi InteractiveMode 功能清单与 grok-build 对照

日期：2026-09-29。只读调研，没改代码。目的：MMP 要写一个 grok-build 风格的新 TUI，替换 Pi 的 `InteractiveMode`，保留 Pi 的 SDK 层。本文列出 `InteractiveMode` 负责的全部事情，标出哪些能复用、哪些要重写、哪些可以不要。

## 0. 来源与记号

| 记号 | 指向 |
|---|---|
| `IM:行` | Pi `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（上游 main `cb7969d`，2026-09-28，版本 0.87.1，6,888 行） |
| `C/x.ts` | 同目录 `components/`（45 个文件，合计 10,188 行） |
| `ca/` | `packages/coding-agent/src/` |
| `tui/` | `packages/tui/src/`（pi-tui，另一个 npm 包） |
| `P/` `R/` `M/` | grok-build（commit `f0e3be1`）的 `crates/codegen/xai-grok-pager/`、`-pager-render/`、`-pager-minimal/` |

行数都是 `wc -l`，含注释和空行。"约 N 行"是按方法起止行号相减得到的。

**复用列的三种取值**（依据 `ca/index.ts` 的导出列表，`package.json` 的 `exports` 只有 `.`、`./rpc-entry`、`./client`、`./experimental/plugin`，深路径 import 会被 Node 拒绝）：
- **E**：从包入口导出，MMP 可以直接 import。
- **M**：有独立模块，但没导出。要用只能复制一份到 MMP（vendor）。
- **I**：写在 `interactive-mode.ts` 里的私有方法，必须重写。
- 另有 **T**：在 pi-tui 包里并且导出（`TuiAltScreen`、`ScrollView`、`VStack`、`Editor`、`CombinedAutocompleteProvider`、`MouseRegion` 等），可以直接用。

**级别列**：**必** = 没有它就不是能用的编码 agent；**选** = 有用但可以晚做；**丢** = 建议不做。这是我的判断，第 5 节说理由。

## 1. 先说边界：替换 InteractiveMode 不只是替换这 6,888 行

我自己核对的事实：
- `main()` 的参数只有 `{ extensionFactories? }`（`ca/main.ts:562-564`），`InteractiveMode` 在 `ca/main.ts:938` 直接 `new`，没有注入点。
- 所以 MMP 不能再调用 `main()` 走交互模式，必须自己调用 `createAgentSessionRuntime`（E），然后自己完成 `main.ts` 在创建 `InteractiveMode` 之前做的事。

| main.ts 在交互模式前做的事 | 位置 | 复用 |
|---|---|---|
| 参数解析 | `parseArgs`，`ca/cli/args.ts`（458 行） | E |
| `pi auth ...` 子命令 | `runAuthCommand`，`ca/main.ts:575` | M |
| 首次运行向导（选主题等） | `ca/main.ts:661-662` → `ca/cli/startup-ui.ts:182 showFirstTimeSetup`，组件 `C/first-time-setup.ts`（148） | M |
| 启动时的项目信任提问 | `ca/main.ts:704-760`，`resolveProjectTrusted`（`ca/core/project-trust.ts`，96） | M |
| 会话 cwd 丢失时的提问 | `ca/main.ts:556`，用 `showStartupSelector` | M |
| `pi -r` 启动时的会话选择器 | `ca/main.ts:416` → `ca/cli/session-picker.ts`（55），复用 `SessionSelectorComponent` | M（组件 E） |
| 创建 SessionManager / runtime / 内置 llama.cpp 扩展 | `createSessionManager` `ca/main.ts:357`（M）；`createAgentSessionRuntime` `ca/main.ts:849`（E）；`builtInExtensions` `ca/extensions/index.ts`（M） | 混合 |

`main()` 合计 985 行。MMP 需要其中的哪些，取决于 MMP 自己的 CLI 设计，不在本文范围。**这是替换方案的第一笔固定成本。**

`./experimental/plugin`（`ca/experimental/plugin.ts`，16 行）只导出 `AgentController`、`PresentationUI`、`SlashCommands` 三个实验性服务，也没有替换交互模式的口子。而且 `package.json` 的 `files` 排除了 `dist/experimental` 和 `dist/client`，npm 包里根本没有这些代码。

**上游自己也在做"换掉 InteractiveMode"的实验**，可以当参照：`ca/experimental/client-tui.ts`（804）+ `client-tui-chat.ts`（184），配合 client/server 服务拆分（`ca/experimental/services/README.md`）。它直接复用了这些模块：`createChatViewport`、`createInteractiveTui`、`CustomEditor`、`InteractiveThemeController`、`getEditorTheme/setRegisteredThemes`、`UserMessageComponent`、`AssistantMessageComponent`、`ToolExecutionComponent`、`WorkingStatusIndicator`、`createAllToolRenderers`（`client-tui.ts:24-31`、`client-tui-chat.ts:3-9`）。这份清单正好就是"新 TUI 最少需要的展示层零件"，其中一半在 npm 包里没导出（下文记为 M）。同目录还有 `micro/tui.ts`（567）、`mini/tui/view.ts`（555）两个更小的实验 TUI（这两个没细看）。client-tui 的斜杠命令只有 model、thinking、compact、reload 和示例 hello（README 表格 `SlashCommands` 行），不是完整替代。

另一个可参照的"非 InteractiveMode 宿主"是 RPC 模式：`ca/modes/rpc/rpc-mode.ts:136-318` 用约 180 行实现了 `ExtensionUIContext` 的全部 28 个成员，其中 `custom()`、`setFooter`、`setHeader`、`setEditorComponent`、`setWorkingIndicator` 都是空实现。这是"扩展能跑、但不支持 TUI 定制"的最低线。

## 2. Pi InteractiveMode 功能清单

### 2.1 启动与头部

| 功能 | 实现位置 | 行数 | 复用 | 级别 |
|---|---|---|---|---|
| 构造：建 TUI、各容器、默认编辑器、footer、主题控制器 | `IM:572-637` | 65 | I | 必 |
| `init()`：挂载组件树、先启动 TUI 再绑扩展（让 `session_start` 能弹框）、启动期间只接受 Ctrl+C/Ctrl+D | `IM:904-1079`（挂载 `IM:929-951`） | 175 | I | 必 |
| 等待终端报告颜色（DA1 或 100ms 超时）再画 header | `IM:965`；`theme/theme-controller.ts:25-41 requestTerminalColors` | — | M | 选 |
| 内置 header：logo + 版本 + 快捷键提示，Ctrl+O 展开完整帮助 | `IM:969-1034`，`C/pi-logo.ts`、`C/keybinding-hints.ts`（`keyHint` E） | 65 | I | 丢（MMP 已有自己的启动页） |
| 已加载资源清单（context 文件、skills、prompts、extensions、诊断，按 scope 分组） | `showLoadedResources` `IM:1712-1910` + 路径格式化 `IM:1328-1711` | 580 | I | 丢或极简 |
| 确保 `fd`/`rg` 存在（缺了就下载），期间显示状态 | `IM:1038-1042`；`ensureTool`（`ca/utils/tools-manager.ts`） | — | M | 必（`@` 补全和 grep 依赖） |
| 后台刷新模型目录（15s 超时） | `IM:1100-1106`；`refreshModelCatalogs`（`model-catalog-refresh.ts`，51） | 51 | M | 必 |
| 新版本提示、扩展包更新提示、tmux extended-keys 检查、安装遥测 | `IM:1109-1135`、`1213-1280`、`1309`、`4498-4552` | 约 150 | I | 丢 |
| What's New / changelog（新会话才显示） | `IM:805-833`、`1282-1307`；`/changelog` `IM:6542-6565` | 约 80 | I | 丢 |
| 启动诊断、凭据迁移警告、models.json 错误、模型回退提示、上次崩溃提示、Anthropic 订阅计费警告 | `IM:1147-1178`、`5129-5158` | 约 60 | I | 必（前四项） |
| 初始消息（CLI 传入的 prompt 和 `@file` 图片）与主循环 | `IM:1180-1210`（主循环 `IM:1201`） | 30 | I | 必 |
| 终端标题 `pi - 会话名 - 目录` | `IM:1082-1094` | 13 | I | 选 |

### 2.2 聊天记录渲染

事件到组件的映射在 `handleEvent` `IM:3299-3681`（约 390 行），历史回放在 `addMessageToChat` / `renderSessionItems` / `renderSessionEntries` `IM:3733-3978`（约 245 行）。两者都是 I，**必须重写**，是替换方案里最核心的一块。

| 消息类型 | 创建位置 | 组件（行数，复用） | 级别 |
|---|---|---|---|
| 用户消息（带 OSC 133 提示区标记，全屏模式靠它跳转上一条/下一条提示） | `IM:3801-3840` | `C/user-message.ts`（70，E） | 必 |
| skill 调用块（可折叠）+ 附带的用户消息 | `IM:3807-3826`；`parseSkillBlock`（E） | `C/skill-invocation-message.ts`（64，E） | 必 |
| 助手消息流式更新；thinking 块显隐、隐藏时的占位文字 | `message_start/update/end` `IM:3392-3491` | `C/assistant-message.ts`（202，E） | 必 |
| 工具调用：参数流式时就建卡片，`tool_execution_*` 更新结果，`message_end` 时 `setArgsComplete`（edit 此时才算 diff），abort/error 时把未完成的卡片全标红 | `IM:3416-3538` | `C/tool-execution.ts`（433，E），含 Kitty 图片转换、`MouseRegion` | 必 |
| 7 个内置工具的 renderCall/renderResult | `IM:2134` 调 `withBuiltInRenderers` | `ca/core/tools/renderers/*.ts`（8 文件 1,058 行，**M**）。内置工具定义本身不带渲染器（`ca/core/tools/bash.ts` 里没有 `renderCall`），不 vendor 这 1,058 行，内置工具卡片就只有兜底样式 | 必 |
| `!` / `!!` 用户 bash（流式输出；agent 运行时先放到待发区，下次提交时移入聊天） | `handleBashCommand` `IM:6766-6858`；`flushPendingBashComponents` `IM:4724-4735`；先发 `user_bash` 事件给扩展拦截 | `C/bash-execution.ts`（220，E） | 必 |
| 扩展自定义消息 `pi.sendMessage` | `IM:3771-3783` | `C/custom-message.ts`（113，E），渲染器来自 `registerMessageRenderer` | 必（MMP 自己的扩展会用） |
| 扩展条目 `pi.appendEntry`（插在流式消息前面） | `addCustomEntryToChat` `IM:3733-3753` | `C/custom-entry.ts`（62，M） | 必 |
| 压缩摘要；压缩完成后清空聊天区，按时间顺序重排保留的条目并插入摘要 | `compaction_end` `IM:3573-3623`；`entry_appended` 的 compaction 分支 `IM:3355-3378` | `C/compaction-summary-message.ts`（68，E） | 必 |
| 分支摘要 | `IM:3792-3797` | `C/branch-summary-message.ts`（67，E） | 必（留 `/tree` 就要） |
| 错误、警告、状态行；连续状态行原地更新 | `showError/showWarning` `IM:4486-4496`；`showStatus` `IM:3711-3731` | `ThemedText`（32，M） | 必 |
| 自动重试 / 压缩 / 摘要重试的状态指示，Esc 临时改成中止对应操作 | `IM:3559-3680` | `C/status-indicator.ts`（123，M） | 必 |
| 缓存未命中、thinking 块被丢弃、压缩计费提示 | `IM:3980-4076` | I | 丢 |
| 未信任项目的警告行 | `IM:4095-4114` | I | 选 |
| 全局展开/折叠（Ctrl+O）、thinking 显隐（Ctrl+T） | `IM:4420-4457` | I，依赖组件的 `setExpanded` | 必 |
| Mermaid 代码块转图 | `C/mermaid.ts`（89，M），注入在 `IM:2138` | M | 丢 |

### 2.3 编辑器与输入

| 功能 | 实现位置 | 行数 | 复用 | 级别 |
|---|---|---|---|---|
| 多行编辑、kill ring、undo、历史（`addToHistory`，`tui.editor.historyPrevious`）、大段粘贴折叠（>10 行或 >1000 字符） | `tui/components/editor.ts`（2,472；历史 L427、L860；粘贴 L720、L1259-1310） | 2,472 | T | 必 |
| 应用快捷键分发、Esc 在补全打开时让给补全、Ctrl+D 只在空编辑器退出、边框里嵌 working 状态 | `C/custom-editor.ts`（148） | 148 | E | 必 |
| 快捷键表（`app.*` 约 45 个动作，可配置） | `ca/core/keybindings.ts`（401），`KeybindingsManager` | 401 | E | 必 |
| 按键到动作的绑定 | `setupKeyHandlers` `IM:2960-3029` | 70 | I | 必 |
| Esc 的多重含义：运行中→把排队消息放回编辑器并 abort；bash 运行中→中止 bash；bash 模式→退出；空编辑器双击→`/tree` 或 `/fork` | `IM:2963-2989` | 27 | I | 必 |
| Ctrl+C 清空、500ms 内两次退出；Ctrl+D 空编辑器退出 | `IM:4139-4151` | 13 | I | 必 |
| `/` 命令补全（内置 + prompt 模板 + 扩展命令 + `skill:*`，`/model` `/thinking` `/login` 带参数补全） | `createBaseAutocompleteProvider` `IM:687-785`；扩展叠加 `IM:787-803` | 115 | I（Provider 本身 T） | 必 |
| `@` 文件补全（fd 遍历，遵守 .gitignore） | `tui/autocomplete.ts`（860，L148 起） | — | T | 必 |
| Ctrl+V 粘贴：先试剪贴板里的文件路径，再试图片（写临时文件、插入路径），最后纯文本；右键粘贴 | `IM:3031-3085`；`readClipboardImage/Text`（M） | 55 | I | 必 |
| 图片进入对话 | 编辑器提交时主循环只调用 `session.prompt(text)`，不带 images（`IM:1201-1209`）；粘贴的图片只作为路径文本插入（`IM:3068-3076`）。只有 CLI 初始消息带 `initialImages`。路径怎么变成图片内容**未核实**，推测靠 read 工具 | — | — | 选 |
| bash 模式：以 `!` 开头时边框变色 | `IM:3016-3022`、`4379-4388` | 20 | I | 选 |
| 提交分发：内置命令 if 链 → `!` bash → 压缩中排队 → 运行中按 steer 排队 → 正常提交 | `setupEditorSubmitHandler` `IM:3092-3291` | 200 | I | 必 |
| 排队：Enter=steer，Alt+Enter=follow-up，Alt+Up 把所有排队消息取回编辑器；压缩期间另有一个本地队列，压缩结束后按规则冲刷 | `IM:4338-4377`、`4554-4723` | 210 | I | 必 |
| 外部编辑器（Ctrl+G）：停 TUI、开 `$EDITOR`、回填 | `IM:4459-4479`；`external-editor.ts`（46，M） | 67 | I+M | 选 |
| 扩展快捷键（`registerShortcut`），给处理函数构造 `ExtensionContext` | `setupExtensionShortcuts` `IM:2145-2203` | 60 | I | 必 |

### 2.4 状态区、footer、工作指示

| 功能 | 实现位置 | 行数 | 复用 | 级别 |
|---|---|---|---|---|
| footer：cwd、git 分支、会话名、↑↓RW token、缓存命中率、费用、上下文占比（按占用变色）、模型和 thinking 档位、多 provider 时显示 provider、扩展状态行 | `C/footer.ts`（253，E）；数据 `ca/core/footer-data-provider.ts`（类 M，只导出了 `ReadonlyFooterDataProvider` 类型） | 253 | E+M | 必 |
| 工作指示：spinner + 文案，默认嵌在编辑器上边框；扩展可改文案、显隐、帧 | `IM:2204-2300` | 95 | I | 必 |
| 编辑器边框颜色随 thinking 档位变化 | `IM:4379-4388` | 10 | I | 选 |
| 排队消息显示（`Steering:` / `Follow-up:` + 提示） | `updatePendingMessagesDisplay` `IM:4586-4603` | 18 | I | 必 |
| 终端进度条 OSC 9;4（turn 开始/结束、压缩时） | `IM:3318-3320`、`3541-3543`、`3560-3576`；`terminal.setProgress`（T） | — | T | 选 |

### 2.5 内置斜杠命令

列表来自 `ca/core/slash-commands.ts`（`BUILTIN_SLASH_COMMANDS`，M，24 条）；另有 3 条隐藏命令只在 if 链里（`/debug`、`/arminsayshi`、`/dementedelves`）。分发全部在 `IM:3092-3246`。

| 命令 | 打开什么 | 处理函数 | 行数 | 组件（行数，复用） | 级别 |
|---|---|---|---|---|---|
| `/model [q]` | 精确匹配就直接切换，否则打开模型选择器（Ctrl+L 同） | `IM:5061-5119`、`5210-5246` | 95 | `C/model-selector.ts`（421，E） | 必 |
| `/scoped-models` | 可多选、可排序的模型范围编辑器，用于 Ctrl+P 轮换；打开时刷新目录 | `IM:5247-5368` | 120 | `C/scoped-models-selector.ts`（401，E） | 选 |
| `/thinking [lvl]` | 有参数直接设，否则打开档位选择器 | `IM:5012-5060` | 50 | `C/thinking-selector.ts`（154，E） | 必 |
| `/settings` | 约 40 项设置的列表和子菜单，改动立即生效（含切换 inline/全屏） | `IM:4772-5011` | 240 | `C/settings-selector.ts`（972，E）+ `settings-submenu.ts`（258，M） | 选 |
| `/login [provider]` | 认证方式选择 → provider 选择 → OAuth 对话框（浏览器链接、设备码、手动粘贴）或 API key 输入；登录后若当前没模型则自动选默认模型 | `IM:5657-6197` | 540 | `C/oauth-selector.ts`（214，E）、`C/login-dialog.ts`（233，E） | 必 |
| `/logout` | provider 选择器 | `IM:5689-5699`、`5847-5905` | 70 | 同上 | 必 |
| `/new` | 新会话 | `IM:6694-6708` → `runtimeHost.newSession()` | 15 | — | 必 |
| `/resume` | 会话选择器（当前目录/全部、搜索、排序、重命名、删除），cwd 丢失时再问一次 | `IM:5577-5656` | 80 | `C/session-selector.ts`（1,045，E）+ `session-selector-search.ts`（194，M） | 必 |
| `/tree` | 会话树（折叠、标签、5 种过滤、复制），选中后问"是否总结分支"，可写自定义提示 | `IM:5428-5576` | 150 | `C/tree-selector.ts`（1,435，E） | 选 |
| `/fork` | 选一条历史用户消息 → 新会话，原文回填编辑器 | `IM:5369-5406` | 38 | `C/user-message-selector.ts`（155，E） | 选 |
| `/clone` | 在当前位置复制会话 | `IM:5407-5427` | 20 | — | 选 |
| `/compact [指令]` | 手动压缩（进度和结果走事件） | `IM:6859-6868` | 10 | — | 必 |
| `/export [path]` | 导出 HTML 或 JSONL | `IM:6288-6334` | 45 | `session.exportToHtml/Jsonl` | 选 |
| `/import <path>` | 确认框 → 替换当前会话 | `IM:6335-6378` | 45 | — | 选 |
| `/share` | 上传到 Radius 或私有 gist，期间显示可取消的 loader | `IM:6379`；`session-share.ts`（217，M） | 217 | `BorderedLoader`（E） | 丢 |
| `/bug [描述]` | 同意书 → 可选摘要 → 上传给 Pi 开发者 | `IM:6390`；`bug-report.ts`（298，M） | 298 | — | 丢（报给 Pi 不合适） |
| `/copy` | 复制最后一条助手消息（全屏下优先复制选区，Ctrl+X 同） | `IM:6405-6435` | 30 | `copyToClipboard`（E） | 必 |
| `/name [名字]` | 设置或显示会话名 | `IM:6436-6460` | 25 | — | 选 |
| `/session` | 会话文件、ID、消息数、token、按模型的费用明细、缓存浪费 | `IM:6461-6541` | 80 | — | 选 |
| `/hotkeys` | 当前生效的全部快捷键表 | `IM:6566-6693` | 130 | — | 选 |
| `/trust` | 项目信任选择器，保存后要重启生效 | `IM:5185-5209` | 25 | `C/trust-selector.ts`（134，E） | 选 |
| `/reload` | 重载快捷键、扩展、skills、prompts、主题、context 文件；期间编辑器位置显示提示框 | `IM:6198-6287` | 90 | — | 必（MMP 刚修过相关 bug） |
| `/quit` | 退出 | `IM:3233-3237` → `shutdown` | — | — | 必 |
| `/changelog` | 显示更新日志 | `IM:6542-6565` | 24 | — | 丢 |
| `/debug`（隐藏；Shift+Ctrl+D 同） | 把渲染行和消息写进 `pi-debug.log` | `IM:6709-6741` | 33 | — | 选 |
| `/arminsayshi`、`/dementedelves`、daxnuts | 彩蛋 | `IM:6742-6765` | 24 | `C/armin.ts` 382 等 | 丢 |

所有选择器都通过 `showSelector` `IM:4736-4771` 放进编辑器所在的位置，关闭时还原编辑器。

### 2.6 会话操作背后的 SDK 调用

这些逻辑都在 SDK 里，新 TUI 只需要调用并在完成后重画聊天区：`runtimeHost.newSession / fork(entryId, {position}) / switchSession / importFromJsonl`、`session.navigateTree / compact / abort / abortCompaction / abortRetry / abortBranchSummary / exportToHtml / exportToJsonl / setModel / cycleModel / cycleThinkingLevel / setScopedModels / executeBash / recordBashResult / prompt(text, {streamingBehavior}) / steer / followUp / clearQueue / reload`。会话切换后 SDK 回调 `setRebindSession`（`IM:581-584`），UI 要清空重画并重新绑扩展（`rebindCurrentSession` `IM:2020-2045`、`renderCurrentSessionState` `IM:2116-2132`）。

### 2.7 模型与 thinking 轮换

| 功能 | 实现位置 | 复用 | 级别 |
|---|---|---|---|
| Ctrl+P / Shift+Ctrl+P 轮换模型（有 scoped models 时只在范围内） | `IM:4401-4418` → `session.cycleModel` | I（很薄） | 必 |
| Shift+Tab 轮换 thinking 档位 | `IM:4390-4399` → `session.cycleThinkingLevel` | I（很薄） | 必 |

### 2.8 登录

认证协议全部在 SDK：`session.modelRuntime.login(providerId, "oauth"|"api_key", {signal, prompt, notify})`（`IM:6150-6160`）。UI 只负责三件事：
1. 选 provider 和认证方式（`IM:5746-5905`）。
2. 把 `notify` 事件（`auth_url`、`device_code`、`info`、progress）和 `prompt` 请求（select、manual_code、文本）画出来（`IM:6080-6148`，`C/login-dialog.ts`）。
3. 登录后刷新模型目录、没有模型时选 provider 的默认模型（`completeProviderAuthentication` `IM:5907-6002`，约 95 行，含 llama.cpp、radius 特例）。

### 2.9 项目信任

- 启动时的信任提问不在 `InteractiveMode`，在 `main.ts`（见第 1 节）。
- `InteractiveMode` 里有：`/trust` 选择器；未信任时的警告行（`IM:4095`）；切换到别的目录的会话时，把 `select/confirm/input/notify` 交给信任流程（`createProjectTrustContext` `IM:2522-2535`）；`/reload` 后若项目新出现 `.pi` 目录就自动保存信任（`IM:5159-5183`）。

### 2.10 扩展 UI 宿主（`ExtensionUIContext`）

实现在 `createExtensionUIContext` `IM:2537-2592`，各方法的实现分布在 `IM:2204-2958`，合计约 750 行，全部 I。**MMP 内嵌的 MCP 面板依赖 `ctx.ui.select`，所以这一块必留。**

| 成员 | 实现 | 行数 | 级别 |
|---|---|---|---|
| `select` / `confirm` / `input` / `editor`：替换编辑器位置，支持 `signal` 中止和 `timeout` 倒计时 | `IM:2594-2767`；`C/extension-selector.ts`（117）、`extension-input.ts`（94）、`extension-editor.ts`（141），均 E | 175 | 必 |
| `notify` → 状态/警告/错误行 | `IM:2848-2857` | 10 | 必 |
| `custom(factory, {overlay, overlayOptions, onHandle})`：非 overlay 时替换编辑器，overlay 时 `showOverlay` | `IM:2859-2939` | 80 | 必 |
| `setWidget(key, lines 或 factory, {placement})`，编辑器上方或下方 | `IM:2302-2427` | 125 | 必 |
| `setFooter` / `setHeader` | `IM:2428-2494` | 70 | 选 |
| `setEditorComponent`：换编辑器时复制回调、文本、边框、补全、应用快捷键 | `IM:2768-2846` | 80 | 选 |
| `setStatus`、`setWorkingMessage/Visible/Indicator`、`setHiddenThinkingLabel` | `IM:2204-2300` | 95 | 必（前两项） |
| `onTerminalInput`（原始输入过滤，模式切换后要重新挂） | `IM:2496-2520` | 25 | 选 |
| `setTitle`、`pasteToEditor`、`set/getEditorText`、`addAutocompleteProvider`、主题读写、`get/setToolsExpanded` | `IM:2555-2591` | 40 | 必（多数一行转发） |
| 扩展错误显示（错误 + 堆栈） | `IM:2941-2958` | 18 | 必 |
| `bindExtensions` 时传给 SDK 的 `commandContextActions`（`waitForIdle/newSession/fork/navigateTree/switchSession/reload`）、`abortHandler`、`shutdownHandler` | `IM:1911-1987` | 77 | 必 |

### 2.11 终端处理

| 功能 | 实现位置 | 复用 | 级别 |
|---|---|---|---|
| inline（`TuiMainScreen`）与全屏（`TuiAltScreen`）两种渲染器，运行中可切换并保留组件树 | `tui-renderer.ts`（79，M）；`switchTuiMode` `IM:852-902`；`chat-viewport.ts`（46，M：`ScrollView` 放聊天记录，下面固定输入区） | M，底层 T | 必（至少一种） |
| 全屏下的滚动、翻页、跳到上/下一条提示、搜索、拖选复制、点击链接、"跳到最新"提示条、flash 提示 | 全在 `tui/tui-alt-screen.ts`（1,745）、`alt-screen-search.ts`（327），`tui.altScreen.*` 共 14 个按键动作 | T | 选 |
| 退出全屏时把聊天记录打印回主屏 | `stopInteractiveTui` `IM:843-850` | I | 选 |
| resize、差分渲染、同步输出、Kitty 键盘协议、bracketed paste | pi-tui 内部 | T | 必（免费） |
| Ctrl+Z 挂起与恢复 | `handleCtrlZ` `IM:4301-4336` | I | 必 |
| 退出流程：先停 TUI 再发 shutdown 事件，排掉残留的 Kitty 按键释放事件，打印 resume 命令 | `shutdown` `IM:4161-4200` | I | 必 |
| SIGTERM/SIGHUP、终端断开（EIO/EPIPE）紧急退出、未捕获异常时恢复终端 | `IM:4202-4299` | I | 必 |
| 崩溃记录与 `/bug` 提示、扩展堆栈归因 | `IM:2047-2114` | I | 选 |
| 剪贴板读写 | `copyToClipboard`（E）；`readClipboardText/FilePaths/Image`（M） | E+M | 必 |
| 终端内联图片（Kitty/iTerm2） | `tui/terminal-image.ts`（731）、`Image`（T）；工具结果里转换 `C/tool-execution.ts:214` | T | 选 |
| 终端颜色查询（OSC 11 背景色 + 调色板），据此生成 system 主题 | `theme/theme-controller.ts`（253，M）、`theme/system-theme.ts`（636，M） | M | 选 |
| 主题：JSON 主题、文件热更新、`setTheme` | `theme/theme.ts`（1,159，`Theme` 等 E，`onThemeChange`/`setRegisteredThemes`/`getEditorTheme` M） | E+M | 必（最少一套） |

### 2.12 规模汇总（按成本类别）

| 类别 | 内容 | 大约行数 |
|---|---|---|
| 必须自己写的宿主逻辑（I） | 事件映射 390 + 历史回放 245 + 提交分发 200 + 排队 210 + 扩展 UI 宿主 750 + 退出/信号/挂起 200 + 按键 130 | 约 2,100 |
| SDK 薄包装（I，每个 10–90 行） | `/new /compact /clone /export /import /name /copy /quit /model /thinking`、轮换 | 约 350 |
| 选择器接线（I）+ 组件（E） | settings 240+1,230、tree 150+1,435、session 80+1,239、login 540+447、scoped 120+401、model 95+421 | 接线约 1,200；组件可直接用 |
| 需要 vendor 的模块（M） | 内置工具渲染器 1,058、footer 数据 388、状态指示 123、主题控制 253、system 主题 636、tui-renderer/chat-viewport 125、剪贴板读取（未计） | 约 2,600 |
| 建议丢掉 | 资源清单 580、更新/changelog/遥测/tmux 约 230、缓存提示 100、`/share` 217、`/bug` 298、彩蛋 | 约 1,500 |

## 3. grok-build TUI 功能清单

大部分细节已在 [research-grok-build-tui.md](research-grok-build-tui.md) 里（以下简称"grok 笔记"），这里只列清单和出处。

| 类别 | 功能 | 出处 |
|---|---|---|
| 屏幕模式 | Fullscreen（默认）/ Inline（整屏高 inline 视口，UI 同全屏）/ Minimal（定稿块进终端 scrollback） | `P/src/app/mod.rs:347`、`1578-1650`；grok 笔记 1.1 |
| 布局区域 | header 状态栏、tasks pane、todo pane、scrollback、`/btw` 面板、queue pane、turn status、banner、follow-up chips、dock、prompt、status line、shortcuts bar；矮屏逐级隐藏 | `P/src/views/agent.rs:86-99`、`174-407`；grok 笔记 2.1 |
| 聊天块 | 用户消息（底色、`❯`、时间戳、吸顶）、agent markdown、thinking（结束后折叠为 `Thought for Ns`）、工具块三态、动词分组、子代理行、diff 块 | `P/src/scrollback/blocks/*`、`state/verb_group.rs`、`sticky.rs` |
| 提示框 | 圆角框、底边写模型/档位/模式、顶边 `Stashed`、多行模式、`!` `#` 前缀、粘贴 chip、图片 chip、草稿暂存、历史浏览、启动 type-ahead | `P/src/views/prompt_widget/mod.rs`；`agent_view/prompt_stash.rs` |
| turn status | `⠧ 活动… 阶段耗时 ⋯ 总耗时 ⇣tokens [stop]`，空闲时 0 行；空闲但有后台任务时显示 `◎ N still running` | `P/src/views/turn_status.rs`；`P/src/acp/tracker.rs:222` |
| 阻塞卡片 | 权限（范围调整、pattern 编辑）、提问（单选/多选/自由输入）、MCP elicitation、plan 审批、rewind、取消确认；占用提示框位置，有优先级，Esc 不拒绝 | `P/src/views/permission_view.rs`、`question_view.rs`、`elicitation_view/`、`plan_approval_view.rs`、`rewind.rs`；`agent_view/key_owner.rs` |
| 斜杠命令 | 约 60 个，分 shell builtin 和 pager builtin；MRU 排序；skill 自动变命令 | `P/docs/user-guide/04-slash-commands.md`；`P/src/slash/mru.rs` |
| 命令面板 | Ctrl+P / `?`，分组，行尾显示快捷键；带参数的命令进入 ArgPicker（如 `/model` 再选 effort） | `P/src/views/modal.rs:180 ActiveModal`、`385-542` |
| 选择器 | 会话（含深度搜索、foreign sessions、删除）、模型/主题 ArgPicker、设置、历史搜索、文档、agents、memory、扩展、MCP、usage | `P/src/views/session_picker.rs`（1,604）、`picker.rs`（3,970）、`settings_modal/`、`history_search.rs` |
| 快捷键 | 单一 `ActionRegistry` 同时驱动按键、shortcuts bar、命令面板；scrollback 有简单/vim 两套键 | `P/src/actions/`；`P/docs/user-guide/03-keyboard-shortcuts.md` |
| scrollback 导航 | 逐条选中、按 turn 跳、翻页/半页、g/G、timeline rail、`/jump`、`/find` 搜索、Enter 全屏查看块 | `03-keyboard-shortcuts.md:27-86`；`P/src/views/timeline.rs`、`jump.rs`、`scrollback/search.rs` |
| 折叠 | 单块折叠/展开、全部展开、Ctrl+E 全部 thinking、记住手动折叠 | `03-keyboard-shortcuts.md:55-76` |
| 鼠标 | 点击选中条目、滚轮、点击聚焦提示框、悬停高亮、点 `[stop]` 等按钮、X11 中键粘贴 | `03-keyboard-shortcuts.md:414-424`；`P/src/app/mouse.rs`（1,788） |
| 复制 | `y` 复制块、`Y` 复制命令、拖选文本（`drag_select.rs`、`text_selection.rs` 4,242 行）、OSC 52 | `R/src/clipboard/trust.rs:49-57` |
| 排队 | queue pane 可编辑、排序、立即发送（interject） | `P/src/views/queue_pane.rs`；`dispatch/queue.rs`、`interject.rs` |
| 模式 | Shift+Tab 在 Normal/Plan/Auto/Always-approve 间切换 | grok 笔记 4.6 |
| 多会话 | header `‹ 2/3 ›` 切换、Dashboard、子代理全屏接管、worktree | `P/src/views/dashboard/`；`render.rs:659` |
| 主题 | 语义 token、5 个内置主题 + terminal/auto、色深量化、OSC 11 探测、glyph ASCII 回退 | `R/src/theme/*`、`R/src/glyphs.rs`；grok 笔记 3.1-3.2 |
| 终端集成 | tab 标题 spinner 和 `⚠ Action Required`、OSC 9;4、同步输出、resize 去抖 | `P/src/notifications/title.rs`、`progress.rs` |
| 登录 | 浏览器登录、API key、OIDC、外部 provider | `P/docs/user-guide/02-authentication.md`；`P/src/app/dispatch/auth.rs` |
| 外部编辑器 | `/edit-prompt`，minimal 下 Ctrl+G | `P/src/app/external_editor.rs`（663） |
| 其他 | `/btw` 旁路提问、`/doctor`、`/tutorial`、语音输入、`/imagine`、`/loop`、`/goal`、memory | `04-slash-commands.md` 各节 |

## 4. 对照

### 4.1 grok 功能 → Pi 的对应实现

| grok 功能 | Pi 对应（位置） | 说明 |
|---|---|---|
| 三种屏幕模式 | inline `TuiMainScreen` + 全屏 `TuiAltScreen`（`tui-renderer.ts`；`IM:852-902`） | Pi 没有 Minimal 这种"定稿进 scrollback + 底部 live 区"的混合模式，Pi 的 inline 就是整棵树差分重画 |
| 行栈布局、矮屏降级 | `chat-viewport.ts` 的 `VStack`，只有 transcript + dock 两层 | 没有按屏高隐藏装饰的规则 |
| header 状态栏 | 无固定顶栏；Pi 的 header 是聊天记录第一项，会滚走 | 信息在 footer（`C/footer.ts`） |
| 用户消息块 | `C/user-message.ts` | 没有时间戳、吸顶 |
| thinking 折叠 | `C/assistant-message.ts` + Ctrl+T 全局显隐 | 不按耗时折叠，只有全局开关 |
| 工具块三态 | 两态：全局 Ctrl+O 展开/折叠（`IM:4420-4441`）；截断规则在各渲染器 | 没有单块折叠 |
| 动词分组 | 无 | — |
| 子代理行、tasks/todo pane | 无（Pi 核心没有子代理和 todo） | MMP 自己有 `task-agents.ts`，需要自己设计 |
| diff | `C/diff.ts`（147，`renderDiff` E），用于 edit 渲染器 | 有 `+`/`-` 列 |
| 提示框边框信息 | 边框颜色表示 thinking 档位；上边框嵌 working 状态（`C/custom-editor.ts:36-79`） | 模型写在 footer，不在边框 |
| 草稿暂存 Ctrl+S | 无 | — |
| 粘贴 chip | pi-tui Editor 的大段粘贴折叠（`tui/components/editor.ts:1302`） | 等价 |
| 图片 chip | 无；粘贴图片变成临时文件路径文本 | — |
| 历史浏览 / `/history` 搜索 | ↑↓ 历史（pi-tui Editor）；无模糊搜索面板 | — |
| turn status | 工作指示（`IM:2250-2285`）+ 重试/压缩指示（`C/status-indicator.ts`） | 没有阶段耗时、token 速率 |
| 权限卡片 | 无（Pi 核心不做工具审批） | 扩展可用 `ctx.ui.select/custom` 自己做 |
| 提问卡片、elicitation | 扩展 `ctx.ui.select/input/custom`（`IM:2594-2939`） | 样式固定，不在输入框位置之外 |
| plan 审批、Shift+Tab 模式 | 无；Shift+Tab 在 Pi 是切 thinking 档位 | — |
| rewind | `/tree`（`IM:5428`）、`/fork`（`IM:5369`）、双击 Esc | Pi 的更强：保留分支，可选总结 |
| 斜杠命令下拉 | `CombinedAutocompleteProvider`（T）+ `IM:687-803` | 没有 MRU |
| 命令面板 | 无 | `/hotkeys` 只是静态列表 |
| 会话选择器 | `C/session-selector.ts`（1,045） | 没有内容深度搜索、foreign sessions |
| 模型选择 | `C/model-selector.ts`；`/scoped-models` | 没有 effort 子菜单（另有 `/thinking`） |
| 设置 | `C/settings-selector.ts`（972） | 等价 |
| 单一快捷键表 | `KeybindingsManager`（E）驱动按键和 header/`/hotkeys` 提示 | 部分等价，没有随焦点变化的 shortcuts bar |
| scrollback 逐条选中、按 turn 跳 | 全屏下 `tui.altScreen.previousPrompt/nextPrompt`（靠 OSC 133 标记） | 只能按提示跳，不能选中块 |
| `/find` 搜索 | 全屏下 `tui.altScreen.search`（`tui/alt-screen-search.ts`） | 等价 |
| timeline rail、`/jump`、`▲▼` 指示 | "跳到最新"提示条（`tui-renderer.ts` `scrollToEndIndicator`）+ 滚动条 | 部分 |
| 鼠标 | 全屏下滚轮、拖选、链接点击、`MouseRegion`（`docs/tui.md` "Handle mouse input"） | 没有点选条目、悬停 |
| 复制 | `/copy`、Ctrl+X、全屏拖选（copy-on-select 可配）、树选择器里复制 | 没有逐块 `y` |
| 排队可编辑 | steer/follow-up 两种 + Alt+Up 全部取回编辑器（`IM:4338-4377`、`4605-4624`） | 不能单条编辑或立即发送 |
| 多会话 / Dashboard | 无 | — |
| 主题 | JSON 主题 + 终端颜色生成的 system 主题（`theme/system-theme.ts`） | 没有 glyph 回退 |
| tab 标题 / OSC 9;4 | 标题只有会话名和目录（`IM:1082`）；OSC 9;4 有 | 标题不带 spinner |
| 登录 | `/login`（`IM:5657-6197`） | 等价，provider 更多 |
| 外部编辑器 | Ctrl+G（`IM:4459`） | 等价 |
| 挂起 | Ctrl+Z（`IM:4301`） | grok 的 `app/signal_handler.rs` 有 suspend 相关代码，按键绑定未核实 |

### 4.2 grok 没有、Pi 有的功能（MMP 要决定留不留）

| Pi 功能 | 位置 | 建议 |
|---|---|---|
| 会话树 `/tree`、分支摘要、标签 | `IM:5428-5576`；`C/tree-selector.ts` | 留（grok 的 rewind 会丢历史） |
| `/clone`、`/import`、`/export` HTML | `IM:5407`、`6288-6378` | 留，接线便宜 |
| `/share`、`/bug` | `session-share.ts`、`bug-report.ts` | 丢 |
| `/trust` 与信任流程 | `IM:5185`、`2522`；`main.ts:704` | 留（MMP README 依赖 `--approve` 语义，需对齐） |
| scoped models + Ctrl+P 轮换 | `IM:5247`、`4401` | 选 |
| `!!`（不进上下文的 bash） | `IM:3240-3255` | 留，成本几乎为零 |
| 扩展 UI 全套：widget、header/footer/编辑器替换、overlay、自定义消息/条目渲染器、`onTerminalInput` | 第 2.10 节 | 留。MMP 自己的扩展（MCP 面板、hooks）和第三方扩展都靠它 |
| 压缩期间的本地队列 | `IM:4626-4722` | 留（否则压缩时输入会丢或报错） |
| 自动重试指示与 Esc 中止重试 | `IM:3625-3651` | 留 |
| 资源清单、What's New、版本/包更新提示 | 第 2.1 节 | 丢 |
| 缓存未命中 / thinking 丢弃 / 计费提示 | `IM:3980-4076` | 丢或放进 `/session` |
| system 主题（从终端调色板生成） | `theme/system-theme.ts` | 选 |
| OSC 133 提示区标记 | `C/user-message.ts:6-8` | 留（全屏跳转靠它，成本低） |
| inline 作为默认模式 | `settings tuiMode` | 要决定：grok 默认全屏 |

### 4.3 grok 有、Pi 没有的功能

这些 Pi 里找不到对应代码，新 TUI 要做就得从零写：命令面板；随焦点变化的 shortcuts bar；草稿暂存；图片 chip；`/history` 模糊搜索；动词分组；按耗时折叠 thinking；单块三态折叠和选中；吸顶用户消息；timeline rail；turn status 的阶段耗时和 token 速率；阻塞卡片占位（权限、提问、plan 审批）；权限模式循环；queue pane 单条编辑与 interject；tasks/todo pane；多会话切换与 Dashboard；子代理全屏接管；Minimal 模式；glyph ASCII 回退；tab 标题 spinner 和待审批提醒；斜杠命令 MRU；`/btw`。其中权限、plan、todo、子代理、Dashboard 还要求 SDK 那侧有对应的数据，Pi 核心目前没有（推断，没有逐一核对 Pi 事件类型）。

## 5. 必留清单与成本

判断标准：一个人每天拿它写代码，缺了就会卡住或丢数据。行数是"新 TUI 里要写的代码"，按 Pi 现有实现估，能直接 import 的组件不计。

| # | 必留功能 | Pi 位置 | 新写约多少行 | 可复用 |
|---|---|---|---|---|
| 1 | 事件映射 + 流式渲染（用户、助手、thinking、工具、错误、abort 标红） | `IM:3299-3681` | 400 | 组件 E |
| 2 | 历史回放（启动、resume、tree、压缩后重排） | `IM:3733-3978`、`4078-4093` | 260 | 同上 |
| 3 | 内置工具渲染器 | `ca/core/tools/renderers/`（M） | vendor 1,058 或重写 | 否 |
| 4 | 提交分发 + 斜杠命令路由 + `!`/`!!` bash | `IM:3092-3291`、`6766-6858` | 300 | `BashExecutionComponent` E |
| 5 | 排队：steer / follow-up / 取回 / 压缩期队列 | `IM:4338-4377`、`4554-4723` | 210 | 否 |
| 6 | 中止：Esc（abort、中止 bash/压缩/重试/摘要）、Ctrl+C、Ctrl+D | `IM:2963-2989`、`4139-4151`、`3559-3651` | 80 | 否 |
| 7 | 编辑器、历史、粘贴、`/` 和 `@` 补全 | pi-tui `Editor`；`IM:687-803`、`3031-3085` | 200 | T + `CustomEditor` E |
| 8 | footer + 工作指示 + 状态行 | `C/footer.ts`、`IM:2204-2300`、`3711` | 150 | footer E，数据类 M |
| 9 | 登录/登出 | `IM:5657-6197` | 400（UI 流程 + 登录后选模型） | 对话框组件 E |
| 10 | 模型选择、thinking 设置与轮换 | `IM:4390-4418`、`5012-5119`、`5210-5246` | 150 | 选择器 E |
| 11 | `/new`、`/resume`、`/compact`、`/reload`、`/copy`、`/quit` | 见 2.5 | 250 | 会话选择器 E |
| 12 | 扩展 UI 宿主（至少 select/confirm/input/editor/notify/custom/setWidget/setStatus/working）+ `commandContextActions` | `IM:1911-1987`、`2204-2958` | 600 | 三个对话框组件 E |
| 13 | 终端生命周期：退出顺序、信号、EIO 紧急退出、未捕获异常恢复终端、Ctrl+Z | `IM:4161-4336` | 200 | 否 |
| 14 | 启动：挂载、fd/rg、模型目录刷新、诊断、初始消息、主循环 | `IM:904-1210` 的必要部分 | 200 | `ensureTool`/`refreshModelCatalogs` M |
| 15 | main.ts 的交互前流程（参数、信任、首次向导、`-r`） | 第 1 节 | 视 MMP CLI 而定，Pi 里约 400 行相关 | 大多 M |

合计：新写约 3,400 行，另加 vendor 约 1,700 行（工具渲染器 1,058、footer 数据 388、状态指示 123、tui-renderer/chat-viewport 125；2.12 节的 2,600 还含主题控制和 system 主题，那两项是"选"）。这不含 grok 风格的新东西（命令面板、卡片、单块折叠等），也不含第 15 项。

**最贵的几项**：扩展 UI 宿主（约 600，且要保持和 Pi 行为一致，否则第三方扩展出错）；内置工具渲染器（1,058 行没导出，每次 Pi 升级要同步）；登录（约 400，provider 特例多）；事件映射 + 历史回放（约 660，压缩后重排、流式工具卡片的时序容易错）。

**可选（有用但可以第二版做）**：`/settings`（组件可复用，接线约 240）、`/tree` 与分支摘要（组件可复用，接线约 150）、`/fork` `/clone` `/export` `/import` `/name` `/session` `/hotkeys`、全屏模式与滚动/搜索（pi-tui 已有）、外部编辑器、scoped models、setHeader/setFooter/setEditorComponent、system 主题。

**建议丢掉**：资源清单、changelog、版本与包更新提示、遥测、tmux 检查、缓存提示、`/share`、`/bug`、彩蛋、Mermaid。

## 6. 没有核实的

- 编辑器里粘贴的图片路径怎么变成模型能看到的图片：`IM:1201-1209` 提交时不带 images，我推测靠 read 工具读文件，没查 read 工具实现。
- 4.3 节"权限、plan、todo、子代理需要 SDK 侧数据、Pi 没有"：没有逐个核对 Pi 的 `AgentSessionEvent` 类型。
- grok 的 Ctrl+Z 挂起按键：只看到 `signal_handler.rs` 有 suspend 相关代码。
- 各项"新写约多少行"是按 Pi 现有实现推算，不是实测。
- 本文没有读每个组件的内部实现，只读了接口和 `InteractiveMode` 对它们的调用。
