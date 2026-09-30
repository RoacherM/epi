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

- **只有一个接入点**：`src/extensions/index.ts` 的 `case "mmp:mcp"`，改成返回三个 inline 扩展：`mmp:mcp`（`createMcpExtension(...)`）、codemode、tool-search。`piMain`（`-p` 等）、MMP 界面（`src/tui/services.ts`）、子任务 worker 三条路径都经过 `buildInlineExtensions`，一处改动全覆盖。
- **Pi 的内置 MCP 不会自己加载**：0.99 起 `--no-extensions` / `noExtensions: true` 连内置扩展一起关掉（CHANGELOG 0.99.0；`core/resource-loader.js:403`），MMP 两条路径都已经这样传。inline 工厂不受 `noExtensions` 影响（`resource-loader.js:245`）。
- **日志和 OAuth 凭据路径显式传**：`logPath: ~/.mmp/pi/mcp.log`，`credentials` 指向 `~/.mmp/pi/mcp-auth.json`。结果和 Pi 默认值一样（MMP 下 `getAgentDir()` 就是 `~/.mmp/pi`），显式写出来是为了隔离可以直接审查。凭据和 Pi 一样是明文 JSON（`oauth.js`），不另做钥匙串。
- **`loadConfig` 怎么复用 Pi 的解析**：`loadMcpConfig` 的项目那一半写死了 `.pi/`（`CONFIG_DIR_NAME`），所以 MMP 调两次、都传 `projectTrusted: false`：一次 `agentDir = ~/.mmp`，读到 `~/.mmp/mcp.json`；项目可信时再调一次 `agentDir = <项目>/.mmp`，读到 `.mmp/mcp.json`，把结果的 `scope` 改成 `"project"`。同名服务项目覆盖全局（和 Pi 一致）。错误原样合并进 `errors`，由 Pi 在启动时报出来。
  - `config.js` 不在包的 `exports` 里，只能按文件路径引用，所以要登记进 `docs/pi-internals.md` 并加测试（AGENTS.md 硬规则 5）。选它而不是自己重写校验，是为了让格式随 Pi 升级自动跟上；它一旦改名或改签名，升级门禁会报出来。

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

## 5. 模型看到什么（曝光方式）

沿用 Pi 的默认值 `exposure: "codemode"`：MCP 工具不直接出现在模型的工具列表里，模型通过 `codemode` 工具写脚本调用它们。有 MCP 服务时，Pi 自动启用 `codemode` 工具（`autoEnableCodemode`）。服务多、工具多时这样最省 token。想让模型直接看到某个服务的工具，就在那个服务上写 `"exposure": "direct"`（也可以用 `toolExposure` 逐个工具设置）。

对模型可见内容的影响：`test/snapshots/model-visible.json` 里 pi-mcp-adapter 的 `mcp` 代理工具消失；配了测试服务时出现 `codemode`。用 `scripts/model-snapshot.mjs --diff` 重新生成并逐条审查。

## 6. `mmp mcp` 子命令

用法对齐 Pi 的 `pi mcp`（`extensions/mcp/cli.js`）：

```
mmp mcp add <server> [-l] [--exposure …] [--env K=V]… [--header K:V]… (--url <url> | -- <command> [args…])
mmp mcp remove <server> [-l]
mmp mcp list [--json]
mmp mcp login <server> [--timeout <seconds>]
mmp mcp logout <server>
```

- Pi 的 `runMcpCommand` 不能直接用：它写死了 `.pi/mcp.json`（`cli.js:127`）和 Pi 的信任存储（`cli.js:133`）。MMP 自己解析参数；读写配置复用 `config.js` 的 `addMcpServerConfig` / `removeMcpServerConfig` / `loadMcpConfig`；`list`、`login`、`logout` 复用 `runtime.js` 的 `McpServerConnection`、`signInMcpServer`、`McpOAuthCredentialStore`（都登记进 `pi-internals.md`）。
- 写的是 `~/.mmp/mcp.json`，加 `-l` 写项目的 `.mmp/mcp.json`。`-l` 的信任规则和 `mmp install -l` 一样：项目不可信就拒绝，除非带 `--approve`（只对这一次有效）。
- `list` 和 Pi 一样会真的连接每个服务，报告状态、工具数和错误；有配置错误或连接失败时退出码为 1。项目不可信时不读项目配置，并提示"not trusted"。
- `mcp` 要加进 `src/host.ts` 的子命令表，**不能落到 `piMain`**：`piMain` 看到 `mcp` 会跑 Pi 自己的命令，读写 Pi 的路径（`main.js:478`）。
- `cli-design.md` §3 加一行。

## 7. `/mcp` 面板

直接用 Pi 的：Pi 的 MCP 扩展注册了 `/mcp`（`index.js:820`），面板通过 `ctx.ui.custom` 渲染，MMP 的扩展界面已经支持（`src/tui/ext-host.ts`）。登录、重连、启用/停用、改曝光方式都来自 Pi；启用/停用和曝光方式会写回定义这个服务的那份 `mcp.json`，也就是 MMP 自己的文件。

一处要改：没有配置任何服务时，Pi 的提示是 `Add them to ~/.mmp/pi/mcp.json or .pi/mcp.json`（`index.js:470,633`），这两个路径 MMP 都不读，违反"对外只有 mmp"。做法：一个服务都没加载时，MMP 拦下不带参数的 `/mcp`，自己提示 `~/.mmp/mcp.json` / `.mmp/mcp.json` 和 `mmp mcp add`；有服务时交给 Pi。

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
