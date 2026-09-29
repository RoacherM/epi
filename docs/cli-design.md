# MMP 命令行接口设计

状态：2026-09-29 与用户确认（决策 M5、M6，见 [decisions.md](decisions.md)）。

## 0. 定位

MMP 是**改名叫 mmp 的定制版 Pi**：

- 功能优先对齐官方 Pi（锁定版本 0.87.1）。Pi 有的命令行参数、子命令、斜杠命令，MMP 原则上都提供。
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

MMP 自己维护这份清单。清单外的参数一律报错退出，不再原样交给 Pi。`mmp --help` 只打印 MMP 自己的帮助文本，覆盖下表所有参数，不再附上 Pi 的帮助。

| 参数 | 和 Pi 对齐 | 说明 |
|---|---|---|
| `--provider`、`--model`、`--thinking`、`--api-key`、`--models` | 是 | |
| `-c/--continue`、`-r/--resume`、`--session`、`--session-id`、`--fork`、`--session-dir`、`--no-session`、`-n/--name` | 是 | `--session-dir` 和 Pi 一样展开 `~`，并读取 `PI_SESSION_DIR` 和设置里的 `sessionDir` |
| `-t/--tools`、`-xt/--exclude-tools`、`-nt/--no-tools`、`-nbt/--no-builtin-tools` | 是 | |
| `-p/--print`、`--mode text/json/rpc` | 是 | benchmark 的标准入口 `mmp --mode json --no-session --no-approve -p "…"`（DEVELOPMENT.md 第 20 节）保持不变 |
| `--list-models [search]`、`--export <file>` | 是 | |
| `--offline`、`--verbose` | 是 | `--verbose` 让启动信息显示在消息区 |
| 初始消息、`@文件` | 是 | |
| `--approve/-a`、`--no-approve/-na` | 名字对齐，作用不同 | 只作用于项目的 `.mmp/mmp.json`，从不交给 Pi（DEVELOPMENT.md 8.2） |
| `--no-project`、`--dry-run` | MMP 独有 | |
| `-h/--help`、`-v/--version` | 是 | `--version` 打印 MMP 版本和锁定的内核版本 |
| `--use-theme`、`--tui-mode` | **不提供** | 界面已换成 grok 风格：只有全屏，主题由 MMP 管 |
| `-e/--extension`、`--skill`、`--prompt-template`、`--theme`、`--system-prompt`、`--append-system-prompt`、`--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-themes`、`--no-context-files` | **不提供** | 资源只由 Manifest 声明；传入时报错并提示改 Manifest |

## 3. 子命令

| 子命令 | 和 Pi 对齐 | MMP 的做法 |
|---|---|---|
| `mmp update [--self\|--extensions\|--models\|--all] [<source>]` | 参数形式对齐 | `--self`（不带参数时的默认）更新 MMP 本身，包括锁定的内核（现在的 `mmp update`）；`--extensions` 或 `<source>` 更新 Manifest 里的扩展包；`--models` 刷新模型目录；`--all` 全部 |
| `mmp install <source> [-l]` | 用法对齐 | 把 `npm:` / `git:` / 本地路径写进 `~/.mmp/mmp.json` 的 `extensions`，加 `-l` 写进项目的 `.mmp/mmp.json`；写入前校验来源，写入后提示重启生效 |
| `mmp remove <source> [-l]`、`mmp uninstall` | 用法对齐 | 从对应 Manifest 删除 |
| `mmp list` | 用法对齐 | 列出全局和项目 Manifest 里的扩展、Rules、Skills，标明来自哪个 Manifest |
| `mmp config [-l]` | 用途对齐 | 用 `$VISUAL`/`$EDITOR` 打开对应的 `mmp.json`，保存后按 Manifest 规则校验，出错就显示错误并保留原文件 |
| `mmp auth print-api-key / print-bearer-token / check` | 是 | 读写 `~/.mmp/pi` 里的凭证 |

## 4. 斜杠命令

以 [tui-design.md](tui-design.md) 4.6 节为准。按本文的定位，原来"不做"的命令调整如下：

| 命令 | MMP 的做法 |
|---|---|
| `/share` | 和 Pi 一样分享会话 |
| `/changelog` | 显示 MMP 的发行说明（GitHub releases，和更新检查用同一个接口） |
| `/bug` | 不上报给 Pi 的开发者，改成给 MMP 的 GitHub 仓库开 issue：先征得同意，附上版本号和可选的会话摘要，打开预填好的 issue 页面 |
| `/trust` | 已完成，只作用于 `.mmp/mmp.json`（决策 T2） |
