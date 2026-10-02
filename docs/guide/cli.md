# 命令行参考

[← 文档索引](README.md)

## 常用命令

```bash
# 查看 MMP 与固定 Pi 的完整参数
mmp --help

# 只解析并校验配置，不启动 Pi
mmp --dry-run

# 非交互运行
mmp --model openai/gpt-4o-mini --no-session --print "Reply exactly: MMP_OK"

# 启动 MMP 自己的交互界面
mmp --model openai/gpt-4o-mini
```

## 交互界面

`mmp` 唯一的交互入口是它自己按 grok-build 设计写的第 4 层界面（设计见 [docs/tui-design.md](../tui-design.md)），不再启动 Pi 自带的经典交互界面。全屏布局、MMP 启动页、`/login`、`/logout`、`/model`、`/new`、`/resume`、`/compact`、`/reload`、`/trust`、对话和流式输出、工具调用、`!` bash、`--verbose` 启动提示、`@file` 首条消息、Esc 中止、Ctrl+C / Ctrl+D 退出、扩展的对话框和面板（`select`、`custom` 等）均已支持；未接线的内置命令在补全里标 `(not yet)`，输入后会提示尚未支持。`--help` 和 `--list-models` 也由 MMP 自己实现；`--print`、`--mode json/rpc`、`--export` 和其余非 TTY 运行仍使用内部 Pi CLI；`mmp update/install/remove/uninstall/list/config/auth` 是 MMP 自己的子命令（见 [子命令](#子命令)）。

交互启动时，MMP 启动页会直接显示 `MMP on Pi` 身份、Manifest 状态、核心 JSON 配置方法和 `/mmp`、`/login` 等入口。每次 Agent 运行还会把同一份 runtime identity 注入模型上下文：当前 `MMP_HOME`/`agentDir`、Manifest 来源以及实际加载的 Rules、Skills 和 Extensions 都可核验；上游 Pi 文档中的 ambient 资源目录不会被误认为当前能力。

## 参数

`mmp --help` 打印 MMP 自己维护的完整参数表（`src/args.ts` 的 `MMP_FLAG_TABLE`，同一张表驱动解析、校验和帮助文本），不附带任何其他命令行的帮助。已声明 Extension 通过 `pi.registerFlag` 注册的长参数也受支持，并列在帮助的 `Extension options` 中；无人注册的长参数在扩展加载后报错，未知短参数直接报错。资源加载参数仍受下面的 Manifest 限制。

MMP 自有、和 Pi 行为不同的参数：

| 参数 | 行为 |
|---|---|
| `--dry-run` | 校验完整装配并输出无 secret 的 JSON；不启动 |
| `--no-project` | 完全禁用项目 `.mmp` 发现 |
| `-a, --approve` | 本次运行信任最近的项目 `.mmp/mmp.json`。只作用于 MMP；不授予 Pi 项目配置权限；非交互启动的已知限制见 [配置 · 和 Pi 的隔离](configuration.md#和-pi-的隔离) |
| `-na, --no-approve` | 本次运行忽略项目配置 |
| `-v, --version` | 输出 MMP 与固定内核版本 |
| `-h, --help` | 只打印 MMP 自己的帮助 |

其余模型、Session、工具、输出参数（`--provider`、`--model`、`--thinking`、`-c/--continue`、`--session*`、`-p/--print`、`--mode`、`--list-models`、`--export`、`--offline`、`--verbose` 等）和 Pi 对齐，参数名和取值语义不变。`--verbose` 在交互界面里把启动信息（已加载的 Rules/Skills/Extensions 数量、当前模型、当前 Session）显示成对话区提示；非交互模式行为和 Pi 一致。`@file` 参数：文本文件原文内联进第一条消息，图片文件会读取为图片附件并附在首条消息中（同时保留路径提示），文件不存在会报错退出。`--session-dir` 没给时依次看 `MMP_SESSION_DIR` 环境变量、`~/.mmp/pi/settings.json` 里的 `sessionDir`（和 Pi 的 `--session-dir`/`PI_CODING_AGENT_SESSION_DIR`/`sessionDir` 顺序一致，只是变量名换成 MMP 自己的——Pi 装置里设置的 `PI_CODING_AGENT_SESSION_DIR` 不会被读取，不会跟 MMP 共享）。其他环境变量同理：Pi 的 `PI_*` 变量（`PI_OFFLINE` 等）对 mmp 不起作用，需要时改用同名的 `MMP_*`（`MMP_OFFLINE`、`MMP_TELEMETRY`、`MMP_CACHE_RETENTION`、`MMP_OAUTH_CALLBACK_HOST`、`MMP_HYPERLINKS`、`MMP_IMAGE_PROTOCOL`、`MMP_TRUE_COLOR`、`MMP_TUI_ESC_TIMEOUT`），完整清单见 [docs/cli-design.md](../cli-design.md) §2.1。

以下参数**不提供**：`--use-theme`、`--tui-mode`（界面已经是 grok 风格的单一全屏主题，由 MMP 管理）；`--extension`/`-e`、`--skill`、`--prompt-template`、`--theme`、`--system-prompt`、`--append-system-prompt` 及其 `--no-*` 形式（Rules/Extensions 只能通过 Manifest 声明；Skills 除 Manifest 声明外还会从固定目录自动发现，见 [配置](configuration.md#manifest)；这些 flag 都不提供，直接传入会报错并提示改用 `mmp install`/编辑 Manifest）。

如需隔离配置，设置绝对路径：

```bash
MMP_HOME=/absolute/path/to/mmp-home mmp --dry-run
```

## 子命令

```bash
mmp update [--self|--extensions|--models|--all] [<source>]      # 更新 mmp 本身/扩展包缓存/模型目录
mmp install <source> [-l] [--approve|--no-approve]              # 把 npm:/git:/本地路径写进 Manifest 的 extensions
mmp remove <source> [-l] [--approve|--no-approve]               # 从 Manifest 删除
mmp uninstall <source> [-l] [--approve|--no-approve]            # remove 的别名
mmp list                                                        # 列出全局与项目 Manifest 里的 Rules/Skills/Extensions
mmp config [-l] [--approve|--no-approve]                        # 用 $VISUAL/$EDITOR 编辑 Manifest，保存后立即校验
mmp auth print-api-key|print-bearer-token|check                # 打印或检查 provider 凭证（读写 ~/.mmp/pi，不读 ~/.pi/agent）
mmp mcp add|remove|list|login|logout                            # 配置、检查 MCP 服务，OAuth 登录/登出
```

`-l`（或 `--local`）把 `install`/`remove`/`config` 的目标从全局 `~/.mmp/mmp.json` 换成当前目录的 `.mmp/mmp.json`；目标项目未被信任时三者都会拒绝，报同一句 "not trusted" 提示，除非带 `--approve`（仅本次生效，和 Pi 自己的项目级 package 命令一样，见 `package-manager-cli.js`）。`mmp install` 写入前会校验来源是否真实存在：`npm:` 用 `npm view <spec> version` 确认包（和版本）能解析，`git:` 用 `git ls-remote` 确认仓库可达（10 秒超时；命令缺失或返回非零都会带上原始报错说明原因；`--offline` 和 `MMP_OFFLINE` 一样跳过这项检查），本地路径确认文件存在；`git:` 只接受 Pi 自己会接受的形状（host/path、显式协议 URL、scp 语法，可选 `@ref`），校验失败不写入，并说明原因。写入后需要重启 `mmp` 才生效；扩展包本身不会被预先下载进 `.pi/` 或 Pi 的 `settings.json`——它们和其它 Manifest 声明的 Extension 一样，在下次 `mmp` 启动时按 `--extension npm:x`/`git:x` 的方式加载，缓存在 `~/.mmp/pi/tmp/extensions` 下；`mmp update --extensions` 清空这份缓存，让声明的来源在下次启动时重新拉取。`mmp config` 的编辑结果如果校验失败，会保留编辑前的文件内容并报错。

## 升级

安装、升级（`mmp update`）和 npm 安装见 [安装与升级](install.md)。
