# Pi 0.87.1 SDK 公开面审计：MMP 自建交互 TUI 能直接用什么

日期：2026-09-29。只读调研，未改 MMP 代码。目标：MMP 用自己的 TUI 替换 Pi 的 `InteractiveMode`（第 4 层），保留 pi-ai / pi-agent-core / pi-coding-agent 的 `AgentSession`、runtime、extension runtime。

## 0. 来源、记号与前提

| 记号 | 位置 |
|---|---|
| `ca/` | `scratchpad/pi-repo/packages/coding-agent/src/`（上游 main，commit `cb7969d`，package.json 写 0.87.1） |
| `tui/` | `scratchpad/pi-repo/packages/tui/src/` |
| `agent/`、`ai/` | `packages/agent/src/`、`packages/ai/src/` |
| `npm/` | `npm pack @earendil-works/pi-coding-agent@0.87.1` 与 `pi-tui@0.87.1` 解包后的 `package/dist/`（`scratchpad/npm087/`） |
| `[MMP]` | `/Users/byronwayne/Desktop/Projects/sides/mmp` |

「导出」= 出现在包的公开入口里。coding-agent 的 `exports` 只有 `"."`（`dist/index.js`）、`./rpc-entry`，以及两个只有 `source` 条件的 `./client`、`./experimental/plugin`；`files` 还排除了 `dist/client`、`dist/experimental`（coding-agent `package.json` 的 exports 与 files 字段）。所以 **deep import（如 `.../dist/core/tools/renderers/index.js`）会被 Node 的 exports 解析拒绝**，下文「未导出」就等于拿不到，只能复制代码。

三个前提，先说清楚：

1. **版本**：MMP 现在锁的是 `pi-coding-agent 0.83.0`、`pi-tui 0.83.0`、`pi-ai 0.74.0`（`[MMP] package.json`），`MMP_HELP` 里也写着 "pinned Pi 0.83"（`[MMP] src/host.ts:34`）。本文全部按 0.87.1 讲，**三个包一起升级是前置条件**。
2. **repo HEAD 不等于已发布的 0.87.1**。我用脚本比对了 `ca/index.ts` 与 `npm/index.d.ts` 的导出名：HEAD 多出 `ExtensionVirtualModel`、`ModelRoute*`、`ProviderStreamEvent`、`ThemeAppearance/ThemeBg/ThemeStyle/ThemeToken`、`VIRTUAL_MODEL_STATE_ENTRY`、`VirtualModel*`；pi-tui HEAD 多出一批颜色工具（`Color`、`styleText`、`mixColors` 等），npm 版有而 HEAD 没有的只有 `parseOsc11BackgroundColor`。**本文依赖的接口我在 npm d.ts 里逐个核对过，两边一致**：`ExtensionUIContext` 的 28 个成员、`ExtensionBindings`、`ExtensionCommandContextActions`、`AgentSessionEvent` 的事件类型、`AgentSessionRuntime` 的方法、`BUILTIN_SLASH_COMMANDS` 的 24 条命令、`main.js` 的步骤顺序。行号引用的是 HEAD 源码。
3. **必须和 Pi 共用同一份 pi-tui 与 pi-coding-agent**。原因：`ExtensionUIContext` 把 pi-tui 的 `TUI`、coding-agent 的 `Theme`、应用层 `KeybindingsManager` 交给扩展（`ca/core/extensions/types.ts:138,186-236`）；组件从 `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` 读主题（`ca/modes/interactive/theme/theme.ts:722-740`），从 pi-tui 的全局 `setKeybindings` 读键位（`tui/keybindings.ts:311-320`）。扩展那一侧由 `HOST_PROVIDED_EXTENSION_PACKAGES` 保证用宿主的包（`ca/core/resource-loader.ts:41-49`），MMP 自己的依赖树里也不能出现第二份。

## 1. Runtime / Session API

### 1.1 三个工厂（都已导出，`ca/index.ts:237-264`）

| API | 签名要点 | 位置 |
|---|---|---|
| `createAgentSession(options?)` | 一步到位：`cwd, agentDir, modelRuntime, model, thinkingLevel, scopedModels, noTools, tools, excludeTools, customTools, resourceLoader, sessionManager, settingsManager, sessionStartEvent` → `{ session, extensionsResult, modelFallbackMessage }` | `ca/core/sdk.ts:42-101,176` |
| `createAgentSessionServices(opts)` | `{ cwd, agentDir?, settingsManager?, modelRuntime?, modelRuntimeSignal?, extensionFlagValues?, resourceLoaderOptions?, resourceLoaderReloadOptions? }` → `AgentSessionServices { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics }` | `ca/core/agent-session-services.ts:37-45,73-79,135` |
| `createAgentSessionFromServices(opts)` | `{ services, sessionManager, sessionStartEvent?, model?, thinkingLevel?, scopedModels?, tools?, excludeTools?, noTools?, customTools? }` | 同上 `:54-64,214` |
| `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager, sessionStartEvent? })` | `factory: CreateAgentSessionRuntimeFactory`，接收 `{ cwd, agentDir, sessionManager, sessionStartEvent?, projectTrustContext? }`，返回 `CreateAgentSessionResult & { services, diagnostics }` | `ca/core/agent-session-runtime.ts:23-41,420-438` |

