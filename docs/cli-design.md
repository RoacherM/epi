# MMP 命令行接口设计

状态：2026-09-29 与用户确认（决策 M5、M6，见 [decisions.md](decisions.md)）。

## 0. 定位

MMP 是**改名叫 mmp 的定制版 Pi**：

- 功能优先对齐官方 Pi（锁定版本见 `package.json`）。Pi 有的命令行参数、子命令、斜杠命令，MMP 原则上都提供。
- 交互界面换成 grok-build 风格（[tui-design.md](tui-design.md)）。
- 对外只有 mmp：帮助、报错、文档里只出现 mmp 的名字和参数，不出现 `pi` 命令，也不说"透传给 Pi"。底层可以继续调用 Pi 的实现。
- 只在两种情况下和 Pi 不同，并在本文写明理由：
  1. 和 grok 界面冲突；
  2. 和 MMP 的核心约定冲突：Rules/Extensions 由 Manifest 声明（内置的 `mmp:task`/`mmp:mcp`/`mmp:hooks` 默认开启、由 Manifest 的 `disable` 关闭，决策 H3/K4），Skills 另有决策 S1 的三个固定根；配置不和 Pi 共享（`~/.mmp/pi`，不读 `~/.pi/agent` 和项目 `.pi/`）。

## 1. 入口

只有一个入口：`mmp`。

| 运行方式 | 走哪条路 |
|---|---|
| 交互（stdin、stdout 都是终端，且没有 `-p`、`--mode json/rpc`、`--help`、`--list-models`、`--export`；`--mode text` 也算交互，和 Pi 的 `resolveAppMode` 一致，dogfood D53） | MMP 自己的界面（`src/tui/`）；Pi 自己的交互界面永远不会启动 |
| 非交互：`-p`、`--mode json`、`--mode rpc`、`--export`、非终端 | 会话由 MMP 用 SDK 搭（和交互模式同一个 `createMmpRuntime`），输入输出用 Pi 导出的 `runPrintMode` / `runRpcMode`（`src/noninteractive.ts`，决策 N1）；只有 `--export` 还交给 Pi 的 `main()`。对外参数和帮助是 MMP 的。`--resume` 要打开会话选择器，只有交互模式有，非交互模式下报错。读 stdout 的一方提前关掉管道（`\| head -c1`、`\| true`）算正常结束：不再写 stdout，停掉这次运行、跳过剩下的 `-p` 消息，照常关闭会话（`session_shutdown` 跑完），按这次运行本来的退出码安静退出（dogfood D54，`src/closed-stdout.ts`） |
| `--list-models [search]` | MMP 自己实现（`src/list-models.ts`，dogfood D48）：Pi 的这条路不报扩展诊断、空列表时打印 Pi 的 `/login` 文案和文档链接 |
| 子命令：`mmp update / install / remove / uninstall / list / config / auth / mcp` | MMP 自己的子命令（第 3 节） |

## 2. 参数清单

MMP 自己维护这份清单。清单外的短参数（`-x`）一律报错退出。清单外的长参数（`--foo`）不会立刻报错：和 Pi 自己的 `parseArgs`（`unknownFlags`）一样先原样保留，交给运行时（所有模式都走 `src/tui/services.ts`）在扩展加载完之后核对——某个已加载的扩展用 `pi.registerFlag` 声明过这个参数就接受，否则在启动界面前按参数名报错退出（Pi 的 `agent-session-services.js` `applyExtensionFlagValues`）。`mmp --help` 打印 MMP 自己的帮助文本，覆盖下表所有参数，不附上 Pi 的帮助；如果 Manifest 里的扩展注册了参数，额外打印一段"Extension options"（和 Pi 自己的 `--help` 一样，为此会先加载一遍扩展——只加载扩展，不建会话/连模型；加载失败就跳过这一段，`--help` 本身始终成功）。

