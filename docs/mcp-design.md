# MMP 的 MCP 设计（Pi 0.99 原生 MCP）

状态：2026-09-30 用户确认。方向已定（决策 MCP1）；本文细化接法，和 MCP1 不同的地方见决策 MCP2。实施随 Pi 0.99 升级一起做（决策 P1）。

Pi 的引用都指 `@earendil-works/pi-coding-agent` 0.99.1 的 `dist/`，主控逐条读过源码。agy 的调研报告（scratchpad `agy/pi099-mcp/pi-0.99-native-mcp.md`）引用基本属实，但漏了 `createMcpExtension` 的 `loadConfig` 选项（它推荐走 `registerMcpServer`），本文以源码为准。

## 1. 一句话

MMP 不再自带 MCP 实现（去掉 pi-mcp-adapter），改用 Pi 0.99 内置的 MCP 扩展；MMP 只决定**读哪些配置文件、用谁的信任判断**，其余（连接、OAuth、工具注册、`/mcp` 面板）都用 Pi 的。

## 2. 接法

```
~/.mmp/mcp.json ─────────────┐
<项目>/.mmp/mcp.json ─(仅信任)┤→ MMP 的 loadConfig ─→ createMcpExtension({ loadConfig, logPath, credentials })
                             │                          │  （Pi 代码：连接、OAuth、注册 mcp__<server>__<tool>、/mcp）
Pi 自己的 ~/.mmp/pi/mcp.json ✗                          ├─ createCodemodeExtension()   （默认曝光 codemode 需要它）
项目 .pi/mcp.json            ✗                          └─ createToolSearchExtension() （deferred 曝光需要它）
```

| 部分 | 谁决定 | 说明 |
|---|---|---|
| 读哪些文件 | MMP 代码（`loadConfig`） | 只读上图两份；Pi 的默认读取（`getAgentDir()/mcp.json` 和 `<cwd>/.pi/mcp.json`，`extensions/mcp/index.js:899`）被整个替换掉 |
| 项目是否可信 | MMP 代码 | 用 MMP 自己的判断（`assembly.projectManifest?.loaded === true`，和现在 `src/extensions/index.ts` 一样）。**不用** `ctx.isProjectTrusted()`：那是 Pi 的信任，MMP 固定给 Pi 传 `--no-approve` |
| 解析和校验 | Pi 代码 | 复用 Pi 的 `loadMcpConfig`（`extensions/mcp/config.js:65`），格式和 Pi 完全一致 |
| 连接、OAuth、工具、`/mcp` 面板 | Pi 代码 | 不改 |
| 模型怎么调用 MCP 工具 | 配置里的 `exposure`，默认 Pi 的 `codemode` | 见第 5 节 |

具体做法：