`AgentSessionRuntime`（`ca/core/agent-session-runtime.ts:74`）持有当前 `session` 和 `services`。换会话的方法都是「先拆旧的，再用同一个 factory 建新的」：

| 操作 | 方法 | 位置 |
|---|---|---|
| 新会话 | `newSession({ parentSession?, setup?, withSession? })` | `:226` |
| 恢复/切换 | `switchSession(path, { cwdOverride?, withSession?, projectTrustContextFactory? })` | `:196` |
| 分叉/克隆 | `fork(entryId, { position?: "before"\|"at", withSession? })` → `{ cancelled, selectedText? }` | `:262` |
| 导入 JSONL | `importFromJsonl(path, cwdOverride?)` | `:359` |
| 退出 | `dispose()`（发 `session_shutdown{reason:"quit"}`） | `:404` |
| 宿主回调 | `setRebindSession(fn)`：新 session 建好后调用；`setBeforeSessionInvalidate(fn)`：`session_shutdown` 之后、旧 session dispose 之前同步调用，用来拆掉扩展给的组件 | `:117,129,167-178,187-194` |

树内跳转不换 session：`session.navigateTree(targetId, {summarize, customInstructions, replaceInstructions, label})`（`ca/core/agent-session.ts:3668`）。

### 1.2 绑定扩展

`session.bindExtensions(bindings)`（`ca/core/agent-session.ts:2998-3020`）。`ExtensionBindings`（`:263-270`）有这些字段：

- `uiContext?: ExtensionUIContext`：宿主的 UI 实现，见第 2 节。
- `mode?: ExtensionMode`：`"tui" | "rpc" | "json" | "print"`（`ca/core/extensions/types.ts:318`）。自建 TUI 应传 `"tui"`，扩展靠它判断能不能调 `custom()` 这类终端专用 UI。
- `commandContextActions?: ExtensionCommandContextActions`：`waitForIdle, newSession, fork, navigateTree, switchSession, reload`（`types.ts:1937-1958`）。不传时 runner 会换成什么都不做的空实现（`ca/core/extensions/runner.ts:529-546`），扩展命令里的 `ctx.newSession()` 就会静默失效。
- `abortHandler?`、`shutdownHandler?`、`onError?`。

**时序约束**：`bindExtensions` 在最后会 emit `session_start`（`agent-session.ts:3019`）。MMP 自己的 runtime 扩展就在 `session_start` 里调 `ui.setHeader(...)`（`[MMP] src/extensions/runtime.ts:91,106`），所以 **uiContext 必须在 bind 之前完全可用**。之后每次换 session 都要在 `setRebindSession` 回调里重新 bind、重新 `subscribe`（示例 `ca/../examples/sdk/13-session-runtime.ts:38-64`；RPC 的做法见 `ca/modes/rpc/rpc-mode.ts:313-361`）。`session.reload()` 会建新的 runner，并自动把已存的 bindings 重新挂上去（`agent-session.ts:3355-3366,3378-3402`），但宿主那边的状态（autocomplete、快捷键、主题注册、header/widget）要自己重建，InteractiveMode 在 `handleReloadCommand` 里就是这么做的（`ca/modes/interactive/interactive-mode.ts:6198-6260`）。

注意：`ExtensionBindings`、`ExtensionMode`、`ShutdownHandler`、`ExtensionErrorListener` 这几个**类型没有从包入口导出**（`ca/index.ts:54-188` 里没有）。可以用 `Parameters<AgentSession["bindExtensions"]>[0]` 推出来。

### 1.3 MMP 现有参数怎么映射到 SDK

| MMP 现状 | SDK 对应 | 位置 |
|---|---|---|
| `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`（`[MMP] host.ts:39-45`） | `resourceLoaderOptions: { noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles: true }` | `ca/core/resource-loader.ts:215-250`；main 的写法 `ca/main.ts:766-779` |
| `--extension <path>`（`host.ts:56-58`） | `resourceLoaderOptions.additionalExtensionPaths` | 同上 |
| `piMain(args, { extensionFactories })`（`host.ts:160`） | `resourceLoaderOptions.extensionFactories` | `resource-loader.ts:224,1033-1052` |
| `process.env.PI_CODING_AGENT_DIR = agentDir`（`host.ts:159`） | 显式传 `agentDir`（`createAgentSessionServices` 的 `agentDir?`，`agent-session-services.ts:39`）。env 名由 `ENV_AGENT_DIR` 拼出（`ca/config.ts:508,529`）；不传时会回落到 `getDefaultAgentDir()`（`sdk.ts:178`），内部也还有直接调 `getAgentDir()` 的地方，所以 env 也要留着 | — |

语义细节：`noExtensions` 只关掉自动发现的路径，CLI/additional 路径和 inline factories 照样加载（`resource-loader.ts:508-510,630,646`）；`noSkills` 同理，MMP 通过 `resources_discover` 注入的 skill 不受影响（`[MMP] runtime.ts:119`）。`resourceLoaderOptions` 的类型可以写成 `CreateAgentSessionServicesOptions["resourceLoaderOptions"]`（已导出）；`DefaultResourceLoaderOptions` 本身没导出。另外 main 会把隐藏的内置扩展 `builtInExtensions`（llama.cpp，`ca/extensions/index.ts:4`）加到最前面（`ca/main.ts:568`），这个**未导出**，走 SDK 就不会有。