Manifest 里的扩展启动时加载失败，两条路径都和 Pi 一样报错退出（退出码 1）：显示 Pi 的原始错误 `Failed to load extension "<path>": ...`，后面跟 MMP 自己的提示 `Hint: Fix the extension, or remove it from the Manifest that declares it ("mmp list" shows which).`。失败的是内置能力（`<inline:mmp:task>` 等；`<inline:codemode>`、`<inline:tool-search>` 随 `mmp:mcp` 加载，按 `mmp:mcp` 算，提示写 "loaded with mmp:mcp"。常见原因是第三方扩展注册了同名工具，例如 `todo`、`codemode`、`tool_search`）时，提示换成怎么关掉它：`"disable": ["mmp:task"]` 加到哪个文件（它写在某个文件的 `extensions` 里时，先从那里删掉），或者删掉冲突的那个扩展（K4）。Pi 原来的提示 `Start without extensions using "pi -ne"` 不会出现（MMP 没有 `-ne`）：`piMain` 路径在 stderr 上把这一行换掉（`src/pi-output.ts`，登记在 docs/pi-internals.md `pi-extension-load-hint`），MMP 自己的界面在 `src/tui/services.ts` 里把加载错误当作启动错误（D45；之前界面会跳过失败的扩展直接启动，什么都不显示）。只有启动时的第一个运行时会因此退出；`/new`、`/resume`、`/fork`、`/import` 会重新加载扩展，这时的加载错误和 Pi 一样作为提示显示在对话里，界面继续运行。

| 参数 | 和 Pi 对齐 | 说明 |
|---|---|---|
| `--provider`、`--model`、`--thinking`、`--api-key`、`--models` | 是 | |
| `-c/--continue`、`-r/--resume`、`--session`、`--session-id`、`--fork`、`--session-dir`、`--no-session`、`-n/--name` | 是 | `--session-dir` 和 Pi 一样展开 `~`；没给时依次看 `MMP_SESSION_DIR`（MMP 自己的变量，语义和 Pi 的 `PI_CODING_AGENT_SESSION_DIR` 一样，但从不读取后者——Pi 装置设置的这个变量不会泄漏进 MMP）、设置里的 `sessionDir`。所有模式都由 `src/tui/services.ts` 解析，读的是 `MMP_SESSION_DIR` |
| `-t/--tools`、`-xt/--exclude-tools`、`-nt/--no-tools`、`-nbt/--no-builtin-tools` | 是 | |
| `-p/--print`、`--mode text/json/rpc` | 是 | benchmark 的标准入口 `mmp --mode json --no-session --no-approve -p "…"`（docs/development.md 第 20 节）保持不变。print/json 跑完后 MMP 等 stdout、stderr 写完就 `process.exit`（退出码不变）：Pi 这里只设 `process.exitCode` 再返回，扩展占着定时器/句柄时进程不退出（dogfood D50，和 Pi 不同）；rpc 和其他已经自己退出的路径不受影响 |
| `--list-models [search]` | 是 | 输出表格和 Pi 一样。扩展诊断（注册 provider 失败、扩展加载失败）和 `-p` 一样打到 stderr，有错误就退出 1；没有模型时打印 MMP 自己的提示（`/login` 或在 Manifest 里声明 provider 扩展）。不加载 Pi 内置的 llama.cpp 扩展（和交互界面一样）。表格总是写到 stdout，和 `-p`/`--mode` 同用时也是（Pi 那时写到 stderr）；多余或缺值的扩展参数现在和 `-p` 一样报错退出 1 |
| `--export <file>` | 是 | |
| `--offline`、`--verbose` | 是 | `--verbose` 让启动信息显示在消息区 |
| 初始消息、`@文件` | 是 | |
| `--approve/-a`、`--no-approve/-na` | 名字对齐，作用不同 | 只作用于项目的 `.mmp/mmp.json`，从不交给 Pi（docs/development.md 8.2） |
| `--no-project`、`--dry-run` | MMP 独有 | |
| `-h/--help`、`-v/--version` | 是 | `--version` 打印 MMP 版本和锁定的内核版本 |
| `--use-theme`、`--tui-mode` | **不提供** | 界面已换成 grok 风格：只有全屏，主题由 MMP 管 |
| `-e/--extension`、`--skill`、`--prompt-template`、`--theme`、`--system-prompt`、`--append-system-prompt`、`--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-themes`、`--no-context-files` | **不提供** | 资源不能通过这些 flag 传入；传入时报错并提示改 Manifest。Skills 除 Manifest 声明外还会从三个固定目录自动发现（docs/decisions.md S1，[docs/guide/configuration.md](guide/configuration.md) "Manifest"），同样不经过这些 flag |

