# MMP TUI 设计（v2 草案：自建交互层）

日期：2026-09-29。状态：草案，待评审，还没写代码。

一句话目标：MMP 保留 Pi 的第 1 到 3 层（模型调用、agent 循环、会话与扩展运行时），自己写第 4 层交互界面，界面和交互按 grok-build 设计。

依据（本文不重复，只引用）：
- [research-pi-sdk-surface.md](notes/research-pi-sdk-surface.md)：Pi 0.87.1 公开了什么、缺什么，下文简称"SDK 笔记"
- [research-interactive-mode-inventory.md](notes/research-interactive-mode-inventory.md)：Pi 交互界面承担的全部功能，下文简称"清单"
- [research-grok-build-tui.md](notes/research-grok-build-tui.md)：grok 的布局、视觉和交互，下文简称"grok 笔记"
- [tui-theme.md](tui-theme.md)：配色映射表（本文 4.9 节的细节）

## 0. 方向变化

上一版（v1）是"扩展皮肤"：继续用 Pi 自带的交互界面，只通过扩展接口换输入框、底栏和配色。你决定改成自己写整个第 4 层，因为皮肤路线改不了消息区、固定顶栏和单块折叠（见第 14 节）。

v1 里仍然有效、搬到本文的内容：
- 先把 Pi 升到 0.87.x，作为单独的第 0 阶段（第 9 节）。全屏渲染器 `TuiAltScreen`、`ScrollView`、`VStack` 都是 0.84 起才有。
- 发布和升级分开，由你决定时机。
- 重跑 benchmark 基线要调用真实模型、产生费用，单独问你。
- grok 配色映射表，已拆到 [tui-theme.md](tui-theme.md)。

v1 里作废的内容：`mmp:ui` 扩展、`--theme` / `--use-theme` 启动参数。交互模式不再经过 `piMain`，这两样都用不上了。

## 1. 待你拍板的决策

| # | 问题 | 我的推荐 | 决定性的理由 | 推翻后影响 |
|---|---|---|---|---|
| D1 | 新界面怎么接 Pi | **进程内调 SDK，用 pi-tui 渲染** | 扩展的 `ctx.ui.custom()` 要返回一个 pi-tui 组件。MMP 内置的 MCP adapter 就调用了 3 次 `custom()`（MCP 面板、设置面板）。走 RPC 子进程时 `custom()` 返回空（Pi 文档 `rpc-extension-ui.md`），这些面板全部失效；换 Ink 或 ratatui 同理 | 选 RPC：MCP 面板要重写，第三方扩展的自定义界面全部不可用 |
| D2 | 屏幕模式 | **v1 只做全屏**（`TuiAltScreen`，和 grok 默认一致） | 固定顶栏、固定状态行和输入框、单块折叠，都要求历史记录由程序自己管理。pi-tui 的全屏渲染器已经带滚动、搜索、拖选复制和鼠标 | 选 inline：顶栏和单块折叠做不了，界面接近 v1 皮肤的效果 |
| D3 | 启动路径 | **非交互模式继续走 `piMain`，只有交互模式走 MMP 自己的启动流程** | print、json、rpc 模式和 `--help`、各种子命令保持现状，benchmark 不受影响 | 全部自己分发：`--help`、`--list-models`、`--export`、auth 子命令都要 MMP 自己写 |
| D4 | 第三方扩展的界面兼容到什么程度 | **扩展界面接口的 28 个方法全部实现**，替换类的方法在 grok 布局里有固定位置（第 6.1 节） | MCP adapter 用到 `custom`、`select`、`input`、`confirm`、`notify`、`setStatus`、`theme`。只做一部分的话，哪个扩展会坏说不准 | 只做子集：要维护一张"哪些扩展能用"的表 |

D3 的代价要说清楚：会有两条启动路径，它们各自解析 settings、项目信任和模型。Pi 升级改了 `main.ts` 之后，两边可能慢慢对不上。缓解办法是第 11 节的启动契约测试。

还有一个方向风险：Pi 上游在试验把交互界面改成"客户端连服务进程"的结构（`experimental/client-tui.ts`，配合 `pi-server`、`pi-client`）。这部分代码不在 npm 包里，也标着实验性，所以不能基于它开发。缓解办法：MMP 和 SDK 之间只隔一层 `session-port` 模块（第 5 节）。以后要换成客户端服务端结构，改动集中在这一层。

## 2. 总体结构

```
mmp <args>
  │
  ├─ resolveAppMode（照抄 Pi main.ts 的 13 行判断）
  │     ├─ print / json / rpc / --help / 子命令 ──▶ piMain(args, { extensionFactories })   现状不变
  │     └─ interactive（stdin、stdout 都是 TTY） ──▼
  │
  ├─ MMP 交互启动（第 3 节）
  │     ├─ createAgentSessionServices({ agentDir, resourceLoaderOptions: { noExtensions…, extensionFactories } })
  │     ├─ createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })
  │     └─ session.bindExtensions({ uiContext, mode: "tui", commandContextActions, abortHandler, shutdownHandler })
  │
  └─ MMP TUI（第 4 节）
        ├─ TuiAltScreen                   全屏渲染、滚动、搜索、鼠标（pi-tui，直接用）
        ├─ 布局：顶栏 / 消息区 / 状态行 / 输入框 / 快捷键栏
        ├─ 消息区：订阅 session 事件，转成消息块
        ├─ 输入：动作表统一驱动按键、快捷键栏和命令面板
        └─ 扩展界面宿主：实现 ExtensionUIContext 的 28 个方法
```

界面完全由代码决定，不涉及 AI agent 或 prompt。唯一会影响模型看到什么的是资源加载参数（第 3.1 节），这部分必须和现在的 `piMain` 路径完全一致。

### 2.1 为什么还用 pi-tui

"第 4 层"指的是 pi-coding-agent 包里的交互界面 `InteractiveMode`，也就是那 6,888 行的应用代码。pi-tui 是另一个包，是它下面的终端渲染库，负责差分重绘、按键解析、编辑器控件和全屏滚动。

对照 grok：

| 角色 | grok-build | MMP |
|---|---|---|
| 终端渲染库 | ratatui + 自研 textarea | pi-tui（保留） |
| 交互应用：布局、消息流、输入、命令 | `xai-grok-pager` | MMP TUI（新写，替换 `InteractiveMode`） |
| agent 与会话 | 另一个进程，走 ACP 协议 | Pi SDK，同一个进程（保留） |

换掉 pi-tui 本身也可以，但扩展的 `custom()` 返回的是 pi-tui 组件，MCP 面板就是这么写的。换掉它就回到了 D1 里被否掉的方案。

### 2.2 组件之间怎么交互

参照 grok 的"动作 → 状态 → 渲染"单向数据流，用最朴素的 TypeScript 写（一个状态对象加一个 `dispatch` 函数），不引入状态管理库。

```
  输入来源                          唯一的状态入口                    副作用出口
  ─────────                         ────────────────                  ──────────
  键盘/鼠标 ─▶ TUI.addInputListener
              └▶ actions：查动作表 ─┐
  SDK 事件 ──▶ session-port ────────┼─▶ store.dispatch(action) ─┬─▶ session-port：prompt / abort / 换会话
  扩展调用 ──▶ ext-host（ctx.ui.*）─┘     改 UiState            ├─▶ ext-host：兑现扩展等待的 Promise
                                          改消息块组件           └─▶ app.requestRender()
                                                                              │
                                             TuiAltScreen 每帧调用各组件 render(width)，只读状态
```

**状态归属**：

| 状态 | 谁持有 | 谁能改 |
|---|---|---|
| 会话事实：消息、模型、思考档位、上下文占用、排队 | Pi SDK | 只能通过 `session-port` 调 SDK 方法改；界面不另存一份，渲染时现读 |
| 界面状态 `UiState`：焦点、运行状态（阶段、开始时间、token 数）、卡片栈、全局折叠开关、欢迎页是否显示、扩展设置的状态文字、widget、footer、header、标题 | `store` | 只有 `dispatch` 里的处理函数 |
| 消息块列表：按顺序排列的块，每块一个组件实例，按 id 索引 | `transcript` | 只有 `dispatch` 里的处理函数，通过 `transcript` 的方法 |
| 输入框的文字、历史、光标 | pi-tui `Editor` 实例（有状态的组件） | 用户输入；`setEditorText` 等通过 `prompt` 模块 |
| 主题 | `theme` 模块和 Pi 的全局主题 | 启动时设置一次 |

**五条规则**：
1. 只有 `session-port` 接触 SDK 的 runtime 和 session 对象，其它模块只拿到普通数据（消息、事件）。以后要换成客户端服务端结构，只改这一个模块。
2. 只有 `dispatch` 能改 `UiState`。处理函数是同步的；异步操作完成后再发一个新的 action 回来，比如 `prompt_failed`。
3. `render(width)` 只读，不改任何状态。
4. 焦点由 `UiState.focus` 决定：输入框、卡片、命令面板、overlay 四选一。只有 action 能改焦点，改完由 `app` 调 `TUI.setFocus`。
5. 按键先到 `addInputListener`。全局键（`Ctrl+C` 等）由动作表处理，并截获这次按键；其余按键交给当前焦点组件的 `handleInput`，比如编辑器打字、卡片选择。

**四个关键流程**：

| 流程 | 顺序 |
|---|---|
| 提交输入 | `Editor` 回调 → `dispatch(submit)` → 依次判断内置命令、`!` bash、压缩中（放进本地队列）、运行中（按排队方式）→ `session-port.prompt(text)`。抛错时 → `dispatch(prompt_failed)` → 消息区出一行提示，文字放回输入框 |
| 流式输出 | SDK 事件 → `session-port` 转发 → `dispatch(agent_event)` → `transcript` 新建或更新对应的块，`UiState` 更新运行状态 → `requestRender()`。多次请求会合并到下一帧（pi-tui 的行为，M2 验证） |
| 扩展弹对话框 | 扩展 `await ctx.ui.select(...)` → `ext-host` 建一个 Promise → `dispatch(card_push)` → 焦点切到卡片 → 用户选完 → `dispatch(card_done)` → `ext-host` 兑现 Promise，卡片出栈，焦点回到输入框 |
| 换会话 | `/resume` → `session-port.switchSession` → SDK 回调 `setBeforeSessionInvalidate` → `dispatch(session_invalidate)`：清掉扩展设置的 widget、footer 等 → SDK 回调 `setRebindSession` → `session-port` 重新订阅，用同一个 `ext-host.uiContext` 重新 `bindExtensions` → `dispatch(session_ready)` → `transcript` 按新会话回放历史 |

这样测试也简单：给 `dispatch` 喂一串 action（其中 SDK 事件可以事先录好），断言 `UiState` 和消息块列表，不需要真终端和真模型（第 11 节的事件序列测试就是这么做）。

## 3. 交互模式的启动流程

Pi 的 `main.ts` 在创建交互界面前做了 30 步，SDK 笔记 1.4 节逐步列了哪些有公开接口。MMP 需要的步骤：

| 步骤 | 做法 | 公开接口 |
|---|---|---|
| 解析参数 | `parseArgs` | 有 |
| 判断模式、管道 stdin 降级为 print | 照抄 `resolveAppMode`（13 行）和管道判断 | 没有，复制 |
| HTTP 代理和超时 | settings 里的 `httpProxy` 和默认 300 秒超时，走 SDK 时会丢。用 undici 的 `EnvHttpProxyAgent` + `setGlobalDispatcher` 重写约 20 行 | 没有，重写 |
| 会话选择：新建、`-c` 继续、`-r` 选择、`--session` | `SessionManager.create/continueRecent/open/list`，`-r` 用 `SessionSelectorComponent` | 有 |
| 项目信任 | `ProjectTrustStore`、`hasTrustRequiringProjectResources`；`resolveProjectTrusted` 和 `createProjectTrustContext` 没导出，要复制。和 MMP 现有 `--approve` 语义对齐 | 部分 |
| 模型和思考档位 | `resolveModelScopeWithDiagnostics`、`resolveCliModel` | 有 |
| 创建 runtime、绑定扩展 | 见第 2 节 | 有 |
| 主题 | 第 4.9 节 | 部分 |
| 确保 `fd`、`rg` 存在，后台刷新模型目录 | Pi 的 `ensureTool`、`refreshModelCatalogs` 没导出。v1 先检测，缺了就报错并提示安装，不自动下载。**这是行为倒退**：现在走 `piMain` 时 Pi 会自动下载。影响多大由探针 S6 确定；如果新机器上 `@` 补全或 grep 工具因此不能用，就把 `ensureTool` 复制进来，改为 v1 必做 | 没有 |
| 启动诊断 | 汇总 services 的 diagnostics，有 error 就退出 | 有 |

**顺序有硬约束，错了会直接崩：**

1. 生成两份主题 JSON，写进 `~/.mmp/pi/themes/`
2. `initTheme(name)` 设置全局主题。Pi 导出的组件通过一个 proxy 读全局主题，没初始化就抛错（`theme.ts:729-731`）
3. `setKeybindings(manager)` 设置全局键位。pi-tui 的 `Editor`、`SelectList` 从这里读键位
4. 创建 `TuiAltScreen` 和各组件
5. `createAgentSessionServices` → `createAgentSessionRuntime`
6. `bindExtensions`，这一步会触发 `session_start`

另外，`initTheme` 遇到有问题的主题文件时会静默退回 system 主题（`theme.ts:756-770`），不报错。所以"两份主题 JSON 完整、正确"要靠单元测试保证：用同一份映射表 `new Theme(...)`，构造不报错（第 11 节）。

不做的步骤：首次运行向导（MMP 有自己的 Manifest）、`pi auth` 子命令（交给 `piMain`）、迁移、弃用警告、Pi 内置的 llama.cpp 扩展（`builtInExtensions` 没导出，放弃）。

### 3.1 不加载 ambient 资源的承诺搬到 SDK 路径

现在靠 `piMain` 的五个 `--no-*` 参数保证。SDK 路径的对应写法（SDK 笔记 1.3 节）：