### 1.4 main.ts 在交互模式下做的每一步

| # | 步骤 | 位置（`ca/main.ts`） | 公开可用？ |
|---|---|---|---|
| 1 | 拼上 `builtInExtensions` 和调用方传的 factories | 568 | 否（`builtInExtensions` 未导出） |
| 2 | `--offline` / `PI_OFFLINE` | 569-573 | 内联 |
| 3 | `pi auth ...` 子命令 | 575, 132-208 | 否 |
| 4 | Windows 清理、`cleanupManagedInstall` | 579-582 | 否 |
| 5 | bootstrap settings，`applyHttpProxySettings` + `configureHttpDispatcher` | 586-588 | `SettingsManager` 是；两个 http 函数**否** |
| 6 | `install/update/config` 这类包管理子命令 | 590-605 | 否 |
| 7 | `parseArgs` 与诊断输出 | 607-616 | `parseArgs` 是（`ca/index.ts:3`） |
| 8 | `--version`、`--export` | 619-636 | `exportFromFile` 否；`session.exportToHtml` 是 |
| 9 | `resolveAppMode`（rpc/json/print/interactive，看 TTY） | 111-122, 638 | 否（13 行，容易复制） |
| 10 | 非交互模式接管 stdout | 639-642 | 否 |
| 11 | `--fork` / `--session-id` 参数校验 | 649-650 | 否；`SessionManager` 是 |
| 12 | `runMigrations` | 653 | 否 |
| 13 | 读 startup settings 与诊断 | 656-657 | `SettingsManager` 是；`collectSettingsDiagnostics` 否 |
| 14 | 首次启动向导（主题、遥测） | 661-664 | 否（`FirstTimeSetupComponent` 也不在包入口） |
| 15 | `--theme` 覆盖 | 666-668 | `settingsManager.applyOverrides` 是 |
| 16 | 算 sessionDir（参数 > env > 设置） | 675-679 | 内联 |
| 17 | `createSessionManager`：处理 no-session/fork/session/resume（选择器）/continue/session-id | 357-448, 680 | 函数写在 main.ts 里，包入口不导出；`SessionManager.create/open/continueRecent/inMemory/forkFrom/list/listAll/findById` 都是（`ca/core/session-manager.ts:1750-1922`）；`--resume` 用的 `selectSession` 否，但 `SessionSelectorComponent` 是 |
| 18 | 会话 cwd 不存在时提示 | 681-693 | 否 |
| 19 | `--name` | 694-701 | `sessionManager.appendSessionInfo` 是 |
| 20 | 项目信任：`ProjectTrustStore`、`hasTrustRequiringProjectResources`、`resolveProjectTrusted` + `createProjectTrustContext` | 704-765 | 前两个是（`ca/index.ts:379-385`）；后两个**否** |
| 21 | runtime factory：`createAgentSessionServices` → 解析 scoped models → `buildSessionOptions`（`resolveCliModel`）→ `--api-key` → `createAgentSessionFromServices` | 717-847 | 工厂是；`resolveModelScope` 否（`resolveModelScopeWithDiagnostics` 是，`ca/index.ts:215`）；`buildSessionOptions` 否 |
| 22 | `createAgentSessionRuntime` | 849 | 是 |
| 23 | `setCapabilityOverrides`，再配一次 http dispatcher | 857-859 | pi-tui 的 `setCapabilityOverrides` 是（`tui/index.ts:145`）；http 否 |
| 24 | `--help`、`--list-models` | 861-875 | 否 |
| 25 | 读管道 stdin；有输入就从 interactive 降为 print | 877-884 | 否 |
| 26 | `@file` 与初始消息 | 887 | 否 |
| 27 | `setThemeJsonValidator(validateThemeJson)` + `initTheme` | 890-891 | `initTheme` 是；validator 否（不装的话用户主题 JSON 不做校验，`theme.ts:48-56`） |
| 28 | 弃用警告 | 895-897 | 否 |
| 29 | 汇总诊断，有 error 就退出 | 900-916 | 内联 |
| 30 | `new InteractiveMode(runtime, {...}).run()` | 938-969 | 我们要替换的就是这一步 |

**HTTP dispatcher 的影响**：`applyHttpProxySettings` 把设置里的 `httpProxy` 写进 `HTTP(S)_PROXY`（`ca/core/http-dispatcher.ts:45-49`）；`configureHttpDispatcher` 用 undici 的 `EnvHttpProxyAgent` 设全局 dispatcher，包括 body/headers 超时（默认 300s）、`allowH2:false` 和自定义 client factory（`:81-100`）。SDK 路径不会调用它们（`grep` 结果只在 main.ts、rpc-entry.ts、interactive-mode.ts、cli/setup.ts 里出现）。MMP 自建的话，**会丢掉 settings 里的代理和超时配置**，需要直接用 undici 重写这约 20 行（`EnvHttpProxyAgent` + `setGlobalDispatcher`；注意它依赖的 `createUndiciClient`/`createUndiciOriginDispatcher` 也在这个未导出的文件里）。

## 2. ExtensionUIContext（`ca/core/extensions/types.ts:144-298`）

「需组件」= 参数或返回值涉及 pi-tui 的 `TUI`/`Component`/`EditorComponent`。