### 2.1 环境变量：Pi 的 `PI_*` 不进 MMP（dogfood D63）

用户给自己的 Pi 设的 `PI_*` 变量（例如 `PI_OFFLINE=1`）不能改变 mmp 的行为（配置不和 Pi 共享）。`mmp` 启动时、在加载任何 Pi 模块之前（`src/cli.ts` 的第一个 import `src/isolate-pi-env.ts`；Pi 有几个变量在模块加载时就读），清掉 Pi 读的全部 `PI_*` 变量；面向用户的那几个改用 MMP 自己的名字 `MMP_<NAME>`，有设置就原样赋给 Pi 的 `PI_<NAME>`（包括空值，语义由 Pi 决定）。MMP 启动的子进程（task worker、hooks、工具命令）继承清理后的环境。清单在 `src/pi-env.ts`，`test/pi-internals.test.mjs` 的 `pi-env-reads` 钉住 Pi 1.0 用到的全部 `PI_*` 名字：Pi 升级增删任何一个都会失败，要求在这里归类。

参考了 OMP（oh-my-pi）的做法：OMP 把 `OMP_*` 镜像成 `PI_*`（`OMP_` 优先），但继续把用户的 `PI_*` 当后备；MMP 不留后备（硬规则 1），也不整体按前缀镜像（`MMP_HOME` 之类 MMP 自己的变量不该变成 `PI_HOME`），只认下表列出的名字。

| Pi 的变量 | MMP 的处理 | 说明 |
|---|---|---|
| `PI_OFFLINE` | `MMP_OFFLINE` | 关掉启动时的联网（模型目录刷新、`mmp install` 的来源检查、更新检查、`/changelog`）。设成任何值都算关掉联网（`MMP_OFFLINE=0` 也是），用 `1`：值原样交给 Pi，Pi 和 MMP 的多数读取处只看变量有没有设置，只有少数认 `1`/`true`/`yes`。`--offline` 照旧 |
| `PI_CODING_AGENT_SESSION_DIR` | `MMP_SESSION_DIR` | 会话目录（§2 参数表） |
| `PI_TELEMETRY` | `MMP_TELEMETRY` | 覆盖 `enableInstallTelemetry` 设置；MMP 里影响的是发给 OpenRouter 等 provider 的归属请求头（`core/provider-attribution.js`） |
| `PI_CACHE_RETENTION` | `MMP_CACHE_RETENTION` | `long` 时请求 provider 的长缓存（pi-ai 的各 API 实现） |
| `PI_OAUTH_CALLBACK_HOST` | `MMP_OAUTH_CALLBACK_HOST` | `/login`、`mmp auth` 的 OAuth 回调监听地址（容器、WSL 里用）；Pi 在模块加载时读 |
| `PI_HYPERLINKS`、`PI_IMAGE_PROTOCOL`、`PI_TRUE_COLOR` | `MMP_HYPERLINKS`、`MMP_IMAGE_PROTOCOL`、`MMP_TRUE_COLOR` | 覆盖 pi-tui 对终端能力的探测（OSC 8 链接、内联图片、真彩色） |
| `PI_TUI_ESC_TIMEOUT` | `MMP_TUI_ESC_TIMEOUT` | 单独一个 ESC 等多久才算 Escape 键（毫秒；SSH 下默认 100） |
| `PI_CODING_AGENT_DIR` | MMP 自己设 | 固定是 `<MMP_HOME>/pi`。启动时就设好：Pi 的 `utils/tools-manager.js` 在模块加载时定下自管 fd/rg 的目录（`<agentDir>/bin`），以前那时 MMP 还没设，于是用的是 `~/.pi/agent/bin`（或用户自己的 `PI_CODING_AGENT_DIR`）。`MMP_HOME` 不合法时不设，运行在报这个错时就停下，`--help`/`--version` 照常 |
| `PI_SKIP_VERSION_CHECK` | MMP 自己设 | 始终为 `1`：Pi 的更新提示让用户跑 `pi update`，更新不了 MMP 锁定的 Pi。MMP 自己的更新检查用 `MMP_DISABLE_UPDATE_CHECK` |
| `PI_PACKAGE_DIR` | 只清掉 | 给 Nix/Guix 指 Pi 的包目录；用户的值指向的是另一份 Pi，会让 MMP 读错 Pi 的 `package.json`（版本号等），Pi 在模块加载时读 |
| `PI_SHARE_VIEWER_URL` | 只清掉 | Pi 的 `/share` 预览页；MMP 的 `/share` 直接给 gist 链接，用不到 |
| `PI_RADIUS_GATEWAY` | 只清掉 | 只用于 Pi 自己 `/bug` 的上传；MMP 的 `/bug` 是开 GitHub issue |
| `PI_HARDWARE_CURSOR` | 只清掉 | MMP 用自己的 `show-hardware-cursor` 设置（D21），不调 Pi 读这个变量的 getter |
| `PI_CLEAR_ON_SHRINK`、`PI_EXPERIMENTAL` | 只清掉 | 只在 Pi 自己的交互界面里起作用（底栏的 `xp` 标记、首次运行引导），MMP 的界面不用 |
| `PI_STARTUP_BENCHMARK` | 只清掉 | Pi 交互界面的启动计时；设了它 `-p` 会直接报错退出 |
| `PI_TIMING`、`PI_TUI_DEBUG`、`PI_TUI_DEBUG_REDRAW`、`PI_TUI_WRITE_LOG` | 只清掉 | Pi 自己的调试输出（计时、渲染日志、终端写入日志），不作为 MMP 的选项 |
| `PI_MANAGED_INSTALL_ROOT`、`PI_INSTALLER_API_BASE` | 只清掉 | Pi 自更新和包命令用的；`mmp install/update` 是 MMP 自己的，走不到 |