- **只有一个接入点**：`src/extensions/index.ts` 的 `case "mmp:mcp"`，改成返回三个 inline 扩展：`mmp:mcp`（`createMcpExtension(...)`）、codemode、tool-search。`piMain`（`-p` 等）和 MMP 界面（`src/tui/services.ts`）两条路径都经过 `buildInlineExtensions`，一处改动覆盖两边。**子任务 worker 是第三条路径，但不经过 `buildInlineExtensions`**（Fable milestone review 核实，2026-09-30 修正）：`src/worker.ts` 直接用 `DefaultResourceLoader`（`noExtensions: true`）+ `createAgentSession`，不传 `extensions`，不构建任何 inline 工厂——所以子任务 worker 今天没有任何 MCP 工具（也没有 mmp:hooks、mmp:task 等其他 inline 扩展），不是本节原来以为的"一处改动全覆盖"。
- **Pi 的内置 MCP 不会自己加载**：0.99 起 `--no-extensions` / `noExtensions: true` 连内置扩展一起关掉（CHANGELOG 0.99.0；`core/resource-loader.js:403`），MMP 两条路径都已经这样传。inline 工厂不受 `noExtensions` 影响（`resource-loader.js:245`）。
- **日志路径显式传，凭据路径不传（2026-09-30 实施时核实并调整）**：`logPath: ~/.mmp/pi/mcp.log` 按计划显式传。`credentials` 本以为能直接传路径，实测 `createMcpExtension` 的 `credentials` 选项类型是 `McpOAuthCredentialStore` 实例（`extensions/mcp/oauth.d.ts`），不是路径字符串——要传显式路径得自己拼一个 `AuthStorageBackend` 再 `new McpOAuthCredentialStore(backend)`，代价是引入 `oauth.js`（它依赖 `@earendil-works/pi-mcp`），而结果和不传完全一样：Pi 的默认凭据存储走 `getAgentDir()`，MMP 早在 `src/host.ts` 就把 `PI_CODING_AGENT_DIR` 指到了 `<mmpHome>/pi`，所以默认值本来就落在 `~/.mmp/pi/mcp-auth.json`。改为不传 `credentials`，用一个测试（`test/mcp.test.mjs`）断言 `getAgentDir()` 在这个重定向下确实解析到 `<mmpHome>/pi`，隔离结论不变，只是不必要地导入 `oauth.js` 的代价省掉了。凭据和 Pi 一样是明文 JSON，不另做钥匙串。
- **`loadConfig` 怎么复用 Pi 的解析**：`loadMcpConfig` 的项目那一半写死了 `.pi/`（`CONFIG_DIR_NAME`），所以 MMP 调两次、都传 `projectTrusted: false`：一次 `agentDir = ~/.mmp`，读到 `~/.mmp/mcp.json`；项目可信时再调一次 `agentDir = <项目>/.mmp`，读到 `.mmp/mcp.json`，把结果的 `scope` 改成 `"project"`。同名服务项目覆盖全局（和 Pi 一致）。
  - `config.js` 不在包的 `exports` 里，只能按文件路径引用，所以要登记进 `docs/pi-internals.md` 并加测试（AGENTS.md 硬规则 5）。选它而不是自己重写校验，是为了让格式随 Pi 升级自动跟上；它一旦改名或改签名，升级门禁会报出来。
  - **错误的可见性比设计稿原定的更严格（2026-09-30 实施时调整）**：本以为"错误原样合并进 `errors`，由 Pi 在启动时报出来"就够了，实测 Pi 自己只把 `LoadedMcpConfig.errors` 当软提示——`extensions/mcp/index.js` 的 `reportProblems` 只调 `ctx.ui.notify(..., "warning")`，而且这个 `ui.notify` 在 `-p`/print 模式下是纯空操作（`modes/print-mode.js` 的 `bindExtensions` 调用根本没传 `uiContext`），也就是说错误的 mcp.json 在 `-p` 下会被完全吞掉，违反 AGENTS.md 硬规则 3。改法：`src/extensions/index.ts` 的 `case "mmp:mcp"` 在 `buildInlineExtensions` 时就同步跑一次 `loadNativeMcpConfig`，`errors.length > 0` 直接抛 `MmpConfigError`（和 `mmp:hooks` 现有的模式一致），`--dry-run` 和正常启动都在 Pi 真正跑起来之前就可见地失败。运行期（`session_start` 时）`loadConfig` 仍然照常把 `errors` 交给 Pi，只是不再是唯一的可见渠道。

## 3. 配置格式

改用 Pi 的格式，逐字一致（Pi 文档 `docs/mcp.md`；校验在 `core/mcp-servers.js` `validateMcpServerConfig`）：

```json
{
  "mcpServers": {
    "github": { "url": "https://api.githubcopilot.com/mcp/", "exposure": "direct" },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "enabled": true }
  },
  "autoEnableCodemode": true
}
```

- 传输只有 stdio 和 streamable HTTP。**不再支持**：SSE（Pi 明确拒绝）、unix socket、pi-mcp-adapter 独有的字段（`lifecycle`、`directTools`、`toolPrefix`、`includeTools`/`excludeTools`、`disabled` 等）。对应 Pi 的写法：`disabled` → `enabled: false`；`directTools`/`includeTools` → `exposure` / `toolExposure`。
- 迁移：用户机器上现在没有 `~/.mmp/mcp.json`（主控核实），不做迁移代码。旧字段出现时，Pi 的校验会报错（失败可见）。
- `src/mcp-config.ts` 里 pi-mcp-adapter 的类型定义和合并逻辑删掉。

## 4. 开关：仍由 Manifest 声明

Pi 的内置 MCP 默认总是开着；MMP 保持现状：Manifest 里声明 `"mmp:mcp"` 才启用（`src/manifest.ts`）。理由是 MMP 的核心约定"资源只由 Manifest 声明"（`cli-design.md` §0 第 2 条），这一条写进 `cli-design.md`。

Manifest 同时声明第三方 MCP 扩展（例如 pi-mcp-adapter）和 `mmp:mcp` 时，两边都会注册 `/mcp`。Pi 的"可替换"机制只对内置扩展生效，对 MMP 的 inline 工厂不生效，所以这种情况要**启动时报错**，说清楚两者只能选一个，不静默丢掉其中一个。