| 成员 | 含义 | 需组件 | RPC 的实现（`ca/modes/rpc/rpc-mode.ts:136-311`） |
|---|---|---|---|
| `select(title, options, opts)` | 单选，返回选中项或 undefined；`opts.signal`/`timeout` | | 发请求，等回复 |
| `confirm(title, message, opts)` | 是/否 | | 同上 |
| `input(title, placeholder, opts)` | 单行输入 | | 同上 |
| `notify(msg, type)` | 通知 | | 只发不等 |
| `onTerminalInput(handler)` | 监听原始终端输入，可吞掉或改写 | （原始字节） | 空实现 |
| `setStatus(key, text)` | footer 状态文字 | | 只发不等 |
| `setWorkingMessage(msg?)` | 流式输出时 loader 上的文字 | | 空实现 |
| `setWorkingVisible(bool)` | 显示/隐藏 loader 那一行 | | 空实现 |
| `setWorkingIndicator(opts?)` | loader 的帧动画 | | 空实现 |
| `setHiddenThinkingLabel(label?)` | 折叠 thinking 时显示的标签 | | 空实现 |
| `setWidget(key, string[] \| factory, {placement})` | editor 上方/下方的小部件 | factory 版本需要：`(tui, theme) => Component` | 只转发 string[] |
| `setFooter(factory?)` | 替换 footer | 是：`(tui, theme, footerData) => Component` | 空实现 |
| `setHeader(factory?)` | 替换启动 header | 是：`(tui, theme) => Component` | 空实现 |
| `setTitle(title)` | 终端标题 | | 只发不等 |
| `custom(factory, {overlay, overlayOptions, onHandle})` | 自定义组件拿焦点，`done(result)` 结束 | 是：`(tui, theme, keybindings, done) => Component`，还要 `OverlayOptions/OverlayHandle` | 返回 undefined |
| `pasteToEditor(text)` | 按粘贴处理 | | 退化成 setEditorText |
| `setEditorText(text)` / `getEditorText()` | 读写主输入框 | | 发请求 / 返回 "" |
| `editor(title, prefill)` | 多行编辑对话框 | | 发请求，等回复 |
| `addAutocompleteProvider(factory)` | 在现有 provider 外面再包一层 | pi-tui 的 `AutocompleteProvider` | 空实现 |
| `setEditorComponent(factory?)` / `getEditorComponent()` | 替换输入框 | 是：`EditorFactory = (tui, EditorTheme, KeybindingsManager) => EditorComponent`（`types.ts:138`） | 空实现 |
| `theme`（只读） | 当前 `Theme` | 需要 Theme 实例 | 全局 `theme` |
| `getAllThemes()` / `getTheme(name)` / `setTheme(t)` | 主题管理 | | `[]` / undefined / 失败 |
| `getToolsExpanded()` / `setToolsExpanded(b)` | 工具输出展开状态 | | false / 空实现 |

要点：

- runner 会给 `select/confirm/input/editor/custom` 再包一层，自动发 `ui_prompt_start/end` 事件（`runner.ts:548-598`）。`ctx.hasUI` 的判断只看有没有传 uiContext（`runner.ts:604-606`）。
- InteractiveMode 的实现（`interactive-mode.ts:2537-2586`）用到了几个**未导出**的函数：`getAvailableThemesWithPaths`、`getThemeByName`、`setTheme`/`setThemeInstance`、`setRegisteredThemes`（`theme.ts:467,642,746,772,795`）。公开的只有 `initTheme`、`Theme`、`getMarkdownTheme`、`getSelectListTheme`、`getSettingsListTheme`、`highlightCode`、`getLanguageFromPath`（`ca/index.ts:455-468`）。`getEditorTheme`（`theme.ts:1144`）**没导出**，可 `EditorFactory` 偏偏需要 `EditorTheme`。
- 要把 `Theme` 实例交给 `ui.theme`，唯一的办法是读 `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]`（`theme.ts:722-740`）。这是 hack。并且任何导出组件在构造前都必须先 `initTheme()`，否则 proxy 直接抛错（`theme.ts:729-731`）。
- `setFooter` 的 `footerData: ReadonlyFooterDataProvider` 只导出了类型（`ca/index.ts:207`），是 `FooterDataProvider` 里 `getGitBranch/getExtensionStatuses/getAvailableProviderCount/onBranchChange` 这四个方法的 Pick（`ca/core/footer-data-provider.ts:99,385-388`）。类本身没导出，宿主要自己实现这四个方法。
- 最小实现可以照抄 RPC：能力不支持的成员留空实现，接口照样合法。项目信任提示用的是它的子集 `ProjectTrustContext.ui = Pick<..., "select"|"confirm"|"input"|"notify">`（`types.ts:544-549`）。

## 3. UI 要订阅的 AgentSession 事件

`session.subscribe(listener)`（`ca/core/agent-session.ts:1235`）。事件类型 `AgentSessionEvent`（`agent-session.ts:173-214`）= pi-agent-core 的 `AgentEvent`（`agent/types.ts:485-500`，其中 `agent_end` 被换掉）加上 session 自己的事件。InteractiveMode 的 switch 在 `interactive-mode.ts:3299-3680`。