Pi 代码里出现但不是 Pi 读取的输入，不处理：`PI_CODING_AGENT`（Pi 的 CLI/RPC 入口给子进程设的标记）、`PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`（bash 工具给它跑的命令设的，自己会先删掉继承来的值）、`PI_BUNDLED_NODE`（Pi 编译版的构建期常量，不是环境变量）。另外 pi-ai 在 Bun 下 `process.env` 为空时会去读 `/proc/self/environ`，MMP 跑在 Node 上，走不到。

## 3. 子命令

`mmp update / install / remove / uninstall / list / config / auth / mcp` 都支持 `--help`（和 `-h`）打印各自的用法说明，用 MMP 自己的说法（Manifest 而不是 settings.json），不报错。

| 子命令 | 和 Pi 对齐 | MMP 的做法 |
|---|---|---|
| `mmp update [--self\|--extensions\|--models\|--all] [<source>]` | 参数形式对齐，效果不同 | `--self`（不带参数时的默认）更新 MMP 本身，包括锁定的内核（现在的 `mmp update`）；`--extensions` 清空整个扩展包缓存目录，让 Manifest 里所有声明的扩展包在下次启动时重新拉取；`<source>` 效果和 `--extensions` 完全一样（清空整个缓存，不是只刷新这一个来源）——缓存按来源单独寻址不可行（见 `src/update.ts` `clearExtensionPackageCache` 的注释），`<source>` 只出现在打印的提示里；`--models` 刷新模型目录；`--all` 全部 |
| `mmp install <source> [-l] [--approve\|--no-approve] [--offline]` | 用法对齐 | 把 `npm:` / `git:` / 本地路径写进 `~/.mmp/mmp.json` 的 `extensions`，加 `-l`（或 `--local`，和 Pi 一样）写进项目的 `.mmp/mmp.json`；写入前校验来源真实存在（`npm:` 用 `npm view -- <spec> version`，`git:` 用 `git ls-remote -- <url>`，本地路径检查文件存在；10 秒超时，同 Pi 的 `NETWORK_TIMEOUT_MS`；命令找不到、非零退出都带上 stderr 原文说明原因；来源若以 `-` 开头一律拒绝，防止被当成命令行参数——不复用 Pi 自己的 `DefaultPackageManager.resolveExtensionSources`，因为它在 `PI_OFFLINE` 下会静默跳过缺失的来源，测试没法离线验证；`checkSourceExists` 参数可注入假实现，见 `src/commands/manifest-cli.ts`），校验失败就不写入并说明原因；`--offline` 和 `MMP_OFFLINE` 一样跳过这项检查。`git:` 只接受 Pi 自己的 `parseGitUrl` 会接受的形状（bare `host/path`、`https/http/ssh/git` 协议 URL、`git@host:path` scp 语法，可选 `@ref` 钉住分支/tag/commit——分隔符是 `@` 不是 `#`，和 Pi 的 `splitRef` 一致），结构不对（协议不支持、host/path 太短、`..` 路径段等）直接拒绝，不做网络请求。写入后提示重启生效。`-l` 目标项目未被信任时拒绝写入并打印和 `mmp list` 一样的 "not trusted" 提示，除非带 `--approve`（仅本次生效，不持久化，和 Pi 自己的项目级 package 命令要求一致，见 `package-manager-cli.js`） |
| `mmp remove <source> [-l] [--approve\|--no-approve]`、`mmp uninstall` | 用法对齐 | 从对应 Manifest 删除；`-l`/`--local` 的信任规则和 `install -l` 相同。内置能力（`mmp:task` 等）删掉或本来没写都还是开着，输出会说用 `"disable"` 关；这个文件的 `"disable"` 已经列了它时，改说它已经关了 |
| `mmp list` | 用法对齐 | 列出全局和项目 Manifest 里的扩展、Rules、Skills，标明来自哪个 Manifest；项目未被信任时只打印 "not trusted" 提示，不读取其声明内容；额外打印自动发现的 skill root 及其 provenance（`discovered: agents`/`mmp`/`project`） |
| `mmp config [-l] [--approve\|--no-approve]` | 用途对齐 | 用 `$VISUAL`/`$EDITOR` 打开对应的 `mmp.json`，保存后按 Manifest 规则校验，出错就显示错误并保留原文件；`-l`/`--local` 的信任规则和 `install -l` 相同 |
| `mmp auth print-api-key / print-bearer-token / check` | 是 | 读写 `~/.mmp/pi` 里的凭证 |
| `mmp mcp add\|remove\|list\|login\|logout`（docs/mcp-design.md §6） | 用法对齐 Pi 的 `pi mcp`（`extensions/mcp/cli.js`），不能直接复用：它写死 `.pi/mcp.json` 和 Pi 自己的信任存储 | MMP 自己解析参数；`add`/`remove` 读写 `~/.mmp/mcp.json`，加 `-l` 读写项目的 `.mmp/mcp.json`（信任规则和 `install -l` 相同：`--approve`/`-a` 本次生效，不持久化）；`add` 校验格式后再写（复用 Pi 的 `validateMcpServerConfig`），格式和字段名和 `mcp.json` 完全一致；`list` 真的连接每个已启用服务，报告状态、工具、`toolExposure` 覆盖、资源计数，有配置错误或连接失败退出码为 1，`--json` 输出机读格式；一个服务都没配置时打印 MMP 自己的提示（`~/.mmp/mcp.json`、`.mmp/mcp.json`、`mmp mcp add`），不是 Pi 的 `.pi/mcp.json`；`login`/`logout` 只对 HTTP/OAuth 服务有效，stdio 服务直接报错；凭据在 `<MMP_HOME>/pi/mcp-auth.json`（Pi 默认位置，`getAgentDir()` 已被重定向）。永远走 `src/host.ts` 的子命令表，不会落到 `piMain` |

## 4. 斜杠命令

以 [tui-design.md](tui-design.md) 4.6 节为准。按本文的定位，原来"不做"的命令调整如下：

| 命令 | MMP 的做法 |
|---|---|
| `/share` | 和 Pi 一样分享会话 |
| `/changelog` | 显示 MMP 的发行说明（GitHub releases，和更新检查用同一个接口） |
| `/bug` | 不上报给 Pi 的开发者，改成给 MMP 的 GitHub 仓库开 issue：先征得同意，附上版本号和可选的会话摘要，打开预填好的 issue 页面 |
| `/trust` | 已完成，只作用于 `.mmp/mmp.json`（决策 T2） |