- **怎么发现冲突**：Pi 对两个扩展注册同名命令的处理不是报错，是**都改名**（`core/extensions/runner.js` 的 `resolveRegisteredCommands`：某个命令名被注册超过一次时，两边都变成 `mcp:1`/`mcp:2`，不会有一份还叫 `mcp`）。`mmp:mcp` 自己的 `session_start` 里查 `pi.getCommands()`，看有没有 `/^mcp:\d+$/` 的名字，有就是冲突。命令注册全部发生在扩展加载阶段（同步，早于任何事件），所以不管冲突的扩展在 Manifest 里排第几，到 `session_start` 时都已经能看到。
- **能见到多硬（2026-09-30 实测，不只是看源码；2026-09-30 补一次修正）**：这一步检测出来后能做的补救很有限——`ctx.ui.notify` 和 `ctx.shutdown()` 在 `-p`/print 模式下都是空操作（`modes/print-mode.js` 的 `bindExtensions` 既不传 `uiContext` 也不传 `shutdownHandler`）；扩展加载阶段的抛错（stage 1 `mmp:mcp` 那种）确实会让 Pi 直接 `process.exit(1)`，但那是在**所有**扩展加载完之前的检查点，等不到后面才声明冲突命令的扩展。所以现在的做法是在 `session_start` 里只 `throw`（不再额外调 `ctx.ui.notify`——最初两个都调，结果 MMP 的 TUI 里同一条消息出现两次：`ctx.ui.notify` 和 `onError` 在 `src/tui/app.ts` 里落的是同一个 `transcript.notice` 宿，`throw` 单独一个就够了）：不会改变退出码，但 Pi 自己的 `runner.emit()` 会把它交给每个模式都接了的 `onError`（print 模式打到 `console.error`；MMP 的 TUI 里是 `src/tui/app.ts` 的 `onError: (error) => transcript.notice(...)`，一条常驻提示；RPC/json 模式进事件流），可见，但不保证非零退出码——这是 Pi 架构的限制，测试（`test/mcp.test.mjs`）断言的是 stderr 上出现这条消息、TUI 里恰好出现一次，不是退出码。

## 5. 模型看到什么（曝光方式）

沿用 Pi 的默认值 `exposure: "codemode"`：MCP 工具不直接出现在模型的工具列表里，模型通过 `codemode` 工具写脚本调用它们。有 MCP 服务时，Pi 自动启用 `codemode` 工具（`autoEnableCodemode`）。服务多、工具多时这样最省 token。想让模型直接看到某个服务的工具，就在那个服务上写 `"exposure": "direct"`（也可以用 `toolExposure` 逐个工具设置）。

对模型可见内容的影响：`test/snapshots/model-visible.json` 里 pi-mcp-adapter 的 `mcp` 代理工具消失；配了测试服务时出现 `codemode`。用 `scripts/model-snapshot.mjs --diff` 重新生成并逐条审查。

## 6. `mmp mcp` 子命令

用法对齐 Pi 的 `pi mcp`（`extensions/mcp/cli.js`）：

```
mmp mcp add <server> [-l] [--exposure …] [--env K=V]… [--header K:V]… (--url <url> | -- <command> [args…])
mmp mcp remove <server> [-l]
mmp mcp list [--json] [--approve|--no-approve]
mmp mcp login <server> [--timeout <seconds>] [--approve|--no-approve]
mmp mcp logout <server> [--approve|--no-approve]
```

- Pi 的 `runMcpCommand` 不能直接用：它写死了 `.pi/mcp.json`（`cli.js:127`）和 Pi 的信任存储（`cli.js:133`）。MMP 自己解析参数；读写配置复用 `config.js` 的 `addMcpServerConfig` / `removeMcpServerConfig` / `loadMcpConfig`；`list`、`login`、`logout` 复用 `runtime.js` 的 `McpServerConnection`、`signInMcpServer`、`McpOAuthCredentialStore`（都登记进 `pi-internals.md`）。
- 写的是 `~/.mmp/mcp.json`，加 `-l` 写项目的 `.mmp/mcp.json`。`-l` 的信任规则和 `mmp install -l` 一样：项目不可信就拒绝，除非带 `--approve`（只对这一次有效）。
- `list` 和 Pi 一样会真的连接每个服务，报告状态、工具数和错误；有配置错误或连接失败时退出码为 1。项目不可信时不读项目配置，并提示"not trusted"和 `--approve`。
- `list`、`login`、`logout` 也读项目的 `.mmp/mcp.json`，所以同样接受 `-a`/`--approve`（这一次当作信任，读项目配置）和 `-na`/`--no-approve`（这一次当作不信任），都不写信任记录（决策 U4；dogfood D4）。
- `mcp` 要加进 `src/host.ts` 的子命令表，**不能落到 `piMain`**：`piMain` 看到 `mcp` 会跑 Pi 自己的命令，读写 Pi 的路径（`main.js:478`）。
- `cli-design.md` §3 加一行。