| 事件 | 载荷 | 来源 |
|---|---|---|
| `agent_start` | — | agent/types.ts:487 |
| `agent_end` | `messages, willRetry` | agent-session.ts:175-179 |
| `agent_settled` | — | :180 |
| `turn_start` / `turn_end` | `turn_end: message, toolResults` | agent/types.ts:490-491 |
| `message_start` / `message_end` | `message: AgentMessage`（role 可以是 user/assistant/toolResult/custom/bashExecution/...） | :493,496 |
| `message_update` | `message, assistantMessageEvent`（`text_*`/`thinking_*`/`toolcall_*`/`done`/`error`，见 `ai/types.ts:741-757`） | :495 |
| `tool_execution_start` | `toolCallId, toolName, args` | :498 |
| `tool_execution_update` | `+ partialResult` | :499 |
| `tool_execution_end` | `toolCallId, toolName, result, isError` | :500 |
| `queue_update` | `steering[], followUp[]` | agent-session.ts:181-185 |
| `compaction_start` | `reason: manual\|threshold\|overflow` | :186 |
| `compaction_end` | `reason, result?, aborted, willRetry, errorMessage?` | :190-197 |
| `entry_appended` | `entry: SessionEntry`：custom entry、带 display 的 custom_message、compaction 都经由它进 UI（`interactive-mode.ts:3336-3378`） | :187 |
| `session_info_changed` | `name` | :188 |
| `thinking_level_changed` | `level` | :189 |
| `auto_retry_start` / `auto_retry_end` | `attempt, maxAttempts, delayMs, errorMessage` / `success, attempt, finalError?` | :198-199 |
| `summarization_retry_scheduled` / `_attempt_start` / `_finished` | 分支摘要和压缩时的重试 | :200-213 |
| `bash_execution_update` | `id?, delta`（用户 `!` 命令的流式输出） | :214 |

**`session.prompt()` 会抛错，宿主必须 catch**：压缩进行中（`agent-session.ts:1726-1730`）、正在流式输出却没给 `streamingBehavior`（`:1753-1759`）、没有模型（`:1773-1774`）、provider 没配认证（`:1780` 起）。InteractiveMode 把这些都转成了状态提示；如果直接 `await session.prompt(text)`，遇到第一个错误就会崩。

不在事件流里、要主动去读的状态：`session.isStreaming/isCompacting/isRetrying/pendingMessageCount/getSteeringMessages()/getContextUsage()/getSessionStats()`（`agent-session.ts:1326-1440,2153-2163,3887,3941`）。

## 4. 宿主必须承接的扩展面

| 能力 | 宿主从哪里读 | 公开？ | 说明 |
|---|---|---|---|
| 斜杠命令列表 | `session.extensionRunner.getRegisteredCommands(): ResolvedCommand[]`（带 `invocationName`，重名时改名） | 是（`ExtensionRunner` 类已导出，`ca/index.ts:193`；`runner.ts:805`；getter `agent-session.ts:4098`） | 与内置命令重名时的诊断逻辑在 `interactive-mode.ts:672-686`，要自己抄 |
| 命令执行 | 不用宿主做：`session.prompt("/name args")` 会先查扩展命令（`agent-session.ts:1716-1723,1856-1880`），然后展开 `/skill:x` 和 prompt 模板（`:1745-1749`） | 是 | 宿主只拦截自己的内置命令，剩下的原样交给 prompt |
| 参数补全 | `RegisteredCommand.getArgumentCompletions(prefix)`（`types.ts:1343-1349`） | 是 | InteractiveMode 把命令、模板、skill 拼成 pi-tui 的 `CombinedAutocompleteProvider(commands, cwd, fdPath)`（`interactive-mode.ts:688-786`；`tui/index.ts:9`） |
| 模板/skill 命令 | `session.promptTemplates`、`session.resourceLoader.getSkills()`、`settingsManager.getEnableSkillCommands()` | 是 | 同上 |
| `pi.getCommands()` | session 内部实现（`agent-session.ts:3100`） | 扩展侧用 | — |
| 快捷键 | `extensionRunner.getShortcuts(keybindings.getEffectiveConfig())` → `Map<KeyId, ExtensionShortcut>`（`runner.ts:656-699`），handler 需要 `ExtensionContext` | 是；context 可用 `extensionRunner.createContext()`（`runner.ts:835`） | 与内置键位冲突的判断需要**应用层**键位配置，见 5.3 |
| autocomplete provider | 扩展调 `ui.addAutocompleteProvider(factory)`，宿主自己存起来按顺序包（`interactive-mode.ts:787-800`） | 宿主状态 | — |
| 消息渲染器 | `extensionRunner.getMessageRenderer(customType)`（`runner.ts:741`），传给已导出的 `CustomMessageComponent(message, renderer, mdTheme, pad)` | 是 | `interactive-mode.ts:3771-3784` |
| entry 渲染器 | `extensionRunner.getEntryRenderer(customType)`（`runner.ts:755`） | 是 | 对应的 `CustomEntryComponent` **未导出** |
| 工具渲染 | `session.getToolDefinition(name)` 返回扩展工具的 `renderCall/renderResult/renderShell`（`types.ts:478,502-510`） | 是 | **内置 7 个工具（read/bash/edit/write/grep/find/ls）的渲染器由 `withBuiltInRenderers` 在宿主侧合并进来（`interactive-mode.ts:2135`；`ca/core/tools/renderers/index.ts:19-63`），这部分未导出**。`ToolExecutionComponent` 自己不再兜底（`tool-execution.ts:119-124`），传 undefined 就只有通用渲染 |
| Markdown 变换 | `extensionRunner.getMarkdownTransformers()`（`runner.ts:751`），传给 `AssistantMessageComponent/UserMessageComponent` 的最后一个参数 | 是 | Pi 还会在前面加一个 mermaid 变换（`interactive-mode.ts:2138-2140`），未导出 |
| `pi.sendMessage` 显示 | `session.sendCustomMessage`（`agent-session.ts:2033-2069`）：空闲且不触发 turn 时直接写入 session，并 emit role 为 `custom` 的 `message_start/end`（`:2071-2081`）；流式中且不触发 turn 时先排队，等本轮结束再写入（`:2060-2065,2087-2095`）；`triggerTurn` 时当作一次 prompt 运行，`deliverAs` 决定 steer/followUp/nextTurn。宿主用 `CustomMessageComponent` 渲染 | 是 | MMP 的 `/mmp` 命令就走这条路（`[MMP] runtime.ts:135-148`）。InteractiveMode 还在 `entry_appended` 里处理带 display 的 custom_message（`interactive-mode.ts:3344-3354`），它和 message 事件之间怎么去重，我没核实 |
| widget / status / header / footer | 宿主自己存（见第 2 节） | 宿主状态 | — |
| 扩展 flag | `extensionRunner.getFlags()`（`runner.ts:636`），main 用它打印 `--help`（`main.ts:863-866`） | 是 | — |