```
resourceLoaderOptions: {
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  additionalExtensionPaths: <Manifest 声明的外部扩展>,
  extensionFactories: <mmp:runtime / mmp:task / mmp:mcp / mmp:hooks>,
}
agentDir: ~/.mmp/pi（显式传入，同时保留 PI_CODING_AGENT_DIR 环境变量，因为 Pi 内部还有直接读它的地方）
```

回归测试：每个 `--no-*` 参数一条测试，交互和非交互路径各跑一遍。

另外加一条启动契约测试：同一个 Manifest，`piMain` 路径和 SDK 路径生成的 system prompt 和工具列表必须逐字节一致。`piMain` 不会把 session 交出来，所以做法是：加一个只在测试里注入的 inline 扩展，排在所有扩展最后，在 `before_agent_start` 里记录 `event.systemPrompt`（这时已经包含前面各扩展的修改）和 `pi.getAllTools()`。两条路径各触发一轮，比较记录。触发用假的 provider，不调用真实模型，具体做法实现时参照 benchmark 的 fake harness 定。

### 3.2 依赖约束：必须和 Pi 用同一个 pi-tui 实例

pi-tui 的全局键位存在模块级变量里（`keybindings.ts` 的 `let globalKeybindings`），`tui.ts:710` 还有 `instanceof Container` 检查。所以 MMP 的界面代码和 Pi 导出的组件必须用同一个 pi-tui 实例，否则键位设置和组件判断都会错位。

**靠 `package.json` 保证不了。** 第 0 阶段实测发现：pi-coding-agent 发布时带了 `npm-shrinkwrap.json`，npm 会把它依赖的 pi-tui、pi-ai、pi-agent-core 固定装在 `pi-coding-agent/node_modules/` 下面。在空目录里只装这一个包也是这样，`--prefer-dedupe` 也没用。MMP 自己依赖的 pi-tui 永远是顶层的另一份。0.83 时就已经这样，只是 MMP 现在只用了 pi-tui 的纯函数（`truncateToWidth`、`visibleWidth`），所以没出问题。

Pi 加载文件形式的扩展时，会把扩展里的 `@earendil-works/pi-tui` 重定向到它自己那份（`extensions/loader.js` 的 alias），所以第三方扩展没问题。

**做法**：新界面的代码不直接写 `import ... from "@earendil-works/pi-tui"`，统一经过一个 `src/tui/pi-tui.ts`。它从 pi-coding-agent 的安装位置解析 pi-tui（`createRequire` 指向 pi-coding-agent 的 `package.json`），和 Pi 的解析方式一致。类型仍从顶层的 pi-tui 取，两份版本号相同。加一条测试：`src/tui/pi-tui.ts` 拿到的模块和 Pi 组件用的是同一个实例。

**遗留问题已解决（Pi 0.99 升级，2026-09-30）**：这条原本记的是 `mmp:mcp` 用 `tsImport` 从 MMP 的位置加载 pi-mcp-adapter，adapter 里的 `pi-tui`、`pi-ai` 解析到的是顶层那份、和 Pi 不一致，sampling 功能是否受影响没验证过。Pi 0.99 升级把 pi-mcp-adapter 整个去掉，改用 Pi 自己的原生 MCP 扩展（`createMcpExtension`，见 [mcp-design.md](mcp-design.md)），它和 Pi 其余部分一样从 pi-coding-agent 的安装位置解析 pi-tui/pi-ai，不再有这个不一致。

### 3.3 配置隔离：MMP 和 Pi 不共享配置

这是硬约束（你在 2026-09-29 明确要求）。

| 配置 | 放在哪里 | 不能碰 |
|---|---|---|
| Pi 的全局状态：settings、auth、sessions、项目信任、模型目录、主题、键位 | `~/.mmp/pi`（agentDir） | `~/.pi/agent` |
| 项目配置 | `<项目>/.mmp/mmp.json` | `<项目>/.pi/` 下的任何文件，包括 `.pi/settings.json` |

MMP 新写的文件也都在 `~/.mmp/pi` 下：`themes/mmp-grok-*.json`，键位读 `~/.mmp/pi/keybindings.json`。`/resume` 只列 `~/.mmp/pi/sessions` 里的会话，看不到 Pi 的会话。

**已知问题，2026-09-29 实测，Pi 0.83.0 和 0.87.1 结果相同。** 探针脚本：`scratchpad/phase0/config-isolation.sh`（放一份损坏的设置文件，看 Pi 报不报错）、`runtime-settings-probe.sh`（项目设置指定 faux 模型 b，看实际用了哪个模型）。

| 位置 | 不带参数 | `mmp --approve` | `mmp --no-approve` |
|---|---|---|---|
| `~/.pi/agent/settings.json` | 不读 | 不读 | 不读 |
| `<项目>/.pi/settings.json`，启动查找会话阶段（`main.js` 的 `SettingsManager.create(cwd, agentDir)`，影响会话目录、信任默认值等） | **读** | **读** | **读** |
| `<项目>/.pi/settings.json`，运行阶段（模型等全部设置） | 不生效 | 修复前**生效**，2026-09-29 已修复 | 不生效 |

运行阶段的泄漏有具体原因：MMP 把自己的 `--approve` 原样转给了 Pi，而 Pi 的 `--approve` 意思是"信任项目本地文件"。

- **交互路径（新 TUI）**：MMP 自己创建 `SettingsManager` 时传 `projectTrusted: false`，两个阶段都不读项目设置。MMP 的 `--approve` 只决定 `.mmp/mmp.json` 可不可信，**永远不转成 Pi 的项目信任**。
- **非交互路径（仍走 `piMain`）**：运行阶段的泄漏已修复（U4）：MMP 不再把 `--approve` 转给 Pi，并且始终给 Pi 传 `--no-approve`。启动阶段那一次读取在 `piMain` 内部，从外面挡不住，只能等 D3 改成全部走 SDK，或者请上游改。

## 4. 屏幕与交互

### 4.1 布局

```
  ~/proj · main                                   mcp: 3 servers · 18k/200k      ← 顶栏：左 cwd·分支，右 扩展状态·上下文

  ░ ❯ 帮我看下 host.ts 的启动流程                                           ░    ← 用户消息：整块底色，无边框

     ◆ Thought for 2.0s                                                          ← thinking 结束后折叠
     启动分三步……                                                                ← 助手消息：markdown
  ┃  ◆ bash  npm test                                                            ← 运行中的工具：左侧竖条
  ┃    … +120 lines
     ◆ Read 2 files, Searched 1 pattern                                          ← 连续只读工具合并成一行
                                                                   ▼             ← 下方有新内容
  ⠧ Responding… 15s · ⇣9.4k                                                      ← 状态行：只在运行时出现
  ╭──────────────────────────────────────────────────────────────────────╮
  │ ❯ █                                                                  │       ← 输入框
  ╰──────────────────────────────────────────── claude-opus-5-5 · high ─╯
  Ctrl+P:commands  │  Ctrl+O:tools  │  Esc:stop                                  ← 快捷键栏：随焦点变化
```

| 区域 | 内容 | 何时出现 | 对应 grok（grok 笔记 2.1 节） |
|---|---|---|---|
| 顶栏 | cwd、git 分支；右侧是扩展状态（`setStatus`）和上下文占用 | 总是 | 第 1 项 |
| 消息区 | `ScrollView`，自动跟到最新；向上滚时出现 `▼` 提示 | 总是，至少 5 行 | 第 4 项 |
| 扩展 widget | `setWidget` 放在输入框上方或下方 | 有扩展设置时 | — |
| 排队区 | 运行中排队的消息，一条一行 | 有排队时，最多 3 行 | 第 6 项 |
| 状态行 | spinner、活动、耗时、输出 token；重试和压缩也显示在这里 | 只在运行时 | 第 7 项 |
| 输入框 | 圆角框，底边是模型和思考档位。对话框和 `custom()` 面板出现时替换这块区域（4.3 节） | 总是，最高半屏 | 第 13 项 |
| 快捷键栏 | 2 到 4 个当前可用的键，由动作表生成 | 总是 | 第 15 项 |

屏幕很矮时：≤16 行去掉顶栏和快捷键栏，≤12 行把输入框降为 1 行。16 行取自 grok（`agent.rs:86-99`），12 行是我定的。

启动后、第一条消息之前，消息区显示欢迎页（4.8 节）。

### 4.2 消息块

| 类型 | 样式 | Pi 组件能否复用 |
|---|---|---|
| 用户消息 | `❯` 加整块底色 `userMessageBg`，上下各 1 行内边距。带 OSC 133 标记，全屏下可以跳到上一条/下一条提示。超过 3 **逻辑行**（不是屏幕上折行后的行数——窄屏下一整行很长也不会因为折行超过 3 行就被折叠）折叠成前 3 行 + `…`，`Ctrl+O` 展开（2026-09-30 用户在真实终端里实测 grok 1.0.44：粘贴 12 行内容发送后，气泡里只显示前 3 行再加一行 `…`）。从输入框发出的图片，`[Image #N]` 标签就在消息文字里（见 4.3 的“发送”和“编号”行），照原样显示；文字里没有标签的图片内容块（扩展的 `sendUserMessage`、命令行的 `@图片`、D11 之前存的会话）显示成不带编号的 `[Image]`。Pi 追加在文字后面的缩放、格式转换说明（`[Image: original …]`、`[Image converted from …]`）不显示，`[Image omitted: …]` 照常显示（D9）。`@file` 内联的 `<file name="...">...</file>`（file-arguments.ts）显示成 `[File: 文件名]`。这些都只影响这里的显示，模型收到的还是完整内容 | 不复用，自己写。Pi 的 `UserMessageComponent` 样式不同 |
| 助手消息 | markdown，没有标题行 | 复用 `AssistantMessageComponent`（导出），传入扩展的 markdown 变换 |
| thinking | 见下面"M4 视觉细节" | `AssistantMessageComponent` 的 `hideThinking` + `hiddenLabel` 可以做折叠；运行中显示最后 3 行要自己处理 |
| 工具调用 | 运行中：左侧 `┃` 竖条用 `accent` 色；结束：`◆` 加标题一行，失败时标题用 `error` 色。三种状态：折叠、截断、展开 | 自己写卡片外框，内容见下 |
| 连续只读工具 | 连续折叠的 read、grep、find、ls 合并成一行：`◆ Read 2 files, Searched 1 pattern`；中间插入其它工具就断开 | 自己写 |
| 用户 `!` / `!!` 命令 | 流式输出，截断成前 2 行 + `… +N lines` + 后 3 行 | 参照 `BashExecutionComponent`（导出），外框自己写 |
| 扩展消息（`pi.sendMessage`） | 扩展注册了渲染器就用它，否则用通用样式 | 复用 `CustomMessageComponent` |
| 扩展条目（`pi.appendEntry`） | 同上 | Pi 的 `CustomEntryComponent` 没导出，自己写（Pi 的是 62 行） |
| 压缩摘要、分支摘要 | 折叠成一行，可展开 | 复用导出组件 |
| 错误、提示 | 一行，连续的提示原地更新 | 自己写 |

**工具内容怎么渲染。** 7 个内置工具（read、bash、edit、write、grep、find、ls）的 Pi 渲染器共 1,058 行，没有导出。不复制这些代码，按 grok 样式自己写，直接读每个工具结果的 `details` 结构：
- edit、write 的 diff 不带 `+`/`-` 列，只用行底色和行号颜色区分增删；
- read 截断成前 5 行 + `…` + 后 3 行；
- bash 默认折叠，只显示命令。

扩展注册的工具（比如 MCP 工具）用它们自己的 `renderCall` / `renderResult`，放进同一个卡片外框里。既没有内置样式也没有自带渲染器的工具，用通用样式：显示参数 JSON 和结果文本。

**折叠。** `Ctrl+O` 切换所有工具块和折叠的用户消息（上面那行），`Ctrl+T` 切换所有 thinking。单个块用鼠标点标题行切换。快捷键栏对应显示 `Ctrl+o:expand`（不再是 `tools`，因为现在也展开用户消息）。v1 不做键盘逐块选中（grok 的 scrollback 焦点模式），放到 v1.1。

**M4 视觉细节**（2026-09-30 与用户确认。"实测"= 在 Herdr 里跑 grok 1.0.44 看到的；"笔记"= [grok 源码笔记](notes/research-grok-build-tui.md)）

| 项 | 做法 | 来源 |
|---|---|---|
| 助手消息时间 ✓ | 助手消息第一行右侧显示时间（和用户消息一样） | 实测 |
| `Worked for Ns` ✓ | 每轮 agent 结束后，在最后一块下面加一行 `Worked for 6.6s`（muted），时长从 `agent_start` 算到 `agent_end`；中止的轮次写 `Stopped after Ns`：只在用户自己停下这一轮时（Esc、Ctrl+C、运行中扩展的 `ctx.abort()`、运行中 `/tree` 离开、运行中 `/compact`），包括回答已完整、Esc 取消随后的自动压缩；扩展在 `session_before_compact` 里取消压缩不算，仍写 `Worked for`（D17） | 实测（中止的写法是我定的） |
| thinking ✓ | 运行中：`◆ Thinking…` 下面显示 thinking 的最后 3 行（dim）；结束后折叠成一行 `◆ Thought for 2.0s`（◆ 灰色，Thought 粗体 muted），时长从第一个 thinking 事件算到最后一个。`Ctrl+T`（Pi 的 `app.thinking.toggle`）切换全部 thinking 展开/折叠；单击这一行只切换这一条。展开后的正文和 Pi 一样用 `Markdown` 渲染（`thinkingText` 色、斜体，先过 `assistant-thinking` transformer），左边和同一条消息的正文对齐（D22） | 笔记（运行中 3 行、折叠文字和颜色）；Ctrl+T 是 Pi 的键 |
| 连续只读工具合并 ✓ | 连续的已折叠 read、grep、find、ls 合并成一行：`◈ Read 3 files`，多种时 `◈ Read 2 files, Searched 1 pattern, Listed 1 dir`；运行中 `Reading… · 2 completed`，失败的写 `· 1 failed`（error 色）；中间出现别的工具、正文或 thinking 就断开；组内超过 10 项时只显示最近 10 项，更早的收成最前面一行 `◈ N more`（可点开）；`Ctrl+O` 展开时恢复成逐个工具块 | 实测（`◈ Read 3 files`）+ 笔记（其余） |
| 完成闪烁 ✓ | 工具或 thinking 结束时竖条闪一次 `success` 色，400ms | 笔记 |
| 矮屏降级 ✓ | 终端 ≤16 行时去掉顶栏和快捷键栏；≤12 行时输入框最多 1 行 | 笔记（16 行）；12 行是我定的 |