## 7. `/mcp` 面板

直接用 Pi 的：Pi 的 MCP 扩展注册了 `/mcp`（`index.js:820`），面板通过 `ctx.ui.custom` 渲染，MMP 的扩展界面已经支持（`src/tui/ext-host.ts`）。登录、重连、启用/停用、改曝光方式都来自 Pi；启用/停用和曝光方式会写回定义这个服务的那份 `mcp.json`，也就是 MMP 自己的文件。

一处要改：没有配置任何服务时，Pi 的提示是 `Add them to ~/.mmp/pi/mcp.json or .pi/mcp.json`（`index.js:470,633`），这两个路径 MMP 都不读，违反"对外只有 mmp"。做法：一个服务都没加载时，MMP 拦下不带参数的 `/mcp`，自己提示 `~/.mmp/mcp.json` / `.mmp/mcp.json` 和 `mmp mcp add`（一句话说清怎么加：`No MCP servers configured -- add one to <mmpHome>/mcp.json with \`mmp mcp add …\`, or with -l to this project's .mmp/mcp.json.`，`mmp mcp list` 用同一句，D4）；有服务时交给 Pi。

- **"一个服务都没加载"最初算窄了（Fable milestone review F1/F2/F3，2026-09-30 修正）**：最初只数*启用*的服务，停用唯一一个服务、或服务只来自另一个扩展的 `pi.registerMcpServer()` 时，也会被当成"零服务"，挡住 Pi 真正的 `/mcp` 面板——而那正是用户想去重新启用它的地方。改法：数配置里的服务（不管 `enabled`）加上 `pi.getMcpServers()` 的数量，两者都是零才拦截（`src/extensions/mcp.ts`）。
- **codemode 里嵌套的 MCP 调用被渲染成重复的顶层工具块（同一次 review，F1 修正）**：`src/tui/transcript.ts` 的 `tool_execution_start`/`update`/`end` 之前没检查 `event.parentToolCallId`，嵌套调用（codemode 脚本内部调 MCP 工具）除了 Pi 自己内联渲染的那份，还会被 MMP 的 `transcript.ts` 再画一份顶层块。Pi 自己的 `interactive-mode.js` 只在 `start` 里跳过（它的 `pendingTools.get()` 对没见过的 id 天然返回 `undefined`，`update`/`end` 不用另外判断）；MMP 的 `tool()` helper 不一样，见到没见过的 `toolCallId` 会直接创建一个新条目，所以三个事件都要显式跳过。
- **`-p`/`--mode json` 下连接失败完全静默，违反硬规则 3（同一次 review，F3 修正）**：本节第 2 段已经记过"错误的可见性"，但那次只堵了配置校验错误（`buildInlineExtensions` 时同步抛 `MmpConfigError`）；服务器*配置合法但连接失败*（进程起不来、需要登录）走的是 Pi 自己异步的 `reportProblems()` -> `ctx.ui.notify`，在 `-p`/`--mode json` 下这条路径仍然是纯空操作，之前完全没堵。做法（第一版在 `session_start` 里调用 Pi 的 `/mcp` 处理函数，它会无上限地 `await pending`，让 `-p` 的第一个 prompt 最长等到每个服务 60 s 的请求超时，而 Pi 自己只等 10 s；已修正）：`src/extensions/mcp.ts` 在每个会话的第一个 `before_agent_start` 里（非 tui 模式）读每个服务的状态。Pi 自己的 `before_agent_start` 处理函数先运行（同一个扩展里先注册，运行器按注册顺序逐个 await），它等启动连接，最多 `startupWaitMs`（Pi 默认 10 s，MMP 不传）；MMP 之后读状态不再等待，所以第一个 prompt 的延迟就是 Pi 自己的上限。状态来自 `/mcp` 命令对 `reconnect ` 的补全（名字 + Pi 的 `describeState()` 文本）。每个失败或需要登录的服务在 stderr 写一行（`broken: failed: spawn /nonexistent/x ENOENT`），到时还在连接的服务写一行 `mcp: <名字> is still connecting; its tools become available once connected`，然后 prompt 照常运行；健康的服务和零服务都不输出。stdout 完全不碰（benchmark 和 json 消费者读 stdout）；退出码不变（和"错误的可见性"那次一样，是已认可的偏差）。已知限制（Pi 本身的行为，不是这次引入的）：Pi 的 `McpServerConnection.close()` 不会中止还在进行的连接，一个永远不回 `initialize` 的服务会让进程在输出完之后继续挂着，直到这个服务的请求超时（默认 60 s）才退出。依赖 Pi 的补全文本和 `before_agent_start` 顺序，登记进 `docs/pi-internals.md`（`mcp-reconnect-completion-states`、`mcp-startup-wait-before-agent-start`）。
- **Pi 的 MCP 启动链本身出错时被报成"still connecting"（dogfood D6）**：加载 `runtime.js` 之后、连接之前（比如构造 `McpServerConnection`）抛出的错误，Pi 只用 `ctx.ui.notify("MCP failed to load: …", "error")` 报告，`-p`/json 下是空操作；而且没有一个服务拿到连接，上面的检查就把每个服务都报成"still connecting"。做法：Pi 的 MCP 扩展通过 `pi.on` 注册的处理函数拿到的 ctx 里，`ui.notify` 在非 tui 模式下把 error 级消息原样写到 stderr（同一会话同一条只写一次），这时不再逐个报服务。`runtime.js` 整个加载不了的情况走不到这里：`mmp:mcp` 自己先加载它，失败就是 `Failed to load extension "<inline:mmp:mcp>": …`，退出码 1（实测）。登记进 `docs/pi-internals.md`（`mcp-load-failure-notify`）。
- **rpc 下同一个问题报两次（dogfood D47、D52）**：rpc 有 UI（`hasUI` 为真），Pi 自己的 `ctx.ui.notify` 会作为 `extension_ui_request` 发给客户端，所以 rpc 下 MMP 不往 stderr 写，每个问题只经客户端报一次："MCP failed to load" 只靠 Pi 的 notify（D47）；失败 / 需要登录的服务靠 Pi 的 `reportProblems()`；启动等待超时时 Pi 的 `before_agent_start` 自己会发 "MCP servers are still connecting"（info），MMP 这时不再逐个报。只有 Pi 不提的——启动等待已结束、后来通过 `mcp_servers_change` 注册的服务还在连接——由 MMP 用 `ctx.ui.notify(…, "info")` 发给客户端。选客户端渠道而不是 stderr，是和 D47 的 `hasUI` 规则一致：有 UI 就走 UI，只有没 UI（`-p`/json）才写 stderr。代价：rpc 下启动等待超时时，同一批里已经失败的服务要等整批结束后 Pi 的 `reportProblems()` 才报，和 Pi 自己、MMP 的 TUI 一样。登记进 `docs/pi-internals.md`（`mcp-own-reports-in-rpc`）。