## 5. 新 TUI 可复用的导出

### 5.1 pi-coding-agent（`ca/index.ts:415-468`，全部走 `"."` 入口）

| 组件/函数 | 导出 | 构造要点 |
|---|---|---|
| `AssistantMessageComponent` | 是 | `(message?, hideThinking, mdTheme, hiddenLabel, pad, transformers)`（`components/assistant-message.ts:26-33`） |
| `UserMessageComponent` | 是 | `(text, mdTheme, pad, transformers)` |
| `ToolExecutionComponent` | 是 | `(toolName, id, args, opts, toolDefinition, ui: TUI, cwd)`（`tool-execution.ts:81-89`）；内置工具的渲染器见第 4 节 |
| `BashExecutionComponent` | 是 | `(command, ui, excludeFromContext)` |
| `CustomMessageComponent`、`CompactionSummaryMessageComponent`、`BranchSummaryMessageComponent`、`SkillInvocationMessageComponent` | 是 | — |
| `ModelSelectorComponent` | 是 | `(tui, currentModel, modelRuntime, scopedModels, onSelect, onCancel, search?, onSelectAsDefault?, defaultModel?)`（`model-selector.ts:76-86`） |
| `SessionSelectorComponent` | 是 | `(currentLoader, allLoader, onSelect, onCancel, onExit, requestRender, {renameSession, keybindings}, currentPath)`（`session-selector.ts:757-770`） |
| `TreeSelectorComponent` | 是 | `(tree, leafId, termHeight, onSelect, onCancel, onLabelChange?, ...)`（`tree-selector.ts:1357-1366`） |
| `UserMessageSelectorComponent`（/fork） | 是 | `(messages, initialId?)` |
| `LoginDialogComponent`、`OAuthSelectorComponent` | 是 | `(tui, providerId, onComplete, ...)` / `(mode, providers, onSelect, onCancel, search?)` |
| `SettingsSelectorComponent` | 是 | `(config: SettingsConfig, callbacks)`，`SettingsConfig` 有 40 多个字段（`settings-selector.ts:57-97,462`），整合成本高 |
| `ThinkingSelectorComponent`、`ThemeSelectorComponent`、`ShowImagesSelectorComponent` | 是 | — |
| `ExtensionSelectorComponent`、`ExtensionInputComponent`、`ExtensionEditorComponent` | 是 | 用来实现 `ui.select/input/editor` 正合适 |
| `CustomEditor` | 是 | `(tui, EditorTheme, KeybindingsManager, opts)`（`custom-editor.ts:26`），需要**应用层**键位管理器 |
| `FooterComponent` | 是 | `(session, ReadonlyFooterDataProvider)`，provider 要自己实现 |
| `DynamicBorder`、`BorderedLoader`、`renderDiff`、`truncateToVisualLines`、`keyHint/keyText/rawKeyHint` | 是 | — |
| `ScopedModelsSelectorComponent`、`TrustSelectorComponent`、`FirstTimeSetupComponent`、`DaxnutsComponent` | **否**（在 `components/index.ts:10,16-20,26,35` 里，但包入口没有） | — |
| `StatusIndicator`、`ThemedText`、`CustomEntryComponent`、mermaid、pi-logo | **否** | — |
| 主题：`initTheme`、`Theme`、`getMarkdownTheme`、`getSelectListTheme`、`getSettingsListTheme`、`highlightCode` | 是 | `getEditorTheme`、`theme`、`setTheme`、`onThemeChange`、`stopThemeWatcher` **否** |
| `copyToClipboard`、`resizeImage`、`convertToPng` | 是（`ca/index.ts:470-474`） | — |
| `InteractiveMode` | 是（`ca/index.ts:398`） | 大部分是 private，想改只能 fork，没有注入点 |
| `createInteractiveTui` | **否**（`modes/index.ts` 不转出） | 它只是 `new TuiAltScreen(terminal, cursor, logDir, opts)` / `new TuiMainScreen(...)`（`tui-renderer.ts:21-48`），很容易重写 |

