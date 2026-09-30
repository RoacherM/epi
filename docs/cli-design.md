# MMP 命令行接口设计

状态：2026-09-29 与用户确认（决策 M5、M6，见 [decisions.md](decisions.md)）。

## 0. 定位

MMP 是**改名叫 mmp 的定制版 Pi**：

- 功能优先对齐官方 Pi（锁定版本见 `package.json`）。Pi 有的命令行参数、子命令、斜杠命令，MMP 原则上都提供。
- 交互界面换成 grok-build 风格（[tui-design.md](tui-design.md)）。
- 对外只有 mmp：帮助、报错、文档里只出现 mmp 的名字和参数，不出现 `pi` 命令，也不说"透传给 Pi"。底层可以继续调用 Pi 的实现。
- 只在两种情况下和 Pi 不同，并在本文写明理由：
  1. 和 grok 界面冲突；
  2. 和 MMP 的核心约定冲突：资源只由 Manifest 声明；配置不和 Pi 共享（`~/.mmp/pi`，不读 `~/.pi/agent` 和项目 `.pi/`）。

## 1. 入口

只有一个入口：`mmp`。

| 运行方式 | 走哪条路 |
|---|---|
| 交互（stdin、stdout 都是终端，且没有 `-p`、`--mode`、`--help`、`--list-models`、`--export`） | MMP 自己的界面（`src/tui/`） |
| 非交互：`-p`、`--mode json`、`--mode rpc`、`--list-models`、`--export`、非终端 | 底层用 Pi 的实现（`piMain`），对外参数和帮助是 MMP 的 |
| 子命令：`mmp update / install / remove / uninstall / list / config / auth` | MMP 自己的子命令（第 3 节） |

## 2. 参数清单

MMP 自己维护这份清单。清单外的短参数（`-x`）一律报错退出。清单外的长参数（`--foo`）不会立刻报错：和 Pi 自己的 `parseArgs`（`unknownFlags`）一样先原样保留，交给两条路径各自的运行时（`-p` 等非交互走 `piMain`；MMP 自己的界面走 `src/tui/services.ts`）在扩展加载完之后核对——某个已加载的扩展用 `pi.registerFlag` 声明过这个参数就接受，否则在启动界面前按参数名报错退出（Pi 的 `agent-session-services.js` `applyExtensionFlagValues`）。`mmp --help` 打印 MMP 自己的帮助文本，覆盖下表所有参数，不附上 Pi 的帮助；如果 Manifest 里的扩展注册了参数，额外打印一段"Extension options"（和 Pi 自己的 `--help` 一样，为此会先加载一遍扩展——只加载扩展，不建会话/连模型；加载失败就跳过这一段，`--help` 本身始终成功）。

| 参数 | 和 Pi 对齐 | 说明 |
|---|---|---|
| `--provider`、`--model`、`--thinking`、`--api-key`、`--models` | 是 | |
| `-c/--continue`、`-r/--resume`、`--session`、`--session-id`、`--fork`、`--session-dir`、`--no-session`、`-n/--name` | 是 | `--session-dir` 和 Pi 一样展开 `~`；没给时依次看 `MMP_SESSION_DIR`（MMP 自己的变量，语义和 Pi 的 `PI_CODING_AGENT_SESSION_DIR` 一样，但从不读取后者——Pi 装置设置的这个变量不会泄漏进 MMP）、设置里的 `sessionDir`。两条运行路径（`piMain` 和 `src/tui/services.ts`）用同一份解析结果：非交互路径调用 Pi 前会清掉进程里的 `PI_CODING_AGENT_SESSION_DIR`，再按 `MMP_SESSION_DIR` 重新赋值 |
| `-t/--tools`、`-xt/--exclude-tools`、`-nt/--no-tools`、`-nbt/--no-builtin-tools` | 是 | |
| `-p/--print`、`--mode text/json/rpc` | 是 | benchmark 的标准入口 `mmp --mode json --no-session --no-approve -p "…"`（DEVELOPMENT.md 第 20 节）保持不变 |
| `--list-models [search]`、`--export <file>` | 是 | |
| `--offline`、`--verbose` | 是 | `--verbose` 让启动信息显示在消息区 |
| 初始消息、`@文件` | 是 | |
| `--approve/-a`、`--no-approve/-na` | 名字对齐，作用不同 | 只作用于项目的 `.mmp/mmp.json`，从不交给 Pi（DEVELOPMENT.md 8.2） |
| `--no-project`、`--dry-run` | MMP 独有 | |
| `-h/--help`、`-v/--version` | 是 | `--version` 打印 MMP 版本和锁定的内核版本 |
| `--use-theme`、`--tui-mode` | **不提供** | 界面已换成 grok 风格：只有全屏，主题由 MMP 管 |
| `-e/--extension`、`--skill`、`--prompt-template`、`--theme`、`--system-prompt`、`--append-system-prompt`、`--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-themes`、`--no-context-files` | **不提供** | 资源不能通过这些 flag 传入；传入时报错并提示改 Manifest。Skills 除 Manifest 声明外还会从三个固定目录自动发现（docs/decisions.md S1，README "Manifest"），同样不经过这些 flag |