## 8. 测试和升级门禁

| 测试 | 要证明什么 |
|---|---|
| 隔离（新增到 `test/fixtures/pi-ambient-sources.mjs`） | 在 `~/.mmp/pi/mcp.json` 和 `<cwd>/.pi/mcp.json` 里放一个测试服务：不可信、`--approve`、SDK 三种情况下都不出现 `mcp__*` 工具，也不启用 `codemode`。0.99 试升级时失败的 3 个 ambient 测试在这里一起修 |
| 信任 | 不可信项目里放 `.mmp/mcp.json`：服务不加载；`/trust` 之后加载 |
| 端到端（重写 `test/mcp.test.mjs`） | faux provider 按剧本驱动真实 stdio 测试服务：`codemode` 调用一次、`direct` 调用一次；环境变量展开；会话退出时回收子进程 |
| `mmp mcp` | add/remove 写对文件、`-l` 的信任规则、`list` 的退出码；全部在临时 `HOME`/`MMP_HOME` 里跑，不联网 |
| `/mcp` | 没有服务时显示 MMP 的提示；有服务时打开 Pi 的面板 |
| Pi 内部接口 | `config.js`、`runtime.js` 的导出名还在（`test/pi-internals.test.mjs`） |

试升级时另外两处失败（工具结果形态变化导致的 mutating renderers 测试，见 agy 报告 §6.2）不属于 MCP，在升级任务里一起修。

## 9. 不做 / 以后再说

- 不读项目根目录的 `.mcp.json`（Claude Code / Cursor 的格式）。Pi 也不读。
- 不做 SSE、unix socket。以后真的需要时再评估。
- OAuth 凭据不进系统钥匙串，和 Pi 一样。