### 4.3 输入框和阻塞卡片

- 编辑器用 pi-tui 的 `Editor`（导出），包括多行、历史、kill ring、撤销和大段粘贴折叠。外面包一层圆角框，底边写上 `模型 · 档位`。边框颜色随思考档位变化，保留 Pi 的这个提示。
- 前缀：普通 `❯ `，bash 模式 `! `；bash 模式下边框变成 `bashMode` 色。
- 补全：`/` 补全命令，包括内置命令、扩展命令、prompt 模板、`skill:*`；`@` 补全文件。都用 pi-tui 的 `CombinedAutocompleteProvider`，下拉框画在输入框上方。
- **阻塞卡片**：扩展调用 `select`、`confirm`、`input`、`editor` 时，对话框占用输入框的位置。
  - v1：外面包一层 grok 卡片外框（左侧竖条、粗体标题），里面直接放 Pi 导出的 `ExtensionSelectorComponent`、`ExtensionInputComponent`、`ExtensionEditorComponent`，列表本身仍是 Pi 的样式。这些组件自己渲染，从外面改不了内部样式，所以 v1 只包外框。
  - v1.1：在 pi-tui 的 `SelectList` 上自己写卡片，做出 grok 的 `(●)` / `(○)` 选项和数字键直选（grok 笔记 2.3 节）。
  - `custom()` 在非 overlay 模式下同样占用这个位置，overlay 模式用 pi-tui 的 overlay。
- 同时有多个卡片时排队，一次只显示一个。Esc 等于"取消"，扩展收到的结果是 `undefined`，和 Pi 现在的行为一致。

**粘贴标签和预览浮窗**（2026-09-29 用户确认，照 grok 的实际行为，在 Herdr 里试过 grok 1.0.44）。这是界面层面对 Pi 的改动：Pi 只把长粘贴折叠成 `[paste #1 +N lines]`，图片只插入临时文件路径。

| | 长文本 | 图片 |
|---|---|---|
| 何时变成标签 | 一次粘贴 ≥4 行 → `[Pasted: N lines]`；>10KB → `[Pasted: 12 KB]` | Ctrl+V 贴图片、`@图片`、拖进终端的图片路径 → `[Image #N]` |
| 标签 | 原子：光标不能停在标签中间，退格一次删掉整个标签 | 同左 |
| 预览浮窗 | 刚粘贴完、或光标落在标签上时，在输入框上方显示：前 3 行、`⋮ (N more lines)`、后 3 行，底边提示 `enter or double-click to expand`（刚粘贴时提示 `paste again or double-click to expand`）。光标离开就消失 | 光标落在标签上时显示，标题 `Image #1 ─ PNG · 64x40 · 5.0 KB`，框里用终端图形协议画图（pi-tui 的 `Image` 组件）；终端不支持图形时只显示标题行 |
| 展开 | 光标**真正落在**标签上（不是刚粘贴完、光标停在标签末尾那一下——grok 1.0.44 里两者不同：刚粘贴完底栏是 `Enter:send`、浮窗提示 `paste again or double-click to expand`；光标移到标签上后底栏才变成 `Enter:expand │ Shift+Enter:newline`、浮窗提示 `enter or double-click to expand`）时按 Enter、双击标签、或刚粘贴时再粘贴一次 → 标签换成全文 | 不展开；Enter 照常发送 |
| 发送 | 标签换成全文后发给模型 | 图片作为图片附在消息里（`session.prompt(text, { images })`），不再让模型用 read 工具去读文件。`[Image #N]` 标签留在文字里一起发出，模型也看得到，用户可以说“第 2 张图”（照 Claude Code；D11，2026-09-30 主控定）。同一个标签在文字里出现几次，图片都只附一次，按标签第一次出现的顺序（D20） |
| 编号 | — | 一个会话一套编号。新标签的编号 = 会话里用户消息文字中最大的 `[Image #N]`（已显示的，和已交给会话、还在排队或在路上的）与输入框里的标签取最大值再加 1。`/new` 从 #1 开始；`/resume`、`/switchto`、`/import`、`/fork`、`/clone`、`--resume` 按回放出来的历史里的标签接着编。发出去的编号就算用掉了：Pi 丢掉图片（`[Image omitted: …]`）或扩展的 `input` 处理器吃掉消息，编号都不回收。发送前删掉的标签在输入框里留下空号，已有标签不重新编号。发出去的文字回到输入框时（发送失败、Esc / Alt+Up 取回排队消息、`/fork`、`/tree`），每张图按它发出时的编号挂回对应标签，不按位置（`/fork`、`/tree` 从存下的消息取图：文字里不同标签的个数和图片数相等才能确定对应关系，否则不挂；文字里一个标签都没有时（命令行 `@图片` 的消息、扩展的图片），图片作为新标签加在末尾，不丢图——Pi 自己的 `/fork` 只回填文字，图片直接丢掉（D20））。输入框里没有图片数据的 `[Image #N]`（手打的、从历史里翻出来的、取不回图的）画成暗色加删除线，不是标签（没有预览，退格逐字删；折行把它拆成两行、光标停在它中间时也照样画）；带着它发送时提示 `No image attached for [Image #N]; sent as text.`（D11 第 4 轮，2026-09-30 主控定）。压缩之后，当前分支上被压缩掉的用户消息里的标签仍然算用过（摘要里可能还提到它们），`/resume`、`/reload`、`/tree` 之后新图也接在它们后面 |

### 4.4 状态行

- 格式：`⠧ Responding… 15s · ⇣9.4k`。活动文字依次是 `Thinking…`、`Responding…`、`Running <工具名>…`。
- token 数：provider 流式输出时不回报 usage 的，用估算值，前面加 `~`。
- 自动重试、压缩、分支摘要重试也显示在这一行，比如 `⟳ Retrying (2/3) in 4s`；这时 Esc 中止的是对应的那个操作。
- 扩展调 `setWorkingMessage`、`setWorkingIndicator` 时，替换的是这一行的文字和帧。
- 终端 tab 标题同步显示 spinner 和活动（grok 的做法），每 264ms 更新一帧。扩展调用 `setTitle` 设置标题时，以扩展的为准，直到它清掉为止。

### 4.5 顶栏和快捷键栏

- 顶栏右侧依次是：扩展状态（MCP adapter 通过 `setStatus` 报告连接状态）、上下文 `18k/200k`。上下文剩余低于 20% 用 `warning` 色，低于 10% 用 `error` 色。
- 快捷键栏由动作表生成（4.7 节），只显示当前焦点下可用的动作，比如输入框里、卡片上、运行中各不一样。
- 扩展调 `setFooter` 时，它的组件替换快捷键栏。调 `setFooter(undefined)` 恢复。
- MMP 有新版时，快捷键栏右侧右对齐显示 `Update available! Run: mmp update`，用 `warning` 色，和 Claude Code 的位置一致。窄屏时先丢掉这一段。检查逻辑见 [pi-upgrade-design.md](pi-upgrade-design.md) 5.1 节。

### 4.6 命令

**命令面板**：`Ctrl+P` 打开浮层，模糊搜索所有命令，分组显示（会话、模型、上下文、其它），右侧显示快捷键。数据来自动作表和扩展注册的命令。

**优先级**（2026-09-29 与用户确认；✓ 为已完成）。Pi 有 24 个内置命令，都要在 MMP 里重新接线。命令表在 `src/tui/builtins.ts`，键位表在 `src/tui/keys.ts`；未接线的命令在补全里标 `(not yet)`，输入后提示尚未支持（不再有经典界面可以退回去用，见 [decisions.md](decisions.md) M5）。

| 级别 | 内容 | 实现 |
|---|---|---|
| 已完成 | `/login`、`/logout`、`/model`、`/new`、`/quit`、`/trust` | `commands.ts`；`runtime.newSession`；`/trust` 复用 `src/trust-prompt.ts`（DEVELOPMENT.md 8.2 节） |
| P0 ✓ | 补全列出全部命令、prompt 模板和 `/skill:*` | `slashCompletions`（已完成） |
| P0 ✓ | `/compact [指令]` | `session.compact` |
| P0 ✓ | `/resume` | `SessionSelectorComponent`（导出）+ `runtime.switchSession` |
| P0 ✓ | `/thinking [档位]` | `ThinkingSelectorComponent`（导出） |
| P0 ✓ | `/copy`、`Ctrl+X` | `getLastAssistantText` + `copyToClipboard` |
| P0 ✓ | `/reload` | `session.reload()`，然后重建宿主状态（6.3 节） |
| P0 ✓ | `!命令`、`!!命令` | `session.executeBash` + `BashExecutionComponent`（导出） |
| P0 ✓ | 键位：`Ctrl+L`、`Alt+Enter`、`Alt+↑`、`Ctrl+G`、`Ctrl+V`、`Ctrl+Z`，以及运行中排队消息的显示 | 各自一个 SDK 调用或 pi-tui 功能 |
| P0 ✓ | `Ctrl+T` 折叠 thinking | 和 M4 的 `Thought for Ns` 一起做完（`src/tui/keys.ts` 的 `app.thinking.toggle`） |
| P1 ✓ | `/tree`、`/fork`、`/clone`、`/name`、`/session`、`/export`、`/import`、`/hotkeys` | `session-tree-commands.ts`（`/tree`、`/fork`、`/clone`）、`info-commands.ts`（`/name`、`/session`、`/hotkeys`、`/scoped-models`）、`export-commands.ts`（`/export`、`/import`）；见下方"2026-09-29 补充"表 |
| P2 | `/settings` | 里面有些项只对 Pi 自己的界面有意义，要先挑出适用于 MMP 的；`/scoped-models` 已随 P1 一起做完（见下） |

**2026-09-29 补充（推翻原先的"不做"）**：`/share`、`/bug`、`/changelog` 原计划不做，用户当天改口要求实现，语义和 Pi 不同：`/share` 跟 Pi 一样（去掉 Pi 专属的 Radius 上传和预览页，只保留 `gh gist create` 分支）；`/bug` 不上报给 Pi 开发者，改成在 MMP 自己的 GitHub 仓库开一个预填内容的 issue 链接；`/changelog` 读 MMP 自己仓库的 GitHub Releases，不是 Pi 的内置更新日志文件。实现在 `share-commands.ts`。彩蛋命令仍然不做。

**2026-09-29 补充：P1/P2 命令的接线细节和与 Pi 的差异**

| 命令 | 对应的 Pi 函数 | 复用 | 和 Pi 的差异 |
|---|---|---|---|
| `/tree` | `showTreeSelector` | `TreeSelectorComponent`（导出） | `session.navigateTree` 不走 `AgentSessionRuntime`，不会触发 `setRebindSession`；`CommandHost.resetTranscript()`（新增，app.ts 里就是 `transcript.reset(session)`）在导航成功后手动重放，`commandContextActions.navigateTree`（扩展用的同一个动作）也包了一层做同样的事。分支摘要的"总结中"状态用一条 notice 代替 Pi 的 `BranchSummaryStatusIndicator`（未导出） |
| `/fork` | `showUserMessageSelector` | `UserMessageSelectorComponent`（导出） | 这个组件的按键处理只在内部的 `getMessageList()` 上，不在外层容器；`CommandHost.takeEditorSlot` 加了第二个可选参数 `focus`，对齐 Pi `showSelector` 的 `{component, focus}` |
| `/clone` | `handleCloneCommand` | — | 一致 |
| `/name` | `handleNameCommand` | — | 一致 |
| `/session` | `handleSessionCommand` | — | 按模型的费用明细自己按 `getEntries()` 分组求和（每条 assistant 消息自带 `usage.cost`，不用查价目表），比 Pi 内部的 `getUsageCostBreakdown` 简单；缓存浪费和 Cache Warming 两节没做（`computeCacheWaste`、`formatCacheWarmingStatus` 都没导出） |
| `/export` | `handleExportCommand` | `session.exportToHtml`/`exportToJsonl` | 路径参数只支持整段或整段加引号，不支持 Pi 那种"带引号的一部分 + 后续参数"写法 |
| `/import` | `handleImportCommand` | — | 复用 `/resume` 的 `crossProjectRefusal`；`MissingSessionCwdError`（没导出）直接显示错误，不做 Pi 那个"缺 cwd 时手动选一个"的对话框 |
| `/hotkeys` | `handleHotkeysCommand` | `keyText`（导出） | 不照抄 Pi 固定的大表，只列 MMP 实际接线的键（`src/tui/keys.ts` 的动作 id 去重 + 编辑器一部分常用键），键位经过安装好的 `KeybindingsManager` 解析，用户的 remap 会显示出来 |
| `/scoped-models` | `showModelsSelector` | `ScopedModelsSelectorComponent`（**未在包的 `exports` 字段里**，和 `KeybindingsManager` 一样从 Pi 安装目录按文件路径直接 import） | 用公开的 `modelRuntime.refresh()` 打开前刷新一次模型目录，不是 Pi 内部 `refreshModelCatalogs` 那种带实时状态文字、可超时中止的后台刷新 |
| `/share` | `shareSession` | `BorderedLoader`（导出）+ `session.exportToHtml` | 不做 Radius 上传（Pi 自己的托管服务，MMP 没有对应身份）；成功后打印原始 gist URL，不是 Pi 的 `getShareViewerUrl` 预览页（没导出）。Pi 本来就没有确认对话框，只有 loader 的 Esc 取消，这点照抄 |
| `/bug` | 不对应 Pi 的 `/bug`（那个上传给 Pi 开发者） | `session.summarizeForBugReport`（导出）、`BorderedLoader` | 同意 → 描述（可选）→ 是否附加当前模型写的摘要 → 在 MMP 自己仓库开一个预填标题/正文的 `issues/new` 链接，打印出来并尝试用系统默认方式打开；正文按 URL 长度上限截断并注明 |
| `/changelog` | 不对应 Pi 的 `/changelog`（那个读 Pi 自带的更新日志文件） | 复用 `src/update.ts` 的仓库常量（新增 `MMP_REPO` 导出） | 读 GitHub Releases 列表（`/releases`），不是 `mmp update` 用的 `/releases/latest`；离线（`PI_OFFLINE`）时给出明确提示，不发请求 |