### 5.2 pi-tui 0.87.1（入口 `tui/index.ts`，npm 版 `main: dist/index.js`，没有 exports map）

| 能力 | 导出 | 位置 / 说明 |
|---|---|---|
| `TUI` 接口、`Component`、`Container`、`Focusable`、`OverlayOptions/OverlayHandle` | 是（`TUI` 只导出类型） | `tui/index.ts:149-174`；接口 `tui/tui.ts:117-142,453-482` |
| `TuiMainScreen`（常规/inline 模式） | 是 | `tui/index.ts:176`；`tui-main-screen.ts:124` |
| `TuiAltScreen`（fullscreen、应用自己管视口、搜索、选择复制） | 是 | `tui/index.ts:175`；构造 `(terminal, showCursor?, logDir?, TuiAltScreenOptions)`（`tui-alt-screen.ts:166-195,250-255`） |
| `VStack`、`HStack`、`ScrollView`（follow end、scrollbar）、`Box`、`Spacer`、`Text`、`TruncatedText` | 是 | `tui/index.ts:40-72` |
| `Editor`、`EditorComponent`、`Input`、`SelectList`、`SettingsList`、`Loader`、`CancellableLoader` | 是 | `:41-62,74` |
| `Markdown`、`Marked`、`renderLatex` | 是 | `:3,47,104` |
| 鼠标：`TuiMouseEvent`、`MouseRegion`、`Component.handleMouse` | 是 | `:48,168-171`。**只有 `TuiAltScreen` 会开启终端鼠标上报**（`tui-alt-screen.ts:65-66`，`options.mouse`）；`TuiMainScreen` 里没有 `?1000h` 之类的序列 |
| Kitty 键盘协议 | 是：`ProcessTerminal` 启动时协商（`tui/terminal.ts:12-14`），另有 `isKittyProtocolActive`、`matchesKey`、`parseKey`、`Key` | `:91-102,111` |
| 图片：`Image`、`renderImage`、`encodeKitty/encodeITerm2`、`getCapabilities`、`setCapabilityOverrides` | 是 | `:44,120-148` |
| 键位：`KeybindingsManager`（通用）、`setKeybindings/getKeybindings`、`TUI_KEYBINDINGS` | 是 | `:78-89` |
| 模糊匹配、`CombinedAutocompleteProvider`、`visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi` | 是 | `:5-11,76,178-185` |

### 5.3 键位是个缺口

InteractiveMode 用 `KeybindingsManager.create()` 读 `agentDir/keybindings.json`，再 `setKeybindings()` 设成全局（`interactive-mode.ts:607-608`）。这个类在 coding-agent 里继承 pi-tui 的版本，并带上 `app.*` 应用键位定义 `KEYBINDINGS`（`ca/core/keybindings.ts:75,371-399`）。**这个类和 `KEYBINDINGS` 都只以类型形式导出**（`ca/index.ts:117` 在 `export type {}` 块里）。后果：`CustomEditor`、扩展 `custom()` 拿到的 `keybindings.matches(data, "app.xxx")`、`getShortcuts` 的冲突判断，都要求 MMP 自己复制一份应用键位定义（`app.*` 约 114 行）。

## 6. 内置斜杠命令

名单在 `BUILTIN_SLASH_COMMANDS`（`ca/core/slash-commands.ts:19-44`，24 条：settings, model, tree, thinking, scoped-models, export, import, share, bug, copy, name, session, changelog, hotkeys, fork, clone, trust, login, logout, new, compact, resume, reload, quit），**未导出**。实现全部在 `interactive-mode.ts` 里：分发是一串 `if (text === "/xxx")`（`:3098-3236`），处理函数都是 private。**没有导出任何命令注册表或 helper。** `./client` 入口的 `SlashCommands`/`AgentController`（`ca/client/index.ts`）只有 source 条件、npm 包里不带，而且 HEAD 里它引用的 `ca/client/services/` 目录并不存在，不能用。

各命令能用哪些公开积木：

| 命令 | 公开积木 | 需要自己写的 |
|---|---|---|
| /model | `ModelSelectorComponent`、`session.setModel/cycleModel`、`resolveCliModel`、`modelRuntime.getAvailableSnapshot()` | 参数补全、`provider/id` 解析（`:5061-5230`） |
| /thinking | `ThinkingSelectorComponent`、`session.getAvailableThinkingLevels/setThinkingLevel` | — |
| /login /logout | `ModelRuntime.getProviders/getProviderAuthStatus/isUsingOAuth/login(id, type, {signal, prompt, notify})/logout/listCredentials`（`ca/core/model-runtime.ts:816-833`）、`LoginDialogComponent`、`OAuthSelectorComponent` | provider 列表和 prompt/notify 的对接（`interactive-mode.ts:5657-6200`） |
| /new /resume /fork /clone /import | runtime 的 `newSession/switchSession/fork/importFromJsonl`；`SessionSelectorComponent`、`UserMessageSelectorComponent`、`session.getUserMessagesForForking()` | 选择器的组装 |
| /tree | `TreeSelectorComponent`、`sessionManager.getTree()`（`session-manager.ts:1524`）、`session.navigateTree`、`pi.setLabel` | 摘要选项对话框 |
| /compact | `session.compact(instr)`、`abortCompaction()` | 状态展示 |
| /export | `session.exportToHtml(path)`、`exportToJsonl(path)`（`agent-session.ts:3992,4017`） | — |
| /share | 无（`session-share.ts` 未导出，走 gh gist） | 整个重写 |
| /copy /name /session | `getLastAssistantText` + `copyToClipboard`；`setSessionName`；`getSessionStats` | 格式化 |
| /reload | `session.reload()` | 宿主状态重建（1.2 节） |
| /settings /scoped-models /hotkeys /changelog /bug /trust | 部分组件（`SettingsSelectorComponent`、`ProjectTrustStore`） | 大部分（changelog、bug-report 都未导出） |