## 3. 子命令

`mmp update / install / remove / uninstall / list / config / auth` 都支持 `--help`（和 `-h`）打印各自的用法说明，用 MMP 自己的说法（Manifest 而不是 settings.json），不报错。

| 子命令 | 和 Pi 对齐 | MMP 的做法 |
|---|---|---|
| `mmp update [--self\|--extensions\|--models\|--all] [<source>]` | 参数形式对齐，效果不同 | `--self`（不带参数时的默认）更新 MMP 本身，包括锁定的内核（现在的 `mmp update`）；`--extensions` 清空整个扩展包缓存目录，让 Manifest 里所有声明的扩展包在下次启动时重新拉取；`<source>` 效果和 `--extensions` 完全一样（清空整个缓存，不是只刷新这一个来源）——缓存按来源单独寻址不可行（见 `src/update.ts` `clearExtensionPackageCache` 的注释），`<source>` 只出现在打印的提示里；`--models` 刷新模型目录；`--all` 全部 |
| `mmp install <source> [-l] [--approve\|--no-approve] [--offline]` | 用法对齐 | 把 `npm:` / `git:` / 本地路径写进 `~/.mmp/mmp.json` 的 `extensions`，加 `-l` 写进项目的 `.mmp/mmp.json`；写入前校验来源真实存在（`npm:` 用 `npm view -- <spec> version`，`git:` 用 `git ls-remote -- <url>`，本地路径检查文件存在；10 秒超时，同 Pi 的 `NETWORK_TIMEOUT_MS`；命令找不到、非零退出都带上 stderr 原文说明原因；来源若以 `-` 开头一律拒绝，防止被当成命令行参数——不复用 Pi 自己的 `DefaultPackageManager.resolveExtensionSources`，因为它在 `PI_OFFLINE` 下会静默跳过缺失的来源，测试没法离线验证；`checkSourceExists` 参数可注入假实现，见 `src/commands/manifest-cli.ts`），校验失败就不写入并说明原因；`--offline` 和 `PI_OFFLINE` 一样跳过这项检查。`git:` 只接受 Pi 自己的 `parseGitUrl` 会接受的形状（bare `host/path`、`https/http/ssh/git` 协议 URL、`git@host:path` scp 语法，可选 `@ref` 钉住分支/tag/commit——分隔符是 `@` 不是 `#`，和 Pi 的 `splitRef` 一致），结构不对（协议不支持、host/path 太短、`..` 路径段等）直接拒绝，不做网络请求。写入后提示重启生效。`-l` 目标项目未被信任时拒绝写入并打印和 `mmp list` 一样的 "not trusted" 提示，除非带 `--approve`（仅本次生效，不持久化，和 Pi 自己的项目级 package 命令要求一致，见 `package-manager-cli.js`） |
| `mmp remove <source> [-l] [--approve\|--no-approve]`、`mmp uninstall` | 用法对齐 | 从对应 Manifest 删除；`-l` 的信任规则和 `install -l` 相同 |
| `mmp list` | 用法对齐 | 列出全局和项目 Manifest 里的扩展、Rules、Skills，标明来自哪个 Manifest；项目未被信任时只打印 "not trusted" 提示，不读取其声明内容；额外打印自动发现的 skill root 及其 provenance（`discovered: agents`/`mmp`/`project`） |
| `mmp config [-l] [--approve\|--no-approve]` | 用途对齐 | 用 `$VISUAL`/`$EDITOR` 打开对应的 `mmp.json`，保存后按 Manifest 规则校验，出错就显示错误并保留原文件；`-l` 的信任规则和 `install -l` 相同 |
| `mmp auth print-api-key / print-bearer-token / check` | 是 | 读写 `~/.mmp/pi` 里的凭证 |

## 4. 斜杠命令

以 [tui-design.md](tui-design.md) 4.6 节为准。按本文的定位，原来"不做"的命令调整如下：

| 命令 | MMP 的做法 |
|---|---|
| `/share` | 和 Pi 一样分享会话 |
| `/changelog` | 显示 MMP 的发行说明（GitHub releases，和更新检查用同一个接口） |
| `/bug` | 不上报给 Pi 的开发者，改成给 MMP 的 GitHub 仓库开 issue：先征得同意，附上版本号和可选的会话摘要，打开预填好的 issue 页面 |
| `/trust` | 已完成，只作用于 `.mmp/mmp.json`（决策 T2） |