测试：`test/tui-commands-session-tree.test.mjs`、`test/tui-commands-export-import.test.mjs`、`test/tui-commands-info.test.mjs`、`test/tui-commands-share.test.mjs`。

扩展命令、prompt 模板和 skill 命令不用宿主执行，交给 `session.prompt("/名字 参数")` 即可（SDK 笔记第 4 节）。宿主只拦截自己的内置命令。

### 4.7 动作表与键位

参照 grok 的 `ActionRegistry`：一张动作表同时驱动按键分发、快捷键栏和命令面板。

**兼容约束。** 扩展的 `custom()` 组件会调用 `keybindings.matches(data, "app.xxx")` 或 `"tui.select.up"`（MCP adapter 用的就是 `tui.select.*`）。所以动作表必须注册 Pi 的全部 `app.*` 和 `tui.*` 键位 id，并读取用户的 `~/.mmp/pi/keybindings.json`。`tui.*` 由 pi-tui 导出。`app.*` 的定义没有导出，复制约 114 行，并加上 MIT 声明。

**和 Pi 默认键位不同的地方**。这些是我按 grok 定的，你可以改：

| 键 | Pi | MMP | 理由 |
|---|---|---|---|
| `Ctrl+P` | 切换到下一个模型 | 命令面板 | grok 的核心入口；切模型走 `/model` 或面板 |
| 运行中按 `Enter` | steer：插进当前这轮 | follow-up：排到这轮结束后 | grok 的语义，行为更可预测 |
| 运行中按 `Alt+Enter` | follow-up | steer | 和上一条对调 |
| `Esc`（运行中） | 中止 | 中止（不变） | grok 要求按 Ctrl+C 才取消，但 Pi 用户已经习惯 Esc |
| `Ctrl+C` | 清空输入，连按两次退出 | 输入非空时清空；输入为空时中止；连按两次退出 | 合并两边 |
| `Shift+Tab` | 切换思考档位 | 不变 | MMP 没有 grok 的权限模式，不冲突 |

按 K1，`app.model.cycleForward`/`cycleBackward` 在 MMP 里默认不绑键（`src/tui/keybindings.ts` 的 `MMP_DEFAULT_KEYS`），用户可以在 `~/.mmp/pi/keybindings.json` 里绑，绑了之后行为照抄 Pi 的 `cycleModel`（结果用角落的 flash 提示）。`Ctrl+Up`/`Ctrl+Down`（跳到上/下一条提问或最终回答）和 `Ctrl+Shift+F`（搜索对话）由 pi-tui 的 `TuiAltScreen` 自己处理；跳转靠 OSC 133 标记，MMP 的用户消息和不含工具调用的助手消息各标一个区域，和 Pi 一样（dogfood D10）。

### 4.8 欢迎页

- 这是界面自己的组件，数据来自 MMP 现有的运行时身份：MMP_HOME、Manifest 状态、已加载资源。排版按 grok 欢迎页（grok 笔记 2.4 节）：宽度 ≥90 列时 logo 和信息左右两栏，外加圆角框；窄屏时上下排列。
- M2 完成后，交互模式不再经过 `piMain`，非交互模式又会被 `context.mode !== "tui"` 挡掉，所以 `mmp:runtime` 里调用 `setHeader` 的代码再也执行不到。M2 时直接删掉这段；`startup-page.ts` 里整理身份数据的部分留给欢迎页复用。
- 第一条消息发出后，欢迎页从消息区移除。

### 4.9 主题

- **Pi 组件怎么用上 grok 配色。** 复用的 Pi 组件从全局主题取色。公开接口里能设置全局主题的只有 `initTheme(name)`，它会到 `<agentDir>/themes/<name>.json` 找主题文件（`theme.ts:551`、`config.ts:537`）。所以 MMP 启动时按 [tui-theme.md](tui-theme.md) 的映射表生成 `mmp-grok-night.json`、`mmp-grok-day.json`，写进 `~/.mmp/pi/themes/`（MMP 自己的目录），再调用 `initTheme`。
- **MMP 自己的组件和扩展的 `ui.theme` 用哪个 `Theme` 对象。** 用同一份映射表直接 `new Theme(fg, bg, mode, { name, appearance })`（`Theme` 已导出）。`mode` 由 `getCapabilities().trueColor ? "truecolor" : "256color"` 得出：pi-tui 导出了 `getCapabilities`，Pi 自己的 `getTerminalColorMode` 没导出，但内容就是这一行（`terminal-image.ts:172`）。全局主题和这个实例来自同一份数据，颜色自然一致，不用去读 `globalThis` 上的私有 symbol。
- **明暗怎么选。** v1：看 `COLORFGBG`，没有就默认暗色。查询终端背景色（发送 `OSC 11 ?`，带超时等回复，再用 `parseOsc11BackgroundColor` 解析）是探针 S7。这个函数在已发布的 0.87.1 里有，在上游 main 里已经没有了，可能会被删掉；而且发查询、等回复要 MMP 自己写，tmux 下有兼容问题。终端切换明暗后跟着换，放到 v1.1。
- grok 有而 Pi 主题没有的颜色（`accent_running` 等）先映射到最接近的 Pi token，不另立一套 token。

## 5. 模块

"复用"一列：E = Pi 导出，直接 import；V = 复制 Pi 的代码并加 MIT 声明；N = 新写。行数都是估算。

| 目录/文件 | 职责 | 复用 | 估计行数 |
|---|---|---|---|
| `src/tui/start.ts` | 模式判断、交互启动流程（第 3 节）、HTTP 设置 | N + V（`resolveAppMode`、信任流程） | 350 |
| `src/tui/session-port.ts` | MMP 和 SDK 之间唯一的接触面：runtime、会话切换、prompt、abort、事件订阅 | N，调用 E | 250 |
| `src/tui/store.ts` | `UiState`、action 类型、`dispatch`（2.2 节） | N | 300 |
| `src/tui/pi-tui.ts` | 从 pi-coding-agent 的位置解析 pi-tui，保证和 Pi 用同一个实例（3.2 节） | N | 30 |
| `src/tui/app.ts` | 组装 `TuiAltScreen` 和布局，管理焦点 | N | 300 |
| `src/tui/transcript/` | 事件转消息块、历史回放（启动、resume、压缩后重排） | N，组件部分 E | 700 |
| `src/tui/blocks/` | 用户消息、thinking、工具卡片外框、只读工具合并、摘要、错误 | N | 600 |
| `src/tui/tools/` | 7 个内置工具的 grok 样式渲染 | N | 700 |
| `src/tui/prompt/` | 输入框外框、提交分发、`!` bash、排队、补全 | N，编辑器 E | 550 |
| `src/tui/cards/` | 阻塞卡片外观与排队 | N，逻辑 E | 250 |
| `src/tui/chrome/` | 顶栏、状态行、快捷键栏、欢迎页、tab 标题 | N | 450 |
| `src/tui/actions/` | 动作表、键位、命令面板 | N + V（`app.*` 定义 114 行） | 450 |
| `src/tui/commands/` | v1 的内置命令，其中登录约 400 | N，选择器 E | 750 |
| `src/tui/ext-host/` | `ExtensionUIContext` 28 个方法、`commandContextActions`、换会话后重建 | N，参照 RPC 模式的实现 | 650 |
| `src/tui/lifecycle.ts` | 退出顺序、信号、终端断开紧急退出、未捕获异常恢复终端、`Ctrl+Z` | N | 200 |
| `src/tui/theme/` | 两份主题 JSON 的生成与写入、明暗选择 | N | 250 |
| 合计 | | | 约 6,780 |

对比：Pi 自己的交互界面是 6,888 行主文件加 10,188 行组件。MMP 少写的部分来自三处：直接用 Pi 导出的组件，只做 v1 的命令，砍掉资源清单、更新提示、分享等功能（清单 2.12 节）。

第三方代码声明：仓库根目录加 `THIRD_PARTY_NOTICES.md`，列出 Pi（MIT，Copyright (c) 2025 Mario Zechner）和 pi-grok-tui（如有借用，MIT，Copyright (c) 2026 Lawrence）。每个复制了代码的文件，在文件头放完整的许可声明。

## 6. 扩展兼容

### 6.1 28 个方法放在哪里