## 7. 非交互模式

`runPrintMode(runtime, { mode: "text"|"json", messages?, initialMessage?, initialImages? }): Promise<number>` 和 `runRpcMode(runtime): Promise<never>` 都已导出（`ca/index.ts:411-412`；`ca/modes/print-mode.ts:18-33`；`ca/modes/rpc/rpc-mode.ts:54`）。两种走法：

- **(a) 非交互继续走 `piMain`，只有交互模式换成自己的 TUI。** MMP 先用已导出的 `parseArgs` 复刻 `resolveAppMode`（`main.ts:111-122`：`--mode rpc/json`、`-p`、stdin/stdout 不是 TTY），同时考虑两种情况：管道 stdin 会把 interactive 降为 print（`:877-884`）；`--help/--version/--export/--list-models`、auth 子命令和包管理子命令都在 piMain 里处理，也继续交给它。好处是 print/json/rpc 的行为和现在完全一样。代价是两条启动路径（交互走 SDK，其余走 piMain）的 settings、trust、model 解析要分别维护，而且上游改了 main.ts 之后可能慢慢不一致。
- **(b) MMP 自己建 runtime，按模式分发到 `runRpcMode`/`runPrintMode`/自建 TUI。** 只有一条启动路径，但第 1.4 节表里所有「否」的步骤（auth 子命令、`--help`、`--list-models`、`--export`、stdout 接管、http dispatcher、迁移、管道 stdin、`@file`）都要 MMP 自己负责。

我的判断（非上游结论）：先走 (a)，非交互模式零改动；等自建 TUI 稳定后，再看 (b) 值不值得做。

## 8. 汇总：未导出清单（常用到的）

| 符号 | 所在 | 影响 / 替代 |
|---|---|---|
| `ExtensionBindings`、`ExtensionMode`、`ShutdownHandler` 类型 | `agent-session.ts:263`、`types.ts:318` | 用 `Parameters<AgentSession["bindExtensions"]>[0]` |
| `DefaultResourceLoaderOptions`、`ResourceLoaderReloadOptions` | `resource-loader.ts:37,215` | 用 `CreateAgentSessionServicesOptions[...]` |
| `builtInExtensions`（llama.cpp） | `ca/extensions/index.ts:4` | 放弃 |
| `BUILTIN_SLASH_COMMANDS` 与全部内置命令实现 | `slash-commands.ts:19` | 自己写 |
| `withBuiltInRenderers`、`createAllToolRenderers` | `core/tools/renderers/index.ts:32,51` | 复制 7 个渲染器，或用通用渲染 |
| 应用层 `KeybindingsManager` 类、`KEYBINDINGS` | `core/keybindings.ts:75,371` | 复制定义 |
| `theme` proxy、`setTheme`、`setThemeInstance`、`setRegisteredThemes`、`getAvailableThemesWithPaths`、`getThemeByName`、`getEditorTheme`、`onThemeChange`、`stopThemeWatcher`、`setThemeJsonValidator` | `theme.ts` | globalThis symbol hack，或自己加载 |
| `FooterDataProvider` 类 | `footer-data-provider.ts:99` | 自己实现 4 个方法 |
| `createSessionManager`、`selectSession`、`resolveModelScope`、`buildSessionOptions`、`createProjectTrustContext`、`resolveProjectTrusted`、`runMigrations`、`collectSettingsDiagnostics`、`showFirstTimeSetup`、`exportFromFile` | `main.ts`、`cli/*`、`core/*` | 按需复制 |
| `configureHttpDispatcher`、`applyHttpProxySettings` | `core/http-dispatcher.ts:45,81` | 用 undici 重写 |
| `createInteractiveTui`、`StatusIndicator`、`CustomEntryComponent`、`ScopedModelsSelectorComponent`、`TrustSelectorComponent`、`FirstTimeSetupComponent` | `modes/interactive/*` | 自己写 |
| session-share、bug-report、changelog | `modes/interactive/*`、`utils/changelog.ts` | 自己写或不做 |

## 未核实 / 未做

- 没有写代码实跑 SDK 路径，本文结论全部来自读源码和比对 npm d.ts。
- 没看 pi-mcp-adapter 调了哪些 `ctx.ui` 能力（MMP 的 `node_modules` 目前没装），要确认它有没有用 `custom()`/`setWidget(factory)`。
- `SessionSelectorComponent`、`TreeSelectorComponent` 在 InteractiveMode 之外能不能单独用（它们会不会依赖全局键位、焦点约定），还没验证。