| 方法 | 在新界面里的表现 |
|---|---|
| `select` / `confirm` / `input` / `editor` | 阻塞卡片，占用输入框位置（4.3 节）；支持 `signal` 和 `timeout` |
| `custom` | 非 overlay：占用输入框位置；overlay：pi-tui overlay |
| `notify` | 消息区里的一行提示 |
| `setStatus` | 顶栏右侧 |
| `setWidget` | 输入框上方或下方 |
| `setHeader` | 放在消息区的最上面，会随内容滚走 |
| `setFooter` | 替换快捷键栏 |
| `setEditorComponent` / `getEditorComponent` | 替换圆角框里面的编辑器，外框保留。扩展的工厂函数要一个 `EditorTheme`，Pi 的 `getEditorTheme` 没导出，MMP 从自己的 `Theme` 实例构造 |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` | 状态行 |
| `setHiddenThinkingLabel` | 折叠后的 thinking 标题 |
| `setTitle` | 终端 tab 标题 |
| `onTerminalInput` | 在动作表之前拿到原始输入 |
| `pasteToEditor` / `setEditorText` / `getEditorText` / `addAutocompleteProvider` | 转给输入框 |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | MMP 构造的 `Theme` 实例（4.9 节）；v1 的 `setTheme` 只接受 MMP 的两套主题 |
| `getToolsExpanded` / `setToolsExpanded` | 对应 `Ctrl+O` 的全局状态 |

### 6.2 绑定扩展时必须传的东西

- `commandContextActions`：`waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`。不传的话，扩展命令里的 `ctx.newSession()` 什么都不做，也不报错。`fork` 和 `navigateTree` 现在也有对应的界面命令了（`/fork`、`/tree`，2026-09-29，见 4.6 节）；`navigateTree` 这个动作和 `/tree` 命令一样，手动重放 transcript（`session.navigateTree` 不触发 `setRebindSession`）。
- `abortHandler`、`shutdownHandler`、`onError`。
- `mode: "tui"`。扩展靠它判断能不能调 `custom()`。
- 时序：`bindExtensions` 最后会触发 `session_start`，扩展可能在那里就调用界面方法，所以 `uiContext` 必须在绑定前全部可用。

### 6.3 换会话后要重建的宿主状态

`/new`、`/resume`、`/fork`、`/reload` 之后，SDK 会拆掉旧会话、建新会话。宿主要按这张表重建：

| 状态 | 处理 |
|---|---|
| 事件订阅 | 取消旧的，订阅新 session |
| 扩展绑定 | 在 `setRebindSession` 回调里重新 `bindExtensions`；`reload` 由 SDK 自动重新挂 |
| 消息区 | 清空，按新会话回放历史 |
| 补全 provider、扩展快捷键、扩展命令列表 | 重新读取 |
| widget、header、footer、编辑器替换、working 设置、状态 | 在 `setBeforeSessionInvalidate` 里清掉，等扩展在 `session_start` 里重新设置 |
| 排队区、状态行计时 | 清空 |

## 7. 错误处理与生命周期

- **`session.prompt()` 会抛错**，情况有四种：压缩进行中、流式输出时没给排队方式、没有模型、provider 没配认证。提交分发统一处理，每种情况给出明确提示（比如"没有模型，用 /model 选择"或"没登录，用 /login"），不能崩，也不能静默丢掉用户输入。
- **压缩期间的输入**：放进本地队列，压缩结束后再发，和 Pi 行为一致。
- **中止**：Esc 按当前状态判断中止哪一个：turn、用户 bash、压缩、重试或分支摘要。中止 turn 时，排队的消息放回输入框。
- **退出**：先停 TUI，再发 `session_shutdown`，排掉残留的 Kitty 按键释放事件，最后打印 `mmp -r` 恢复提示。
- **终端**：`SIGTERM`、`SIGHUP`、终端断开（EIO、EPIPE）时紧急退出；未捕获异常时先恢复终端再打印堆栈；`Ctrl+Z` 挂起后恢复要重画。

## 8. 范围

**v1**：清单第 5 节的 15 项必留功能，加上不需要额外数据的 grok 界面：
- 布局：顶栏、状态行、圆角输入框、快捷键栏、欢迎页；
- 消息块：用户消息块样式、`Thought for Ns`、工具卡片三态、只读工具合并、点击单块折叠；
- 交互：命令面板、阻塞卡片外框、动作表；
- 配色：grok 暗色和亮色。

**v1.1**：
- 第 4.6 节列出的命令；
- 键盘逐块选中；
- 自己写的阻塞卡片（`(●)` / `(○)`、数字键直选），thinking 运行中显示最后 3 行；
- inline 模式；
- 终端切换明暗时跟着换主题；
- 退出全屏时把聊天记录打印回终端；
- 待办和任务面板。`mmp:task` 在同一个进程里，已经有 `todo` 和 `task` 工具的数据，所以可以做，但 v1 不做。

**以后再说**：grok 的权限模式切换（MMP 没有工具审批）、多会话和 Dashboard、子代理全屏视图、Minimal 模式、`/btw`、语音、草稿暂存、图片 chip。

**不做**：资源清单页、遥测、Mermaid、Pi 内置的 llama.cpp 扩展、彩蛋命令。`/share`、`/bug`、`/changelog` 已改为做（2026-09-29，见 4.6 节），更新提示见 4.5 节（`pi-upgrade-design.md`）。

## 9. 第 0 阶段：升级 Pi 到 0.87.x

在新分支上做，什么时候提交由你决定。

| 地方 | 要做的 |
|---|---|
| `package.json` | `pi-coding-agent`、`pi-tui`、`pi-ai` 都改成 0.87.x 的精确版本。嵌套安装是 Pi 的 shrinkwrap 决定的，去不掉（3.2 节） |
| `pi-mcp-adapter` 2.17.0（历史：这一步是 0.87 升级时做的；Pi 0.99 升级已经把 `pi-mcp-adapter` 整个去掉，改用 Pi 原生 MCP，见 [mcp-design.md](mcp-design.md)） | 重跑 DEVELOPMENT.md 里的真实 stdio MCP `search → call` 验收 |
| 版本字面量 | `MMP_HELP`、各测试、`fixtures/fake-benchmark-harness.mjs`、benchmark 的 `EXPECTED_PI_VERSION` 和变体名 |
| 文档 | README、DEVELOPMENT.md 里的 0.83 |
| 回归 | 对照 0.84 到 0.87 的 CHANGELOG，检查 MMP 用到的 Pi 接口 |
| ambient 资源 | 五个 `--no-*` 参数各一条测试；`PI_CODING_AGENT_DIR` 仍然生效；两个版本 `pi --help` 输出对比，确认没有新的自动发现来源 |
| 配置隔离（3.3 节） | 临时项目里放一份 `.pi/settings.json`，写一个能观察到效果的设置；`HOME` 下放一份 `~/.pi/agent/settings.json`。确认 0.83 和 0.87 都不生效；如果 0.83 就已经生效，说明是现有问题，单独报告 |
| 发布 | 不在这个阶段。发布时再改 `MMP_VERSION`，重打 tarball 和 SHA-256，更新 `install.sh` 和 README 里的下载地址 |
| benchmark 基线 | 契约测试随 `npm test` 跑；重跑基线会产生费用，单独问你 |

## 10. 探针

写正式代码前先做，每个都有通过条件。

| # | 问题 | 通过条件 |
|---|---|---|
| S1 | 在 `InteractiveMode` 之外，`SessionSelectorComponent`、`ModelSelectorComponent`、`LoginDialogComponent` 能不能直接用（会不会依赖 Pi 的全局键位和焦点约定） | 在一个最小的 `TuiAltScreen` 里挂上去，能打开、选中、取消 |
| S2 | 扩展的 `pi.sendMessage` 会不会显示两次：同一条消息既走 `message_start/end` 事件，又走 `entry_appended` | 读 Pi 的去重逻辑，并用一个发消息的测试扩展实测：只显示一次 |
| S3 | 4.9 节的做法（全局主题和 MMP 构造的 `Theme` 实例来自同一份映射表）实际是否颜色一致 | Pi 导出的组件和扩展 `custom()` 画出来的颜色完全一致 |
| S4 | `TuiAltScreen` 在 tmux、Zellij、Ghostty、iTerm2 里的表现 | 滚动、鼠标、拖选复制都正常；有问题的终端记下来，决定是否提前做 inline |
| S5 | MCP adapter 的面板在新宿主里能不能正常工作 | 打开 MCP 面板和设置面板，上下选择、确认、退出都正常，键位来自 `tui.select.*`。`custom()` 传给扩展的是 pi-tui 的 `KeybindingsManager`（登记了 `app.*` id），类型上 Pi 声明的是 coding-agent 的同名类，要确认 MCP 面板能正常使用 |
| S6 | 没有 `ensureTool` 时，`@` 补全和 grep 工具缺少 `fd`、`rg` 会怎样 | 在没装 `fd`、`rg` 的环境里跑一次：缺工具时有明确报错，不静默失效；据此决定是否把 `ensureTool` 放进 v1（第 3 节） |
| S7 | 启动时查询终端背景色选明暗 | 在 Ghostty、iTerm2、tmux 里，暗色和亮色配置都选对；终端不回复时 200ms（我定）内退回 `COLORFGBG`，不卡启动 |

## 11. 测试

- **启动契约**：同一个 Manifest，`piMain` 和 SDK 两条路径的 system prompt 和工具列表逐字节一致（3.1 节）。
- **ambient 资源**：每个 `--no-*` 参数一条，交互和非交互路径各跑一遍。
- **配置隔离**：`.pi/settings.json` 和 `~/.pi/agent/` 下的配置在两条路径上都不生效（3.3 节）。
- **宽度**：每个 chrome 组件和消息块在 40、80、120 列下渲染，每行 `visibleWidth(line) <= width`，用例里包含中文路径。
- **事件序列**：用录制的事件序列驱动消息区，断言块的顺序和状态，覆盖流式、中止、重试、压缩后重排。
- **扩展宿主**：用 mock 扩展逐个调用 28 个方法；换会话后没有残留的 widget、状态和订阅；`ctx.newSession()` 真的会新建会话。
- **键位**：`app.*`、`tui.*` 的 id 全部注册；用户 `keybindings.json` 的覆盖生效。
- **错误**：`prompt()` 的四种抛错都有提示，用户输入不丢。
- **冒烟**：真实模型跑一轮带工具调用的会话，80 和 120 列、暗色和亮色终端各截一张图，存到 `docs/notes/`。
- **主题**：两套色值各 `new Theme(...)` 一次，构造不报错，证明必填 token 一个不缺。不能靠 `initTheme`，它出错时静默回退。
- **回归**：`npm test` 全部通过，包括 benchmark 契约测试。

## 12. 实施顺序

先做一个能从头用到尾的最小版本，再往上加。

| 步 | 内容 | 验收 |
|---|---|---|
| M0 | 第 0 阶段升级 | 现有测试、MCP 真实验收、冒烟通过 |
| M1 | 探针 S1 到 S7 | 各自的通过条件 |
| M2 | 能用的最小版本：启动流程、session-port、全屏布局、消息区（先用 Pi 导出的组件）、输入和提交、中止、退出 | 能对话（用已有凭证）、调用工具、中止、退出；启动契约测试通过 |
| M3 | 扩展宿主和 v1 命令 | MCP 面板可用；`/model`、`/login`、`/resume`、`/compact`、`/reload` 可用；扩展宿主测试通过 |
| M4 | grok 界面：消息块、工具渲染、合并、卡片、顶栏、状态行、快捷键栏、命令面板、欢迎页、主题 | 宽度测试；截图对照 |
| M5 | 收尾：错误提示、生命周期、文档 | 全部测试；冒烟截图 |

M2 结束时就能日常使用，只是样子还接近 Pi。M4 才换成 grok 的外观。

## 13. 风险与已知限制

- **上游方向**：Pi 可能把交互层改成客户端服务端结构（第 1 节）。靠 `session-port` 隔离。
- **两条启动路径可能不一致**（D3）。靠启动契约测试发现。
- **复制的代码要跟着升级同步**：`app.*` 键位定义、`resolveAppMode`、信任流程。每一处复制和每一个用到的 Pi 接口，都是每次升级的成本。所以 D1 到 D4 的选择也带着升级成本；复制代码的规则和漂移检查见 [pi-upgrade-design.md](pi-upgrade-design.md) 第 6 节。
- **全屏模式的代价**：终端原生的 scrollback 和选择不能用，改用 pi-tui 自带的滚动和拖选复制；v1 退出后聊天记录不留在终端里。
- **Pi 以后新增的交互功能不会自动出现在 MMP 里**，要自己决定跟不跟。
- **新代码约 6,780 行**（估算），是 v1 皮肤方案的 11 倍。

## 15. 实施进度（2026-09-29）

| 步 | 状态 |
|---|---|
| M0 升级 Pi | 完成（0.87.1），见 [decisions.md](decisions.md) P0 |
| M1 探针 | 并进 M2 一起做。已验证：S2（扩展消息只显示一次）、S3（全局主题和 MMP 的 Theme 颜色一致，有测试）、S5（MCP adapter 在新宿主里正常连接；`custom()` 面板和 `tui.select.*` 键位正常，用测试扩展验证，因为 MMP 的配置方式下 `/mcp` 不弹面板）。未做：S1（Pi 的选择器组件，M3 用到时验证）、S4（各终端表现）、S6（缺 fd/rg）、S7（查询终端背景色） |
| M2 最小可用版本 | 完成 v0，当时放在 `MMP_TUI=v2` 开关后面（经典界面仍是默认，因为 `/login` 还只有经典界面有）。代码在 `src/tui/`，约 1,080 行。**开关已在 2026-09-29 去掉**（见 [decisions.md](decisions.md) M5）：交互模式只走这条路径，不再有经典界面可退回 |
| M3 内置命令 | P0 完成（`Ctrl+T` 除外，随 M4 做）：补全、`/compact` `/resume` `/thinking` `/copy` `/reload`、`!` 命令、常用键位和排队显示。由 3 个 Sonnet subagent 分别在独立 worktree 里写，审查后合并。P1 完成（2026-09-29，另一个 Sonnet subagent）：`/tree` `/fork` `/clone` `/name` `/session` `/export` `/import` `/hotkeys`，以及原计划不做后来改口的 `/share` `/bug` `/changelog`、连带做掉的 `/scoped-models`；新文件 `session-tree-commands.ts`、`info-commands.ts`、`export-commands.ts`、`share-commands.ts`，对照表见 4.6 节。P2 只剩 `/settings` 未做 |
| M4 grok 界面 | 进行中。已完成：顶栏（分支、缩短的路径、上下文占用）、用户消息块、运行状态行、圆角输入框（底边是模型和思考档位）、快捷键栏（`src/tui/chrome.ts`）；工具块用 `┃` 竖条和 `◆`，去掉 Pi 的底色框（`src/tui/tools/block.ts`，内置工具和扩展工具都套用）；7 个内置工具的渲染器（agy 写，审查后合并）；4.3 节的粘贴标签和预览浮窗（`src/tui/paste-chips.ts`、`src/tui/paste-preview.ts`：Pi 的 `Editor` 把折叠/原子/展开/校验都写成私有方法，无法子类化覆盖，改成包一层，用它公开的 `getText`/`getCursor`/`insertTextAtCursor`/`setText`/`handleInput`/`handleMouse`/`render`，外加一个私有字段 `state`：`[Pasted: …]` 标签没有编号，内容表按"文档里第几个标签"对应，这张表挂在 `Editor.state` 上，Pi 的撤销（`pushUndoSnapshot` 克隆、`undo` 恢复）和历史浏览（`historyDraft`）会连同文字一起克隆、恢复它，所以撤销后每个标签的内容和当时完全一致；其他编辑按光标处的前后缀比对决定哪些标签还在，新出现的同形文字（手打、Ctrl+Y 贴回）不带内容；删掉半个标签的操作（退格、Delete、Ctrl+W、Alt+D、Ctrl+U、Ctrl+K）顺带删掉剩下的半个；展开靠合成方向键/退格键调用；图片走 `session.prompt(text, {images})`，`ImageContent` 来自 `@earendil-works/pi-ai`；双击展开一度不生效——pi-tui 的鼠标分发要么走 overlay，要么走 `dispatchMouseToLayout` 按 `currentLayout` 里登记过布局节点（Stack/ScrollView）的组件找目标，`inset()` 这种裸 `{render, invalidate}` 包装对象不登记子结构，点到 `editorSlot` 也传不进 `PromptFrame`，补了 `inset()` 自己的 `handleMouse` 转发才通；补上后连续两次点击又被屏幕级"双击选词"抢先吃掉（`Editor.handleMouse` 故意不处理 press，让拖选文本能用），改成 `ChipEditor` 自己在 press 阶段先认领，用真实 SGR 鼠标序列在 `test/tui-paste-chips-app.test.mjs` 里端到端验证过，不只是单测坐标换算。`setText()` 原样清空过 Alt+Up/Esc 的队列回填，导致回填出的文字还原样保留标签但内容已经跟丢；现在 `setText()` 也按前后缀比对，没改动部分里的标签保留内容）。已知偏差：方向键/主页键/单击可能落在标签中间，用 `snapOutOfChipSpan` 顺着移动方向纠正，未覆盖的只剩跨行移动；`[Image #N]` 删除后不重排号，会有空档；Ctrl+G 外部编辑器里展开文本会把图片标签整个丢掉。2026-09-30 完成（两个并行 subagent）：助手消息时间戳、`Worked for Ns`/`Stopped after Ns`、thinking 折叠成 `Thought for Ns`（含 `Ctrl+T` 全局折叠和单击折叠单条）、矮屏降级；连续只读工具合并（超过 10 项时只显示最近 10 项，更早的收成最前面一行 `◈ N more`，可点开）、完成闪烁。未做：`▼` 新内容提示 |

M2 验收依据（都可重跑）：
- `test/tui-services.test.mjs`：SDK 路径给模型的 system prompt 和 `piMain` 路径逐字一致；项目 `.pi/settings.json` 不生效。
- `test/tui-app.test.mjs`：用内存里的假终端跑真实的新界面：启动页、对话、Esc 中止、工具调用、扩展对话框、未实现的内置命令给出提示。
- `test/tui-theme.test.mjs`：两套配色完整；颜色一致。
- `test/tui-chrome.test.mjs`：顶栏、用户消息块、状态行、输入框、快捷键栏、工具块的内容，以及 20/40/80/120 列下不超宽（含中文）。
- 伪终端手动验证（scratchpad `phase0/pty-v2.py` + `screen.py`，后者用 pyte 还原画面）：真实终端里进入和退出全屏、grok 配色生效、扩展消息只显示一次。

实现中发现、已经处理的问题：
- 全屏模式必须用 `tui.setLayoutRoot(root)` 挂布局，用 `addChild` 时消息区只有 1 行高。
- **Pi 的竞争条件**：扩展注册"原生 provider"时，Pi 会发起一次不等待的认证刷新；如果它排在 `createAgentSessionServices` 自己那次刷新之后，初始模型会从过期的快照里选（变成 `unknown`），第一条消息报"没有 API key"。`piMain` 路径也有，是之前偶发失败的原因。MMP 的做法：建完 services 后、绑定扩展后，各再 `await` 一次刷新。测试用的 faux 模型改成带 `apiKey` 的普通 provider 注册，Pi 会同步把它标记为已认证。
- `initTheme` 从 `getAgentDir()/themes` 读主题，没设 `PI_CODING_AGENT_DIR` 时会去 `~/.pi/agent`，读不到就静默用 Pi 自己的主题。`installMmpTheme` 现在自己设置这个变量，并检查全局主题确实是 MMP 的，不是就报错。
- 工具块去掉底色框靠 Pi 的 `renderShell: "self"`：设了它，Pi 只把 `renderCall` / `renderResult` 的结果放进一个无底色的容器。MMP 给每个工具的渲染器外面包一层，画竖条和缩进；渲染器复用上一次组件时（`context.lastComponent`），包装层把里面的原组件还给它。
- 往消息区加提示时必须请求重画，否则在真实终端里要等下一次按键才显示。这个时序问题在假终端里复现不出来，只在伪终端里出现过。
- **动作表抢在对话框前面收键**：`app.ts` 的 `tui.addInputListener` 之前不管谁在聚焦都跑动作表并 `consume`，而 pi-tui 是先跑 input listener 再派给聚焦的组件；Pi 把这些动作绑在 `defaultEditor` 本身，只有输入框聚焦时才生效。结果是扩展的 `ui.select`、`/model` 等对话框打开时，Esc 会中止当前轮次而不是关对话框，Ctrl+D 会直接退出 MMP，Ctrl+C 会撞上"再按一次退出"的计数器，Ctrl+L 会在原对话框上再叠一个选择器（原来那个的 Promise 永远不 resolve）。修法：`tui.getFocusedComponent() !== editor` 时直接放行，让按键正常派给对话框。快捷键栏也要跟着焦点换：对话框占住输入框位置时显示 `↑↓:select · Enter:confirm · Esc:cancel`，而不是输入框那一套（`docs/tui-design.md` 4.1：栏跟着焦点走）。见 `test/tui-focus-gating.test.mjs`。
- **中止会丢掉排队消息**：`keys.ts` 的 `app.interrupt`（Esc）和 `app.clear`（Ctrl+C）中止分支原来只调 `session.abort()`，排队中的 steering/follow-up 消息就随 `abort()` 内部清空队列一起被丢弃，且从未回到输入框——如果后面又输入新内容触发新一轮，旧队列不会自动重发，但也不会有任何提示说它已经没了。照 Pi 的 `restoreQueuedMessagesToEditor` 做法：中止前先把排队消息合并回输入框（跟用户已输入的内容拼在一起），和 Alt+Up（`app.message.dequeue`）共用同一个 helper。见 `test/tui-abort-queue.test.mjs`。
- **`/compact` 不能被打断、运行时也没有任何提示**：手动压缩时 `session.isStreaming` 是 `false`（压缩不算一轮 agent run），而 `app.interrupt` 原来只看 `isStreaming || isBashRunning`，压缩期间按 Esc 完全没反应；状态行同理只在 `turn` 有值时画，而 `turn` 只在 `agent_start`/`agent_end` 事件里维护，从不感知压缩。修法：`app.interrupt` 改成看 `!session.isIdle || isBashRunning`（`isIdle` 本身就把压缩算进去），中止分支按 `isStreaming → abort()`、`isCompacting → abortCompaction()`、`isBashRunning → abortBash()` 的优先级处理；`app.ts` 的 `onEvent` 新增 `compaction_start`/`compaction_end`（以及 `auto_retry_start`/`auto_retry_end`）分支，复用现有的 `turn` 状态显示 `Compacting…`（或 `Retrying (n/m)…`）带计时器和 `[stop]`。见 `test/tui-compaction.test.mjs`。
- **压缩期间提交消息直接抛错**：`session.prompt()` 在 `_compactionAbortController` 存在时会抛 `Cannot submit a prompt while compaction is in progress`，而 `submit()` 原来把这当普通错误处理（提示 + 把文字放回输入框），和 `docs/tui-design.md` 里说的"本地排队"不符。照 Pi 的 `queueCompactionMessage`/`flushCompactionQueue`：`submit()` 在真正调用 `session.prompt()` 之前先查 `session.isCompacting`，是的话推进 `app.ts` 内部的 `compactionQueue`（在排队区显示为 `Follow-up: ...`，因为 MMP 的 Enter 对应 Pi 的 follow-up 语义），`compaction_end` 事件触发时统一发送。跟 Pi 不同：MMP 没有对扩展命令（`/xxx`）区分立即执行的特例，压缩期间输入的所有文本一律排队，简化实现。见 `test/tui-compaction.test.mjs`。
- **启动后立刻打字可能丢字**：`editor.onSubmit` 原来在 `tui.start()` 之前就指向完整的 `submit()` 管线，如果用户在 `bind()`（扩展绑定 + 模型刷新）跑完之前按下 Enter，就会在一个还没就绪的 session 上跑 `session.prompt()`。真实终端里两次复现分别是"文字留在框里、回车变成了换行"和"文字直接消失"，等 UI 出现后再等约 2 秒就不会发生——排查过 keybindings 加载（同步）、`onSubmit` 绑定顺序（本来就在 `tui.start()` 之前设好）、缺自动补全 provider（各处都判了 `if (!this.autocompleteProvider) return`，不影响纯文本）、首次信任提示（在 `runTuiV2` 之前就跑完，和 TUI 的 `bind()` 无关），都不是原因。真正对应的是 Pi 自己在 `interactive-mode.js` 的 `init()` 里的做法：启动完成前 `defaultEditor.onSubmit` 是 `handleStartupSubmit`（把文字放回去、提示"Startup is still in progress"），直到 `setupEditorSubmitHandler()` 换上真正的处理器才停。MMP 照此加了 `ready` 标志，首次 `bind()` 成功前 `submit()` 一律把文字放回输入框并提示，不去碰 `session.prompt()`；`ready` 只在启动时置位一次，`/new`、`/resume` 等后续 `bind()` 不受影响。用故意拖慢 `session_start`（`bindExtensions()` 会等它）的扩展做确定性复现，而不是真实终端里那种和内核 raw mode/Kitty 协议协商相关、假终端测试基础设施本来就绕不过去的时序竞争。见 `test/tui-startup-typeahead.test.mjs`。
- `createMmpRuntime`（`src/tui/services.ts`）以前只认 provider/model/thinking/session/continue，其余 Pi CLI 参数（`--tools`、`--no-tools`、`--exclude-tools`、`--no-session`、`--session-id`、`--session-dir`、`--fork`、`--name`、`--models`、`--api-key` 等）被静默丢弃——用 `--tools read` 得到的却是能改文件、跑命令的模型。现在这些参数都用 Pi 导出的 API（`SessionManager` 的静态方法、`resolveModelScopeWithDiagnostics` 等）照 `dist/main.js` 的逻辑实现；仍不支持的参数（`--verbose`、`--use-theme`、`--tui-mode`、`@file`，后者是因为 Pi 没有导出把 `@file` 转成首条消息的函数）在 TUI 启动前直接报错退出，不再假装支持。`--resume` 后来（2026-09-29，见 decisions.md M5）也接上了：启动后打开 `/resume` 用的同一个选择器。支持/不支持的清单集中写在 `services.ts` 顶部一处注释里。
- `AgentSessionRuntime.switchSession` 只按新会话的 cwd 重建 services，但 MMP 的 Manifest（Rules/Skills/`mmp:*` 扩展）是启动时装好、不能热加载的（见 8.2）：`/resume` 到另一个项目的会话后，shell 命令会在新项目里跑，模型却还在用旧项目的 Rules。修复：`src/tui/project-guard.ts` 的 `crossProjectRefusal` 在真正切换前比较目标会话 cwd 最近的 `.mmp/mmp.json` 根目录和启动时装配的那个，不同就用一条提示（附带 `cd ... && mmp --session ...`）拒绝，`/resume`（`session-commands.ts`）和扩展的 `switchSession` 动作（`app.ts`）共用同一个判断；同项目子目录的会话不受影响。
- **切换 session 后 cwd 变旧**：`app.ts` 的顶栏、`CommandHost.cwd`（`/trust` 用）、`Transcript` 的工具路径相对化、自动补全的 provider 都在启动时固定拿了一份 `cwd`，`bind()` 只重新读了 `branch`。同项目下子目录的 session 切换后，顶栏和 `/trust` 还显示旧目录，只有 `!pwd`（本来就直接读 `session.sessionManager.getCwd()`）是对的。改法：这几处都从 `session`/`this.session` 实时读，`CommandHost.cwd` 改成 getter，`Transcript` 不再存构造时的 cwd 副本。`test/tui-live-cwd.test.mjs` 用一个自建的 session 文件加 `ctx.switchSession()` 复现并验证。
- **有提示就把启动页顶掉**：`Transcript.notice()` 走的是 `add()`，会把 `messageCount` 加一，而顶栏只在 `messageCount === 0` 时画。于是"`/tree` 还没做"之类的提示一出现，启动页就没了。改法：`add()` 加一个 `counts` 参数，`notice()` 传 `false`；空隙（spacer）的判断也从 `messageCount` 换成 `messages.children.length`，这样连续几条提示之间仍有空行。
- **read 结果里路径被重复**：`read-only.ts` 的折叠结果在有 `offset`/`limit` 时显示 `path:range`，跟调用行一模一样，看起来像是把调用行重复了一遍（真实场景里模型经常带 `offset:1` 调用）。改法：折叠结果统一显示行数（grok 的规则），不再显示 range（调用行已经有了）。顺带发现 `trimTrailingEmptyLines` 只判断 `line === ""`，但 `highlightCode` 会把结尾的空行也套上颜色转义码（`"\x1B[...m\x1B[39m"`），导致文件末尾真实的换行符总被多算一行；改成按 `piTui.visibleWidth(line) === 0` 判断。`test/tui-app.test.mjs` 里那个通过 `faux-read-tool.mjs` 复现的失败其实是另一回事：假终端 cwd 和 worktree 深路径无关，是这个 worktree checkout 路径本身太长，120 列放不下调用行的完整绝对路径，跟当初怀疑的"路径重复"渲染逻辑无关；改成让 fixture 读一个在 `process.cwd()` 下的文件即可。
- **`mmp:task` 的工具输出是原始 JSON**：`task`/`task_status`/`task_wait`/`task_cancel`/`todo` 都没有 `renderResult`，走 `block.ts` 的通用兜底，直接打印结果文本（也就是 `JSON.stringify` 过的 job/todo 数据）。改法：给这 5 个工具各加一个 grok 风格的小渲染器：job 类显示 `agent 状态 id`，展开再看结果/报错；`todo` 折叠显示"N 项，M 完成"，展开每项一行，带状态符号；每行按视口宽度截断。写完第一版后发现失败态的 job 快照本身也带 `error` 字段（`task-runtime.ts` 的 `snapshot()`），如果按"有没有 `error` 键"来判断是不是 `errorResult()` 的裸错误形状，失败的 job 会被误判，把 `agent`/状态/id 都丢了；改成按 `status` 键判断（只有 job 快照有）。`todo` 的出错结果（如"unknown todo item x"）本来也会被当成空列表显示"No items."，同样加了判断。
- **测试会碰真实剪贴板**：`/copy` 直接调用 Pi 的 `copyToClipboard`，Ctrl+V 读真实剪贴板（还可能在 tmpdir 留下图片文件）。改法：加一个 `src/tui/clipboard.ts`，设了 `MMP_TEST_CLIPBOARD_FILE` 时读写这个文件而不是系统剪贴板，只有测试会设这个变量。
- **一个测不出失败的测试**：`test/tui-keys-actions.test.mjs` 里 "Ctrl+L opens the model selector" 只断言了 `EXIT=0`，选择器开没开都能过。下一条测试已经用真实内容（模型名、"Enter to select"）验证了同一个按键，删掉前一条。
- **`mutating.ts` 里的死代码**：`writeRenderers.renderResult` 判断 `details.diff` 的分支永远不会走到（Pi 的 write 工具固定返回 `details: undefined`，见 `dist/core/tools/write.js`）；`parseDiffString` 里解析"无行号"unified diff 的兜底分支也是死代码（Pi 的 edit 工具只会输出带行号的行或 `   ...`，见 `edit.js`/`edit-diff.js` 的 `generateDiffString`）。两处都删掉了。`errorText()` 在 `commands.ts`、`session-commands.ts` 里各定义一份，`app.ts`、`key-handlers.ts`、`bash-block.ts` 里内联同样的三元表达式；抽到 `src/tui/errors.ts` 一份。
- **`/tree`/`/fork` 暴露了两处宿主接口的缺口（2026-09-29）**：`CommandHost.takeEditorSlot(component)` 只有一个参数，默认把键盘焦点给 `component` 本身；但 Pi 的 `UserMessageSelectorComponent`（`/fork` 用）自己不处理按键，只有内部的 `getMessageList()` 处理，这一点在 Pi 自己的 `showSelector` 里是通过 `{component, focus}` 两个字段分开处理的。加了一个可选的第二参数 `focus`，`ext-host.ts` 的 `HostSurface.takeEditorSlot` 和 `app.ts` 的实现一起改，向后兼容（不传就是原来的行为）。另外 `session.navigateTree`（`/tree` 用）和 `session.reload()` 一样，不走 `AgentSessionRuntime` 的会话替换流程，从不触发 `setRebindSession`，所以导航后画面不会自动重放；加了 `CommandHost.resetTranscript()`，`app.ts` 里就是 `() => transcript.reset(session)`，`/tree` 命令和 `commandContextActions.navigateTree`（扩展也能调这个动作）都在导航成功后调用它。测试见 `test/tui-commands-session-tree.test.mjs`。
- **测试里证明"内容真的变了"不能只看两次 `mark` 之间的差异**：pi-tui 只重画内容变化了的屏幕行；`/tree` 导航后再发新消息，如果新旧内容在同一行位置渲染出一样的文本（比如没变化的第一轮对话），这部分不会重新写入输出流。断言"某段文字消失了"必须挑一个已经确定不会再合法出现的时间点之后的窗口（比如从上一次它还合法出现的 mark 开始切），而不是假设某次操作之后立刻会有完整重绘；`/export` 的 HTML 输出也不能直接 grep 文本——Pi 的导出模板把会话内容编码成 base64 塞进一个 `<script id="session-data">` 标签给前端 JS 解码，不是纯文本。
- **`--session` 到子目录的会话时，工具用的还是启动目录**：`services.ts` 的 `createMmpRuntime` 把 `createAgentSessionRuntime` 的 `cwd` 选项设成启动时的 `options.cwd`，而这个 `cwd` 正是 `createRuntime` 工厂建服务（工具、system prompt）时用的那个；顶栏和 `!pwd` 另外直接读 `session.sessionManager.getCwd()`，两边就对不上了。照 Pi 的 `main.js`（`cwd: sessionManager.getCwd()`）改成用会话自己的 cwd；顺带发现会话 cwd 已经不存在时的处理也跟着变了（`createAgentSessionRuntime` 内部的 `assertSessionCwdExists` 现在拿会话自己的 cwd 当 `fallbackCwd`，报错文字变得没意义），照 Pi 在这之前额外做一次检查，找不到目录就在 TUI 启动前直接报错退出（Pi 自己是弹选择器问要不要继续用当前目录，但那时 TUI 还没起来，没地方弹）。见 `test/tui-session-cwd.test.mjs`。
- **`mmp "初始消息"` 会把刚救回来的字吞掉**：`app.ts` 里处理 Pi CLI 位置参数（初始消息）的循环调用的是 `submit(message)`，跟 Enter 键走同一条管线——会无条件清空输入框和历史，还会跑 MMP 自己的内置命令（比如意外触发 `mmp /new`）。如果启动完成前用户已经打字，`submit()` 的 `!ready` 分支已经把文字放回了输入框，紧接着初始消息一发送，这段文字就被 `editor.setText("")` 冲掉了。照 Pi 的 `interactive-mode.js`（~855-864）改成直接 `session.prompt(message)`，出错就走 `transcript.notice`，不进 `submit()` 管线。见 `test/tui-pi-args.test.mjs`。
- **排队消息看不见一半，中止会丢掉扩展触发的那一半**：`keys.ts` 的 `restoreQueuedMessagesToEditor`（Alt+Up、Esc、Ctrl+C 共用）只读 `session.clearQueue()`，不知道 `app.ts` 自己维护的 `compactionQueue`（压缩期间排队的消息）——排队区已经显示了一条，Alt+Up 却说"没有排队消息"。另外 `session.bindExtensions()` 没传 `abortHandler`，扩展调用 `ctx.abort()` 时 SDK 退回到裸的 `session.abort()`，同样会把排队的消息直接冲掉。照 Pi 的 `clearAllQueues`/`restoreQueuedMessagesToEditor`（`interactive-mode.js` ~3729/~3761）：把这个合并逻辑挪到 `app.ts`（因为要看到 `compactionQueue`），通过 `CommandHost.restoreQueuedMessagesToEditor()` 暴露给 `keys.ts`；`abortHandler` 照 Pi（~1437-1439）先还原排队消息再中止，哪怕队列是空的也要中止。见 `test/tui-abort-queue.test.mjs`、`test/tui-compaction.test.mjs`。
- **压缩期间排队的消息，`/new` 之后可能悄悄发错会话**：`bind()` 从来不重置 `compactionQueue`，`/new`（或任何切换会话的动作）拆旧会话时，`session.abort()` 会顺带中止正在跑的压缩，同步触发 `compaction_end` 事件——这时 `app.ts` 的 `session` 变量还指向即将销毁的旧会话，`flushCompactionQueue()` 会把排队消息发到这个就要被 `dispose()` 的会话上。照 Pi：`bind()`（对应 Pi 的 `renderCurrentSessionState`，`interactive-mode.js` ~1615）无条件重置 `compactionQueue`；另外包一层 `sessionReplacementInFlight` 标记，`newSession`/`switchSession`/`fork` 实际重建 runtime 期间收到的 `compaction_end` 不再触发 flush（该消息就此丢弃，不会发去任何会话，跟 Pi 的效果一致）；`flushCompactionQueue` 本身也照 Pi（~3796-3866）改成第一条真正的 prompt 不等待完成、后面的消息用 `steer`/`followUp` 接到同一轮里，失败就把消息放回 `compactionQueue`（不是输入框）并提示。见 `test/tui-compaction.test.mjs`（用一个记录"收到过哪些提示"的假模型证明排队消息真的从没到过任何一个会话；同一个文件里 Esc 取消压缩的用例反过来证明这个标记不会误伤正常的 Esc 取消——排队消息该发还是照发）。
- **`--no-project` 会把启动目录自己的会话当成"别的项目"**：`project-guard.ts` 的项目识别靠 `identity.root`，而 `start.ts` 原来从 `assembly.projectManifest?.root` 取——`--no-project`、清单未加载、或未信任时这个字段是 `undefined`，哪怕启动目录本身真的有 `.mmp/mmp.json`。结果：同一个目录下之前建的会话在 `--no-project` 下会被拒绝恢复，说"属于别的项目"。改法：`identity.root` 改成直接用 `findNearestProjectManifest(launchCwd, globalManifestPath)?.root` 算，不再看清单是否真的加载/信任。见 `test/tui-project-guard.test.mjs`。
- **诊断信息在全屏界面里原样打印到 stderr**：`services.ts` 的 `createRuntime` 工厂（`/new`、`/resume` 都会重新跑一遍）把警告类诊断直接写 `process.stderr`；TUI 的全屏模式已经起来后，这样写会在界面上留下裸字符，而且 `runtime.diagnostics` 从来没被展示过。照 Pi 把启动诊断显示在对话区（`interactive-mode.js` ~817-828）：`app.ts` 的 `bind()`（每次绑定新会话，包括启动、`/new`、`/resume`）把 `runtime.diagnostics` 转成 notice；`services.ts` 不再往 stderr 写这些（真正阻止启动的错误还是照原来那样在 TUI 起来前抛出，走 stderr）。见 `test/tui-diagnostics.test.mjs`。
- **切换会话失败后，界面还留着一个已经销毁的会话**：`runtime.switchSession`/`newSession`/`fork` 在 `teardownCurrent` 之后失败（不是 `assertSessionCwdExists` 那种会话还没拆就先失败的情况），旧会话已经 `dispose()`，却只提示"Could not switch session"然后什么都不做——用户接下来的任何操作都是在跟一个死会话打交道。照 Pi 的 `bindCurrentSessionExtensions`（`interactive-mode.js` ~1442-1462）和 `handleFatalRuntimeError`（~1557）：把 `runtime.newSession/fork/switchSession` 包一层，拆会话之后才失败的一律当成致命错误——退出全屏、把原因写到 stderr、`process.exit(1)`（不走 `exit()`，因为那会再调用一次 `dispose()`）。`MissingSessionCwdError`（存的会话 cwd 已经不存在，`assertSessionCwdExists` 在拆会话之前就抛出）单独处理：不算致命，弹一个 Yes/No 提示问要不要继续用当前目录（Pi 的 `promptForMissingSessionCwd`，~4658-4691），用 MMP 自己的选择器占住输入框位置。`MissingSessionCwdError` 本身不在 SDK 导出范围内，用 `error.name === "MissingSessionCwdError"` 认。见 `test/tui-fatal-errors.test.mjs`。
- **连续只读工具合并（2026-09-30，预合并审查后改过一版）**：分组状态不额外记账，靠 `src/tui/tools/group.ts` 的 `GroupedMessages` 在渲染时对 `Transcript` 原有的 `messages` 容器做一次折叠：连续的、`groupKind` 已知（内置 read/grep/find/ls，扩展同名工具永远没有 `groupKind`）的 `ToolEntry` 是一组，渲染 0 行的子项（多数助手消息只带工具调用、没有可见文字/thinking 时就是这样）穿透不算断点，任何渲染出内容的其它子项都断开。这样 `/resume`、`/tree`、`/reload` 的重放（`Transcript.reset()`）不需要专门的重放逻辑——重建出同样的子项顺序就自动分出同样的组。全部折叠时显示一行（动词来自笔记 4.4："Read"/"Searched"/"Listed"；`find` 两个来源都没给动词，先定的"Found N files"在预合并审查中被否——它读起来像"结果数"（找到了 N 个文件），实际数的是"调用数"（find 被调用 N 次，每次可能返回 0 到多个文件），跟 grep 用"matches"而不直接报数量是同一个坑；改用 grep 的"Searched"动词、换一个名词"path(s)"，说的是"搜了什么"而不是暗示"找到了什么"）；运行中显示 `Reading… · N completed`（笔记原文如此，不按具体工具再分动词）。`ToolExecutionComponent` 的内部字段都是 TS `private`，拿不到，`ToolEntry` 靠重写 `markExecutionStarted`/`updateResult`/`setExpanded` 自己记一份 `status`/`expandedFlag`。鼠标：`GroupedMessages` 换掉 `root` 原来直接挂的 `messages`，所以要自己重实现一遍 `Container.handleMouse` 那段按子项高度分发点击的逻辑（pi-tui 没导出 `dispatchMouseEvent`，照抄了一遍）；`test/tui-tools-group.test.mjs` 有测试专门验证组下面的独立块（比如一次 bash 调用）点击仍然到得了，防止这段回归。

  **"折叠/展开"（fold）和"展开输出"（expand）是两回事**：点折叠行第一版直接对组内每个成员调用 `setExpanded(true)`——这是 Pi 原有的"展开输出"开关，不是"拆开分组"，预合并审查发现两个问题：点 `◈ Read 10 files` 会把十个文件的全部内容摊开，而不是拆成十个仍然折叠的单行块；而且这个调用完全不碰 `Transcript.toolsExpanded`，导致点开之后第一次按 `Ctrl+O` 是空操作（因为"看起来"已经是展开的），要按两次才能真正收起来；新工具在点开之后加入还会一半折叠一半散开。改法：`GroupedMessages` 自己维护一个 `unfolded`（Set，用组内第一个成员的对象引用当 key——这个引用在组的生命周期内不变，因为子项只会在尾部追加，不会重排）表示"这个组被点开看逐条了"，跟每个 `ToolEntry` 自己的 `expandedFlag`（点某一条自己的标题/结果行照旧调用 Pi 原生的展开输出）完全分开；点组行只 `unfolded.add(anchor)`，不碰任何成员的 `expandedFlag`。`Transcript.setToolsExpanded()`（`Ctrl+O`）现在总是先清空 `unfolded`（以及下面的 `revealed`）再决定要不要展开输出，所以 `Ctrl+O` 永远说了算——不管之前是靠点击拆开的、还是某个成员自己被点开过输出，只要 `Ctrl+O` 收起来，组就按"全部折叠"重新合并。拆开之后再折回去：选了最简单、grok 式的"点一下收起"链接，拆开的逐条块下面加一行 `◈ fold`（`Ctrl+O` 展开时不显示，因为那种情况下要收起靠 `Ctrl+O` 本身，不需要每组单独一个）。

  **`◈ N more`**：先前版本没有 3 列前导（跟别的行对不齐）、点不动、而且一旦超过 10 条就永久藏起第 11 条往后——这些恰恰是最新、最可能还在跑的调用。改法：`Ctrl+O` 展开时不截断，全部显示（用户主动要求"看全部"，不该藏东西）；只有靠点组行拆开（未按 `Ctrl+O`）时才截断，显示末尾（最新）10 条，`◈ N more` 放在最前面、跟其它行同样的 3 列前导，点一下（记入 `revealed`）就显示全部。

- **完成闪烁（2026-09-30，预合并审查后改过一版）**：工具（以及以后 thinking 要接的话）结束时竖条闪一次 `success`/`error` 色、400ms，做成 `src/tui/tools/flash.ts` 的几个小函数（`createFlashState`/`startFlash`/`isFlashing`/`disposeFlash`/`paintRailTone`/`paintFlashRail`），不依赖工具本身；`ToolEntry.render()` 用 `paintRailTone` 把 `super.render()` 结果里"这一行开头是纯空格"的位置（也就是竖条列，结束态本来不画东西）临时染成闪烁色，`updateResult()` 从运行态转到结束态时调用 `startFlash`，用一个 400ms 的 `setTimeout`（`.unref()` 过，见下）到时把状态清掉并请求重画。

  **分组摘要行先前版本的闪烁基本不会触发**：第一版在 `GroupedMessages` 里按"上次渲染时是不是还有成员在跑"记一份状态，靠两次渲染之间观察到"跑着→定了"的变化才触发闪烁——但 pi-tui 的渲染节流是 16ms 一帧，真实场景里一个工具调用完成的事件和下一次真正渲染之间，往往根本不会插进一次"刚好在跑着"的渲染，于是这个变化永远观察不到；`faux-read-group.mjs` 跑 12 次真实结果，闪烁一次都没出现过。改法：摘要行不再自己记一份"上次是否在跑"的状态，直接读每个成员自己已经在跑的 `ToolEntry.flash`（现在是公开字段）：全部成员都定了、且至少一个成员的 `flash` 还在闪（`isFlashing()`），就把摘要行也染成对应颜色（有成员闪红就用 error，否则 success）——不需要"观察到一次变化"，只要某一帧恰好在别的成员 400ms 窗口内被渲染，就会跟着染色，这跟单个工具本来就有的闪烁是同一份状态，不是另开一份计时器。用 `started` 标志（只有真正走过 `tool_execution_start` 才置位）把重放（`/resume` 等）挡在外面——历史消息的结果是直接贴上去的，从没经过运行态，不应该在回放时凭空闪一下。定时器在 `Transcript.reset()`（每个 `ToolEntry.dispose()`）里清掉；`GroupedMessages.dispose()` 现在只清 `unfolded`/`revealed`，因为它自己不再持有任何计时器。

  **`.unref()`**：预合并审查发现 400ms 的 `setTimeout` 会顶着进程不退出——工具刚跑完就按 `Ctrl+D`，得先等这 400ms 计时器触发一次才能真正退出。`startFlash` 里对 `setTimeout` 返回值调一次 `.unref()`，让它不算在"还有事要做"里。
- **对齐 Pi 的几处小差异**：`--session-dir` 现在照 Pi 的 `normalizePath` 展开 `~`，并且没给这个参数时依次看 `MMP_SESSION_DIR` 环境变量（MMP 自己的变量，语义同 Pi 的 `PI_CODING_AGENT_SESSION_DIR` 但从不读取后者，避免 Pi 装置的设置泄漏进 MMP）、设置里的 `sessionDir`（main.js ~536-539，`test/tui-session-dir.test.mjs`）；没给 `--models` 时用 `settingsManager.getEnabledModels()` 兜底做模型范围（main.js ~641），范围内有多个模型时优先选已保存的默认模型而不是第一个（Pi 的 `buildSessionOptions`，`test/tui-model-scope.test.mjs`）；建完会话后照 Pi（main.js ~667）对 CLI 来源的思考档位再走一遍 `setThinkingLevel`（这一步在能构造出的场景里其实是空操作，因为 `createAgentSession` 构造时已经用同一个 `clampThinkingLevel` 夹过一次，没找到能让它产生实际差异的路径，没有单独的测试）；`--fork --session-id <已存在的 id>` 照 Pi 的 `createSessionManager` 检查拒绝，不再让 fork 悄悄和已有会话同名（main.js ~289-294，`test/tui-pi-args.test.mjs`）；压缩期间按 Esc 现在照 Pi 显示"Compaction cancelled"提示，而不是无声退出（`interactive-mode.js` ~2883-2889，`test/tui-compaction.test.mjs`）；压缩期间输入的扩展命令（如 `/xxx`）现在立即执行而不是排队，跟 Pi 的 `isExtensionCommand` 特例一致（`interactive-mode.js` ~2604/~3530）。
- **助手消息时间戳（M4 项 1，2026-09-30）**：加在 `AssistantBlock.render()`（`src/tui/assistant-block.ts`，新文件）里，不是 Pi 的 `AssistantMessageComponent` 本身——时间要盖在"第一条可见内容行"上，而 Pi 的组件在有可见内容时总是先输出一个空行（`hasVisibleContent` 触发的 `Spacer(1)`），时间落在这行没意义。做法照 `chrome.ts` 的 `UserMessageBlock`：整个内容按 `width - 时间宽度 - 2` 收窄画，再用 `spread()` 把时间盖到第一条非空行上；时间来自 `message.timestamp`，构造时只取一次，不随后续 `updateContent` 变化（同一条流式消息复用同一个组件实例）。
- **`Worked for Ns` / `Stopped after Ns`（M4 项 2，2026-09-30；计时逻辑 2026-09-30 评审后重做）**：加在 `Transcript`（`src/tui/transcript.ts`）自己的事件处理里，没有另外经过 `app.ts`——`Transcript.handle()` 本来就收到这些事件。最初版本在 `agent_end` 直接打印，评审发现三个问题（`agent.continue()`——重试、排队消息、压缩恢复——都会给同一轮再发一次 `agent_start`/`agent_end`）：计时器被第二次 `agent_start` 覆盖归零；溢出压缩触发的那次内部续跑会打印两行 `Worked for`；Esc 打断重试等待时打印的是 `Worked for` 而不是 `Stopped after`。改法：`turnStartedAt` 只在第一次 `agent_start` 时写入（`??=`，不是 `=`），真正打印挪到 `agent_settled`——这个事件每次 `session.prompt()`/`steer()`/`followUp()` 调用只发一次，在所有重试、压缩续跑、排队续跑都跑完之后（`agent-session.js` 的 `_runAgentPrompt` 的 `finally` 块），是唯一"这一轮真的结束了"且"只该打一次"的时点；`agent_end` 现在只负责把 `messages`（这一轮自己的，不是整个会话）存到 `lastTurnMessages`，供 `agent_settled` 时回读最后一条 assistant 消息的 `stopReason` 判断中止（复用 Pi 自己在 `AssistantMessageComponent`/`_willRetryAfterAgentEnd` 里同一个信号）。Esc 打断重试等待（`AgentSession.abortRetry`）走的是完全不同的路径——从不触发另一次 `agent_end`，只在 `auto_retry_end` 上留下 `finalError: "Retry cancelled"`（`agent-session.js` 的 `_finishCancelledRetry`）——所以加了一个独立的 `turnAborted` 标记，专门认这个信号。`/new`、`/resume`、`/reload`（`Transcript.reset()`）清空全部三个状态字段。测试覆盖：重试不清零计时器、重试放弃、Esc 打断重试、压缩续跑只打一行（`test/tui-transcript.test.mjs`）。**合并 pi-087-upgrade 引入的回归**：两条分支各自往 `handle()` 的 `switch` 里加了一条 `case "auto_retry_end"`（这条加 `Worked for`/`Stopped after` 的计时，那条加"Retry failed"提示），文本层面合并时两条 case 都留了下来——JS 的 `switch` 只认第一条匹配的 case，第二条永远走不到，"Retry failed"提示因此再也不会显示。合并成一条 case，两件事都做，补了断言提示确实渲染的测试。
- **thinking 折叠成 `Thought for Ns`，`Ctrl+T` 全局折叠、单击折叠单条（M4 项 3，2026-09-30）**：Pi 的 `AssistantMessageComponent` 的 `hideThinkingBlock`/`hiddenThinkingLabel` 是整个组件一个开关、一个固定字符串，撑不住"每条 thinking 各自的用时、运行中显示不一样"的要求，所以 `assistant-block.ts` 整个不复用它处理 thinking：把 `message.content` 按"连续的 thinking 项"分段（和 Pi 内部那个循环分段方式一样），非 thinking 段仍然各自喂给一个真正的 `AssistantMessageComponent`（换来 markdown、扩展的 markdown transformer、`stopReason` 的错误提示继续免费复用），thinking 段自己画。每段的计时状态（第一个/最后一个 `thinking_start`/`thinking_delta`/`thinking_end` 事件的时间戳）按事件的 `contentIndex` 落在哪个段来记账，键用段起始的 `contentIndex`（在流式过程中稳定，因为内容只会往后追加）。是否处于"运行中"直接由结构判断：还在流式、且这一段是 `message.content` 里最后一段，不需要另外维护完成标记。展开状态分两层：`Transcript.setThinkingExpanded()`（`Ctrl+T`，`app.thinking.toggle`，已经是 Pi 的默认键）设全局默认并清空每条的单独覆盖（照抄 Pi 的 `setHideThinkingBlock` 清 `thinkingVisibilityOverrides` 的做法）；单击某一条的 `Thought for Ns` 行（`MouseRegion` 包住，只认 `y===0` 那一行，展开后的正文行不响应，避免点内容时意外收起）只翻转那一条的覆盖值。空闲态快捷键栏已经是 4 项上限，加 `Ctrl+t:thinking` 挤掉了 `Ctrl+d:quit`（双击 Ctrl+C 还能退出，认为是四项里最不常用的一个）；`Shift+Tab` 原来的 `thinking` 标签改叫 `effort`，避免和新的 `Ctrl+t:thinking` 撞词——这两个键其实做的是完全不同的事（切思考档位 vs. 折叠/展开 thinking 块）。副作用：`src/tui/info-commands.ts` 的 `/hotkeys` 硬编码了一份按键描述表（`APP_KEY_DESCRIPTIONS`），漏加会显示裸的 action id，已经补上；几个既有测试原来拿 "Shift+Tab:thinking"/"Ctrl+d:quit" 当"这是空闲态"的判定标记，跟着改成 `Ctrl+t:thinking`（`test/tui-compaction.test.mjs`、`test/tui-focus-gating.test.mjs`、`test/tui-paste-chips-app.test.mjs`）。**评审后发现并修的 bug**（第一轮，都是没有覆盖"replay"和"纯文本回复"这两种最常见路径导致的）：①`AssistantBlock` 的构造函数原来写死 `updateContent(message, true)`，`Transcript.assistant(message, streaming)` 又从没把 `streaming` 参数传给构造函数——`/resume`/`/tree`/`/reload` 重放一条以 thinking 结尾的历史消息时会一直显示"运行中"的 `◆ Thinking…`，永远不会折叠成 `Thought for Ns`；改成构造函数接收并透传 `streaming`。②判断"这一行是不是空行"（决定要不要去掉重复的空行、时间戳该盖在哪一行）原来用 `.trim() !== ""`，但 Pi 会把零宽的 OSC133 提示符标记直接拼在空行前面，这类行 trim 不掉、不等于空字符串——结果是纯文本、不含 thinking 的最常见回复类型会显示两行空白（外层 `AssistantBlock` 自己加一行、内层 `AssistantMessageComponent` 自带一行，drop 逻辑没生效），时间戳偶尔会盖到那行空白上而不是正文第一行；改成一律用 `piTui.visibleWidth(line) > 0` 判断可见性。两个都补了回归测试（`test/tui-transcript.test.mjs`）。

**评审后发现并修的 bug**（第二轮，pre-merge review）：③`ThinkingBlock` 原来把每条逻辑行各自 `fit()`（`truncateToWidth`）——超过终端宽度的一行直接截断丢字，不会像 Pi 自己那样换到下一屏幕行；改成先用 `piTui.wrapTextWithAnsi` 把整段文字按宽度换行，再对换行后的结果取最后 3 行（运行中）或全部（展开），一段比终端还宽的话现在能看到它的结尾。④文件顶部定义了 `applyTransformers`（照抄 Pi 的 `applyMarkdownTransformers`，`messageType: "assistant-thinking"`）但从来没被调用过——扩展注册的 markdown transformer 只对普通助手文字生效，thinking 文字完全绕过；现在运行中和展开两处渲染都会先跑一遍。⑤`AssistantBlock.render()` 把内部容器收窄到 `innerWidth`（给时钟留位置）画，但 `handleMouse()` 转发点击事件时 `event.width` 还是收窄前的原宽度——pi-tui 的 `Container.handleMouse` 只有宽度对得上时才复用上次 `render()` 缓存的每行高度，宽度不一致就会在**错误的**（未收窄的）宽度下重新算每个子组件的行数；如果前一段文字在两种宽度下换行行数不一样，点击就会落到错误的子组件上——比如消息是"会换行的长文本 + thinking + 短文本"时，点 `Thought` 行经常点空。改法：`handleMouse()` 转发前也用同一个 `innerWidth(event.width)` 收窄一遍。⑥`ThinkingBlock` 折叠态原来固定显示`"Thought for 0.0s"`（因为没有真实计时数据时 `startedAt`/`lastAt` 都是 `undefined`，硬算出来是 0）——现在没有计时数据就只显示裸的`"◆ Thought"`，不编造一个看起来精确其实恒为 0 的时长。⑦运行中最后 3 行原来用 `thinkingText` 主题色，设计稿写的是 `dim`；改成 `dim`（展开态的正文仍用 `thinkingText`，设计稿没有另外规定）。⑧`Transcript.assistant()` 原来构造完 `AssistantBlock`后紧接着调用 `setGlobalExpanded()`，等于每条消息（含每一条重放的历史消息）都多重建一次内容；改成把 `Ctrl+T` 当前状态作为构造参数传入，构造时一次到位。上面①②③④⑤⑥⑦都补了回归测试（`test/tui-transcript.test.mjs`）。
- **矮屏降级（M4 项 4，2026-09-30）**：`app.ts` 里给顶栏、顶栏上下的空行、快捷键栏包一层 `hideBelowRows(terminal, 16, component)`——只隐藏文字不够，得连它们的空行一起去掉才真的省出行数；每次 `render()` 都读一次 `terminal.rows`，所以终端 resize 后自动重新判断，不用另外接 resize 事件。≤12 行的输入框收窄靠 `PromptFrame` 新增的 `maxContentRows` 参数：pi-tui 的 `Editor` 自己有"可见行数"逻辑，但下限是 5 行（`Math.max(5, Math.floor(terminalRows * 0.3))`），到不了"最多 1 行"，所以在 `PromptFrame.render()` 里对编辑器已经算好的内容行再裁一刀，裁剪时保留光标所在的那一行（找 `Editor` 自己画的反显转义码 `\x1b[7m`）；裁剪窗口的起始偏移量提出成 `cropWindow()`，`render()`（切片）和 `handleMouse()`（把点击的 `y` 加上这个偏移量再转给编辑器）共用同一份计算——最初版本 `handleMouse()` 没做这一步，点击画面上唯一那一行会按"没裁剪时它该在第几行"去算，而不是编辑器真实内容里光标所在的那一行，导致矮屏下双击标签基本点不中；评审后补上（`test/tui-chrome.test.mjs`）。这两个降级点在真机上会跟随 pi-tui 已有的 resize 重绘一起生效——查过 `pi-tui/dist/terminal.js`（`ProcessTerminal.start` 里 `process.stdout.on("resize", this.resizeHandler)`）和 `pi-tui/dist/tui.js:540`（`TuiBase.start()` 把 `() => this.requestRender()` 当 `onResize` 传给 terminal），确认 SIGWINCH 会触发 `requestRender()`，而 `hideBelowRows`/`maxContentRows` 每次 `render()` 都重新读 `terminal.rows`，所以不用额外接线；测试用 `test/fixtures/tui-harness.mjs` 早就支持的 `rows`/`columns` 选项验证（`test/tui-thinking.test.mjs`、`test/tui-chrome.test.mjs`），没有在真实终端里实际拖动窗口验证过。

## 14. 为什么不走皮肤路线

v1 的皮肤方案（约 600 行，只用扩展接口）改不了这些：
- 消息区的样式，包括用户消息块和 thinking 折叠；
- 固定顶栏；
- 单块折叠和只读工具合并；
- 命令面板和阻塞卡片的位置。

这些都是 grok 交互的核心。自建第 4 层能拿到全部控制权，代价是第 13 节列的那些。
